import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";

// Calendar events live on an external CalDAV server (GMX/iCloud/…); the
// `calendar_events` table is only a sync mirror. Creating an event therefore
// means a CalDAV PUT first, then upserting the mirror row so the event shows
// up in the CRM immediately instead of waiting for the next sync-calendar run.
// The iCal/CalDAV logic mirrors the webapp's write-calendar edge function
// (../janreimanncrm/supabase/functions/write-calendar). Seit der Server unter
// dem JWT des Nutzers spricht, wäre ein Aufruf dieser Funktion möglich — die
// Verdopplung bleibt vorerst, bis jemand sie zusammenlegt.

export const createCalendarEventSchema = z.object({
  title: z.string().min(1).describe("Event title"),
  start_at: z.string().describe(
    "Start as ISO 8601 with timezone offset, e.g. 2026-07-20T14:00:00+02:00 (offset required unless all_day)"
  ),
  end_at: z.string().optional().nullable().describe(
    "End as ISO 8601 with offset. Defaults to 1 hour after start. For all-day events: exclusive end date (day after the last day), defaults to a single-day event."
  ),
  all_day: z.boolean().default(false),
  description: z.string().optional().nullable(),
  location: z.string().optional().nullable(),
  calendar_name: z.string().optional().nullable().describe(
    "Target calendar name — omit when only one calendar is configured; on a mismatch the error lists the available calendars"
  ),
});

// ── iCal generation (kept byte-compatible with write-calendar) ───────────────

function pad(n: number) { return String(n).padStart(2, "0"); }

function toIcalUtc(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function toIcalDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

function escIcal(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/,/g, "\\,").replace(/;/g, "\\;").replace(/\n/g, "\\n");
}

function generateUid(): string {
  const rand = Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10);
  return `${Date.now()}-${rand}@varacrm`;
}

interface IcalEvent {
  summary: string;
  start_at: string;
  end_at: string;
  all_day: boolean;
  description?: string | null;
  location?: string | null;
}

function buildICal(uid: string, ev: IcalEvent): string {
  const now = toIcalUtc(new Date().toISOString());
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    "PRODID:-//VaraCRM//VaraCRM//EN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `CREATED:${now}`,
    `LAST-MODIFIED:${now}`,
  ];

  if (ev.all_day) {
    lines.push(`DTSTART;VALUE=DATE:${toIcalDate(ev.start_at)}`);
    lines.push(`DTEND;VALUE=DATE:${toIcalDate(ev.end_at)}`);
  } else {
    lines.push(`DTSTART:${toIcalUtc(ev.start_at)}`);
    lines.push(`DTEND:${toIcalUtc(ev.end_at)}`);
  }

  lines.push(`SUMMARY:${escIcal(ev.summary)}`);
  if (ev.description) lines.push(`DESCRIPTION:${escIcal(ev.description)}`);
  if (ev.location)    lines.push(`LOCATION:${escIcal(ev.location)}`);

  lines.push("END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

// ── CalDAV request with manual redirect handling ─────────────────────────────

async function caldavPut(url: string, auth: string, ical: string): Promise<{ status: number; text: string }> {
  let currentUrl = url;
  for (let i = 0; i < 5; i++) {
    const resp = await fetch(currentUrl, {
      method: "PUT",
      headers: {
        "Authorization": `Basic ${auth}`,
        "Content-Type": "text/calendar; charset=utf-8",
        // Prevents overwriting an existing event if the generated UID collides
        "If-None-Match": "*",
      },
      body: ical,
      redirect: "manual",
    });
    if ([301, 302, 307, 308].includes(resp.status)) {
      const loc = resp.headers.get("location");
      if (!loc) break;
      currentUrl = loc.startsWith("http") ? loc : new URL(loc, currentUrl).href;
      continue;
    }
    return { status: resp.status, text: await resp.text() };
  }
  return { status: 0, text: "Too many redirects" };
}

// ── Tool ─────────────────────────────────────────────────────────────────────

const HAS_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

export async function createCalendarEvent(ctx: Ctx, args: z.infer<typeof createCalendarEventSchema>) {
  if (!args.all_day && !HAS_OFFSET.test(args.start_at)) {
    throw new Error(
      `start_at must include a timezone offset (e.g. 2026-07-20T14:00:00+02:00), got "${args.start_at}". ` +
      `Without one the time would silently be interpreted in the server's timezone, not the user's.`
    );
  }
  if (!args.all_day && args.end_at && !HAS_OFFSET.test(args.end_at)) {
    throw new Error(`end_at must include a timezone offset, got "${args.end_at}".`);
  }

  const start = new Date(args.start_at);
  if (isNaN(start.getTime())) throw new Error(`Invalid start_at: "${args.start_at}"`);

  let end: Date;
  if (args.end_at) {
    end = new Date(args.end_at);
    if (isNaN(end.getTime())) throw new Error(`Invalid end_at: "${args.end_at}"`);
  } else {
    end = new Date(start.getTime() + (args.all_day ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000));
  }
  if (end.getTime() <= start.getTime()) {
    throw new Error("end_at must be after start_at");
  }

  // Resolve the target calendar from the synced events (same source the
  // webapp's calendar selector uses — there is no dedicated calendars table).
  // Nur die Kalender des Aufrufers: calendar_events hängt am Nutzer, nicht an
  // der Organisation, und filtert per RLS auf auth.uid(). Der Filter steht
  // trotzdem explizit da — ein Termin im Kalender eines Kollegen wäre auch
  // innerhalb einer Organisation falsch.
  const { data: calRows, error: calErr } = await ctx.db
    .from("calendar_events")
    .select("calendar_name, calendar_url")
    .eq("user_id", ctx.userId)
    .order("calendar_name");
  if (calErr) throw new Error(calErr.message);

  const calendars = new Map<string, { name: string; url: string }>();
  for (const r of calRows ?? []) {
    if (!calendars.has(r.calendar_name)) {
      calendars.set(r.calendar_name, { name: r.calendar_name, url: r.calendar_url });
    }
  }
  if (calendars.size === 0) {
    throw new Error(
      "No calendars found. Connect a CalDAV account in the CRM settings and run a calendar sync first."
    );
  }

  let calendar: { name: string; url: string };
  if (args.calendar_name) {
    const wanted = args.calendar_name.trim().toLowerCase();
    const match = [...calendars.values()].find((c) => c.name.toLowerCase() === wanted);
    if (!match) {
      throw new Error(
        `Calendar "${args.calendar_name}" not found. Available calendars: ${[...calendars.keys()].join(", ")}`
      );
    }
    calendar = match;
  } else if (calendars.size === 1) {
    calendar = [...calendars.values()][0];
  } else {
    throw new Error(
      `Multiple calendars available — pass calendar_name. Options: ${[...calendars.keys()].join(", ")}`
    );
  }

  // CalDAV credentials: pick the account whose base URL owns the calendar.
  //
  // Passwörter liegen seit 20260729_encrypt_caldav_passwords verschlüsselt;
  // die Klartextspalte `password` ist geleert. Gelesen wird deshalb über
  // get_caldav_accounts (SECURITY DEFINER, service_role) — dieselbe RPC, die
  // auch die write-calendar Edge Function benutzt. Ein direktes SELECT auf die
  // Tabelle liefert ein leeres Passwort und scheitert bei der Authentifizierung.
  // Einzige Stelle mit service_role: die RPC ist für `authenticated` gesperrt,
  // weil sie das entschlüsselte Passwort liefert. Der Parameter ist deshalb
  // fest ctx.userId — nie etwas, das aus den Argumenten stammt.
  const { data: acctData, error: acctErr } = await ctx.admin
    .rpc("get_caldav_accounts", { p_user_id: ctx.userId });
  if (acctErr) throw new Error(acctErr.message);
  const accounts = (acctData ?? []) as Array<{ user_id: string; url: string; username: string; password: string }>;
  if (!accounts.length) throw new Error("No CalDAV account configured in the CRM.");

  const account = accounts.find((a) => calendar.url.startsWith(a.url.replace(/\/$/, ""))) ?? accounts[0];
  const auth = Buffer.from(`${account.username}:${account.password}`).toString("base64");

  const uid = generateUid();
  const event: IcalEvent = {
    summary: args.title,
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    all_day: args.all_day,
    description: args.description ?? null,
    location: args.location ?? null,
  };
  const ical = buildICal(uid, event);

  const base = calendar.url.endsWith("/") ? calendar.url : calendar.url + "/";
  const resp = await caldavPut(`${base}${uid}.ics`, auth, ical);
  if (resp.status < 200 || resp.status > 299) {
    throw new Error(`CalDAV PUT failed: HTTP ${resp.status} — ${resp.text.slice(0, 200)}`);
  }

  // Mirror the event into calendar_events so it appears in the CRM instantly.
  // If this fails the event still exists on the CalDAV server and the next
  // sync will pick it up — but then without the created_by_agent flag, so we
  // surface the error instead of swallowing it.
  const { data, error } = await ctx.db
    .from("calendar_events")
    .upsert(
      {
        user_id: ctx.userId,
        event_uid: uid,
        calendar_url: calendar.url,
        calendar_name: calendar.name,
        summary: args.title,
        description: args.description ?? null,
        location: args.location ?? null,
        start_at: event.start_at,
        end_at: event.end_at,
        all_day: args.all_day,
        rrule: null,
        status: null,
        raw_ical: ical,
        updated_at: new Date().toISOString(),
        ...agentMeta(),
      },
      { onConflict: "user_id,event_uid,calendar_url" },
    )
    .select("id")
    .single();
  if (error) {
    throw new Error(
      `Event was created on the CalDAV server (uid ${uid}) but mirroring it into the CRM failed: ${error.message}`
    );
  }

  return {
    id: data.id,
    event_uid: uid,
    calendar: calendar.name,
    start_at: event.start_at,
    end_at: event.end_at,
    message: `Event "${args.title}" created in calendar "${calendar.name}"`,
  };
}
