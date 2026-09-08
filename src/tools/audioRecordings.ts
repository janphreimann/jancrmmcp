import { z } from "zod";
import type { Ctx } from "../context.js";
import {
  groupSessionsByRecordingGroup,
  transcriptSnippet,
  resolveSegmentSpeakers,
  type AudioRecordingRow,
} from "./audioRecordingHelpers.js";

// search_audio_recordings never reads segments/speaker_labels (it only returns
// a transcript_snippet), so it selects a smaller column list to avoid pulling
// full per-segment jsonb for every matching row.
const AUDIO_RECORDING_SEARCH_COLUMNS =
  "id, recording_group_id, source, title, duration_seconds, transcript, transcription_status, summary, created_at";

// get_audio_recording resolves speaker names from segments/speaker_labels, so
// it needs the full column list.
const AUDIO_RECORDING_DETAIL_COLUMNS =
  "id, recording_group_id, source, title, duration_seconds, transcript, transcription_status, segments, speaker_labels, summary, created_at";

function endOfDayIfDateOnly(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999` : value;
}

// Escapes characters meaningful to PostgREST's filter-string syntax ("
// closes a quoted pattern, \ is its escape char) before interpolating
// user-supplied text into an ilike pattern. The % and _ LIKE wildcards are
// intentionally left untouched.
function escapeIlikePattern(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

async function resolveAllowedGroupIds(
  ctx: Ctx,
  contactId: string | undefined,
  companyId: string | undefined
): Promise<Set<string> | undefined> {
  if (!contactId && !companyId) return undefined;

  let contactGroups: Set<string> | undefined;
  if (contactId) {
    const { data, error } = await ctx.db
      .from("audio_recording_contacts")
      .select("recording_group_id")
      .eq("contact_id", contactId);
    if (error) throw new Error(error.message);
    contactGroups = new Set((data ?? []).map((r) => r.recording_group_id as string));
  }

  let companyGroups: Set<string> | undefined;
  if (companyId) {
    const { data, error } = await ctx.db
      .from("audio_recording_companies")
      .select("recording_group_id")
      .eq("company_id", companyId);
    if (error) throw new Error(error.message);
    companyGroups = new Set((data ?? []).map((r) => r.recording_group_id as string));
  }

  if (contactGroups && companyGroups) {
    return new Set([...contactGroups].filter((id) => companyGroups!.has(id)));
  }
  return contactGroups ?? companyGroups;
}

/**
 * Contacts/companies discussed during a session, keyed by recording_group_id
 * — mirrors fetchAudioRecordingContacts() in the webapp
 * (src/modules/audioRecordings/api.ts).
 */
async function attachContactsAndCompanies(ctx: Ctx, groupIds: string[]) {
  const contactsByGroup = new Map<string, { id: string; first_name: string; last_name: string }[]>();
  const companiesByGroup = new Map<string, { id: string; name: string }[]>();
  if (groupIds.length === 0) return { contactsByGroup, companiesByGroup };

  const [{ data: contactRows, error: contactErr }, { data: companyRows, error: companyErr }] = await Promise.all([
    ctx.db
      .from("audio_recording_contacts")
      .select("recording_group_id, contacts:contact_id ( id, first_name, last_name )")
      .in("recording_group_id", groupIds),
    ctx.db
      .from("audio_recording_companies")
      .select("recording_group_id, companies:company_id ( id, name )")
      .in("recording_group_id", groupIds),
  ]);
  if (contactErr) throw new Error(contactErr.message);
  if (companyErr) throw new Error(companyErr.message);

  for (const row of (contactRows ?? []) as any[]) {
    if (!row.contacts) continue;
    const list = contactsByGroup.get(row.recording_group_id) ?? [];
    list.push(row.contacts);
    contactsByGroup.set(row.recording_group_id, list);
  }
  for (const row of (companyRows ?? []) as any[]) {
    if (!row.companies) continue;
    const list = companiesByGroup.get(row.recording_group_id) ?? [];
    list.push(row.companies);
    companiesByGroup.set(row.recording_group_id, list);
  }
  return { contactsByGroup, companiesByGroup };
}

const transcriptSegmentSchema = z.object({
  speaker: z.number().int().min(0).describe("0-indexed speaker index, must match the segment it replaces"),
  text: z.string().describe("Cleaned text for this segment"),
});

export const updateAudioRecordingTranscriptSchema = z.object({
  id: z.string().uuid().describe("audio_recordings row UUID (from the triggering message)"),
  segments: z.array(transcriptSegmentSchema).min(1).describe(
    "Complete cleaned segments array — same length, order and speaker index as the segments you were given, only text may change"
  ),
});

export async function updateAudioRecordingTranscript(ctx: Ctx, args: z.infer<typeof updateAudioRecordingTranscriptSchema>) {
  // Nutzergebundene Tabelle (wie calendar_events/caldav_accounts): RLS allein
  // reicht laut CLAUDE.md nicht, zusätzlich explizit auf ctx.userId filtern.
  const { data: existing, error: fetchErr } = await ctx.db
    .from("audio_recordings")
    .select("id, segments")
    .eq("id", args.id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!existing) throw new Error(`Audio recording ${args.id} not found`);

  const existingSegments = Array.isArray(existing.segments) ? existing.segments : null;
  const existingCount = existingSegments ? existingSegments.length : null;
  if (existingCount !== null && existingCount !== args.segments.length) {
    throw new Error(
      `Segment count mismatch: recording has ${existingCount} segments, got ${args.segments.length}. ` +
        "Cleanup must not add, remove, or merge segments — only edit each segment's text."
    );
  }

  if (existingSegments) {
    for (let i = 0; i < args.segments.length; i++) {
      const existingSpeaker = (existingSegments[i] as any)?.speaker;
      if (existingSpeaker !== undefined && existingSpeaker !== args.segments[i].speaker) {
        throw new Error(
          `Speaker index mismatch at segment ${i}: expected speaker ${existingSpeaker}, got ${args.segments[i].speaker}. ` +
            "Cleanup must not reorder or renumber segments — only edit each segment's text."
        );
      }
    }
  }

  const transcript = args.segments.map((s) => `Sprecher ${s.speaker + 1}: ${s.text}`).join("\n\n").trim();

  const { data, error } = await ctx.db
    .from("audio_recordings")
    .update({ segments: args.segments, transcript })
    .eq("id", args.id)
    .eq("user_id", ctx.userId)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`Audio recording ${args.id} not found`);

  return { id: args.id, message: "Transcript cleaned" };
}

export const searchAudioRecordingsSchema = z.object({
  contact_id: z.string().uuid().optional().describe("Filter to recording sessions linked to this contact"),
  company_id: z.string().uuid().optional().describe("Filter to recording sessions linked to this company"),
  query: z.string().optional().describe("Substring match on title, transcript or summary"),
  since: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive lower bound on created_at"),
  until: z.string().optional().describe("ISO date (YYYY-MM-DD), inclusive upper bound on created_at"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchAudioRecordings(ctx: Ctx, args: z.infer<typeof searchAudioRecordingsSchema>) {
  const allowedGroupIds = await resolveAllowedGroupIds(ctx, args.contact_id, args.company_id);
  if (allowedGroupIds && allowedGroupIds.size === 0) return [];

  let q = ctx.db
    .from("audio_recordings")
    .select(AUDIO_RECORDING_SEARCH_COLUMNS)
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false });

  if (allowedGroupIds) q = q.in("recording_group_id", Array.from(allowedGroupIds));
  if (args.query) {
    const pattern = escapeIlikePattern(args.query);
    q = q.or(`title.ilike."%${pattern}%",transcript.ilike."%${pattern}%",summary.ilike."%${pattern}%"`);
  }
  if (args.since) q = q.gte("created_at", args.since);
  if (args.until) q = q.lte("created_at", endOfDayIfDateOnly(args.until));

  // Safety cap on the raw row fetch, applied before grouping — distinct from
  // the post-grouping args.limit slice below. A session can span up to ~3
  // raw rows/tracks (mic, system_audio, combined), so limit * 5 comfortably
  // covers grouping without meaningfully changing behavior for realistic
  // limit values; it's a valve against unbounded pulls, not a user-facing cap.
  q = q.limit(Math.min(args.limit * 5, 500));

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const sessions = groupSessionsByRecordingGroup((data ?? []) as AudioRecordingRow[]).slice(0, args.limit);
  const groupIds = sessions.map((s) => s.recording_group_id);
  const { contactsByGroup, companiesByGroup } = await attachContactsAndCompanies(ctx, groupIds);

  return sessions.map((s) => ({
    recording_group_id: s.recording_group_id,
    title: s.title,
    created_at: s.created_at,
    duration_seconds: s.duration_seconds,
    transcription_status: s.transcription_status,
    summary: s.summary,
    transcript_snippet: transcriptSnippet(s.transcript),
    contacts: contactsByGroup.get(s.recording_group_id) ?? [],
    companies: companiesByGroup.get(s.recording_group_id) ?? [],
  }));
}

export const getAudioRecordingSchema = z.object({
  recording_group_id: z.string().uuid().describe(
    "recording_group_id of the session (from search_audio_recordings)"
  ),
});

export async function getAudioRecording(ctx: Ctx, args: z.infer<typeof getAudioRecordingSchema>) {
  const { data, error } = await ctx.db
    .from("audio_recordings")
    .select(AUDIO_RECORDING_DETAIL_COLUMNS)
    .eq("recording_group_id", args.recording_group_id)
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false });
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`Audio recording session ${args.recording_group_id} not found`);

  const [session] = groupSessionsByRecordingGroup(data as AudioRecordingRow[]);
  const { contactsByGroup, companiesByGroup } = await attachContactsAndCompanies(ctx, [session.recording_group_id]);

  return {
    recording_group_id: session.recording_group_id,
    title: session.title,
    created_at: session.created_at,
    duration_seconds: session.duration_seconds,
    transcription_status: session.transcription_status,
    transcript: session.transcript,
    summary: session.summary,
    segments: resolveSegmentSpeakers(session.segments, session.speaker_labels),
    contacts: contactsByGroup.get(session.recording_group_id) ?? [],
    companies: companiesByGroup.get(session.recording_group_id) ?? [],
  };
}
