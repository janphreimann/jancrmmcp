import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { berlinToIso, nextDay } from "../berlinTime.js";
import { orTerm } from "./queryHelpers.js";

// Calendar events live on an external CalDAV server (GMX/iCloud/…); the
// `calendar_events` table is only a sync mirror. Creating an event therefore
// means a CalDAV PUT first, then upserting the mirror row so the event shows
// up in the CRM immediately instead of waiting for the next sync-calendar run.
// The iCal/CalDAV logic mirrors the webapp's write-calendar edge function
// (../private-janreimanncrm/supabase/functions/write-calendar). Seit der Server unter
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

// Where CalDAV credentials may go: https on the same site (last two labels)
// as the account — iCloud redirects caldav.icloud.com → pNN-caldav.icloud.com.
// calendar_url comes from rows the user can write, so without this the Basic
// credentials went wherever that URL (or a redirect) pointed.
function caldavSite(u: string): string | null {
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return null;
    return url.hostname.toLowerCase().split(".").slice(-2).join(".");
  } catch {
    return null;
  }
}

function sameCaldavSite(a: string, b: string): boolean {
  const sa = caldavSite(a);
  return sa !== null && sa === caldavSite(b);
}

// ── CalDAV request with manual redirect handling ─────────────────────────────

async function caldavPut(url: string, auth: string, ical: string): Promise<{ status: number; text: string }> {
  let currentUrl = url;
  if (!caldavSite(url)) return { status: 0, text: "calendar URL must be https" };
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
      if (!sameCaldavSite(url, currentUrl)) return { status: 0, text: "redirect to another site refused" };
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
  // trotzdem explizit da — die Abfrage soll nicht davon abhängen, dass die
  // Datenbank nur einen Nutzer kennt (CLAUDE.md, Einzelnutzer-Betrieb).
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

  // No fallback to accounts[0]: a calendar on another server would get its password.
  const account = accounts.find((a) => sameCaldavSite(a.url, calendar.url));
  if (!account) throw new Error("No CalDAV account in the CRM matches this calendar.");
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
    throw new Error(`CalDAV PUT failed: HTTP ${resp.status}${resp.status === 0 ? ` — ${resp.text}` : ""}`);
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

// ─── list_calendar_events ───────────────────────────────────────────────────
// Reads the mirror (calendar_events), bound to the user: RLS filters on
// auth.uid() and the query on ctx.userId explicitly (CLAUDE.md). Recurring
// events are stored once, as their first occurrence with the RRULE — the
// mirror does not expand them, so a series that started before the range is
// returned with `recurring: true` and its rule.

/** Longest range list_calendar_events reads at once, in days. */
export const CALENDAR_RANGE_MAX_DAYS = 92;

export const listCalendarEventsSchema = z.object({
  from: z.string().describe("Start of the range: YYYY-MM-DD (Berlin) or ISO timestamp"),
  to: z.string().describe(`End of the range, inclusive day: YYYY-MM-DD (Berlin) or ISO timestamp; at most ${CALENDAR_RANGE_MAX_DAYS} days after from`),
  search: z.string().max(200).optional().describe("Text in title, description or location"),
  limit: z.number().int().min(1).max(100).default(50),
});

function rangeBound(value: string, edge: "from" | "to"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return berlinToIso(edge === "from" ? value : nextDay(value));
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`"${value}" is not a date (YYYY-MM-DD) or ISO timestamp.`);
  return new Date(t).toISOString();
}

/** The validated, half-open [from, to) range of a list_calendar_events call. */
export function calendarRange(args: { from: string; to: string }): { from: string; to: string } {
  const from = rangeBound(args.from, "from");
  const to = rangeBound(args.to, "to");
  if (Date.parse(to) <= Date.parse(from)) throw new Error("`to` must be after `from`.");
  if (Date.parse(to) - Date.parse(from) > CALENDAR_RANGE_MAX_DAYS * 86_400_000) {
    throw new Error(`Range too long — at most ${CALENDAR_RANGE_MAX_DAYS} days per call.`);
  }
  return { from, to };
}

/**
 * The one or() filter of list_calendar_events: events overlapping [from, to),
 * plus recurring series that started before `to` (their occurrences are not
 * stored) — and, with a search term (stripped by orTerm), a text match in
 * title, description or location. One filter string instead of two or()
 * calls, so the AND between them is explicit.
 */
export function calendarFilter(range: { from: string; to: string }, term: string): string {
  const overlap = `or(and(start_at.lt.${range.to},end_at.gt.${range.from}),and(rrule.not.is.null,start_at.lt.${range.to}))`;
  if (!term) return overlap.slice(3, -1);
  return `and(${overlap},or(summary.ilike.%${term}%,description.ilike.%${term}%,location.ilike.%${term}%))`;
}

export async function listCalendarEvents(ctx: Ctx, args: z.infer<typeof listCalendarEventsSchema>) {
  const range = calendarRange(args);
  const q = ctx.db
    .from("calendar_events")
    .select("id, summary, description, location, start_at, end_at, all_day, calendar_name, status, rrule")
    .eq("user_id", ctx.userId)
    .or(calendarFilter(range, args.search ? orTerm(args.search) : ""))
    .order("start_at", { ascending: true })
    .limit(args.limit ?? 50);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map((e) => ({
    id: e.id,
    title: e.summary,
    start_at: e.start_at,
    end_at: e.end_at,
    ...(e.all_day ? { all_day: true } : {}),
    ...(e.location ? { location: e.location } : {}),
    ...(e.description ? { description: e.description.length > 300 ? `${e.description.slice(0, 300)}…` : e.description } : {}),
    calendar: e.calendar_name,
    ...(e.status && e.status !== "confirmed" ? { status: e.status } : {}),
    ...(e.rrule ? { recurring: true, rrule: e.rrule } : {}),
  }));
}
