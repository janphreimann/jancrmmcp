# Audio Transcript & Summary Search — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent find and read a contact's/company's linked call/meeting transcripts and summaries through the MCP server (e.g. "Worum ging es im letzten Telefonat mit Frau Bubmann"), without exposing the underlying audio files.

**Architecture:** Two new read-only MCP tools (`search_audio_recordings`, `get_audio_recording`) built on the existing `audio_recordings` table and its `audio_recording_contacts`/`audio_recording_companies` join tables — no schema change needed. Session-grouping and speaker-name-resolution logic is pure and unit-tested in a new helper module. `list_documents` gets three new optional filters plus a `doc_type` field so project-scoped transcript documents (the second, project-bound transcript source) are also findable.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk`, `zod`, `@supabase/supabase-js`. No new dependencies. Tests run with `tsx` (no test framework configured in this repo — see `test/test-mail-draft.ts` for the existing assert-based pattern).

**Spec:** `docs/superpowers/specs/2026-09-08-audio-transcript-search-design.md`

## Global Constraints

- No DB migration — every column and join table already exists.
- Never return `storage_path`, a signed URL, or `mime_type` for an audio recording — MCP callers get transcript/summary text only, never the audio file.
- `audio_recordings` is user-bound (like `calendar_events`): every query filters explicitly on `.eq("user_id", ctx.userId)` in addition to RLS.
- Follow the existing `search_x` / `get_x` naming and shape convention (see `src/tools/tasks.ts`).
- `search_audio_recordings` returns `[]` on no match; `get_audio_recording` throws a "not found" error on no match (matches existing `get_x` tools).

---

### Task 1: Pure session-grouping and speaker-resolution helpers

**Files:**
- Create: `src/tools/audioRecordingHelpers.ts`
- Create: `test/test-audio-recording-helpers.ts`

**Interfaces:**
- Produces (consumed by Task 2 and Task 3):
  - `interface TranscriptSegment { speaker: number; text: string }`
  - `interface SpeakerLabel { name: string; contact_id: string | null }`
  - `type SpeakerLabels = Record<string, SpeakerLabel>`
  - `interface AudioRecordingRow { id: string; recording_group_id: string; source: string; title: string | null; duration_seconds: number | null; transcript: string | null; transcription_status: string; segments: TranscriptSegment[] | null; speaker_labels: SpeakerLabels; summary: string | null; created_at: string }`
  - `interface AudioRecordingSession { recording_group_id: string; title: string | null; created_at: string; duration_seconds: number | null; transcription_status: string; transcript: string | null; summary: string | null; segments: TranscriptSegment[] | null; speaker_labels: SpeakerLabels }`
  - `function groupSessionsByRecordingGroup(rows: AudioRecordingRow[]): AudioRecordingSession[]`
  - `function transcriptSnippet(transcript: string | null, maxLen?: number): string | null`
  - `interface ResolvedSegment { speaker: number; speaker_name: string; contact_id: string | null; text: string }`
  - `function resolveSegmentSpeakers(segments: TranscriptSegment[] | null, speakerLabels: SpeakerLabels): ResolvedSegment[]`

- [ ] **Step 1: Write the failing tests**

Create `test/test-audio-recording-helpers.ts`:

```ts
import {
  groupSessionsByRecordingGroup,
  transcriptSnippet,
  resolveSegmentSpeakers,
  type AudioRecordingRow,
} from "../src/tools/audioRecordingHelpers.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function row(overrides: Partial<AudioRecordingRow>): AudioRecordingRow {
  return {
    id: overrides.id ?? "row-1",
    recording_group_id: overrides.recording_group_id ?? "group-1",
    source: overrides.source ?? "microphone",
    title: overrides.title ?? null,
    duration_seconds: overrides.duration_seconds ?? null,
    transcript: overrides.transcript ?? null,
    transcription_status: overrides.transcription_status ?? "done",
    segments: overrides.segments ?? null,
    speaker_labels: overrides.speaker_labels ?? {},
    summary: overrides.summary ?? null,
    created_at: overrides.created_at ?? "2026-01-01T10:00:00Z",
  };
}

console.log("\n=== groupSessionsByRecordingGroup ===");

test("prefers the combined track over microphone/system_audio tracks", () => {
  const rows = [
    row({ id: "a", recording_group_id: "g1", source: "microphone", transcript: "mic only" }),
    row({ id: "b", recording_group_id: "g1", source: "combined", transcript: "combined transcript" }),
  ];
  const sessions = groupSessionsByRecordingGroup(rows);
  assert(sessions.length === 1, `Expected 1 session, got ${sessions.length}`);
  assert(sessions[0].transcript === "combined transcript", `Expected combined transcript, got ${sessions[0].transcript}`);
});

test("falls back to the first row when no combined track exists", () => {
  const rows = [
    row({ id: "a", recording_group_id: "g1", source: "microphone", transcript: "first" }),
    row({ id: "b", recording_group_id: "g1", source: "system_audio", transcript: "second" }),
  ];
  const sessions = groupSessionsByRecordingGroup(rows);
  assert(sessions[0].transcript === "first", `Expected first row's transcript, got ${sessions[0].transcript}`);
});

test("sorts sessions by created_at descending", () => {
  const rows = [
    row({ id: "a", recording_group_id: "g1", created_at: "2026-01-01T10:00:00Z" }),
    row({ id: "b", recording_group_id: "g2", created_at: "2026-02-01T10:00:00Z" }),
  ];
  const sessions = groupSessionsByRecordingGroup(rows);
  assert(sessions[0].recording_group_id === "g2", "Expected newest session first");
  assert(sessions[1].recording_group_id === "g1", "Expected oldest session last");
});

console.log("\n=== transcriptSnippet ===");

test("returns null for null transcript", () => {
  assert(transcriptSnippet(null) === null, "Expected null");
});

test("returns the full transcript when under the limit", () => {
  assert(transcriptSnippet("short text", 300) === "short text", "Expected unchanged text");
});

test("truncates long transcripts with an ellipsis", () => {
  const long = "a".repeat(400);
  const snippet = transcriptSnippet(long, 300);
  assert(snippet !== null && snippet.length === 301, `Expected length 301, got ${snippet?.length}`);
  assert(snippet!.endsWith("…"), "Expected ellipsis suffix");
});

console.log("\n=== resolveSegmentSpeakers ===");

test("resolves a labeled speaker's name and contact_id", () => {
  const resolved = resolveSegmentSpeakers(
    [{ speaker: 0, text: "Hallo" }],
    { "0": { name: "Frau Bubmann", contact_id: "contact-1" } }
  );
  assert(resolved[0].speaker_name === "Frau Bubmann", `Expected "Frau Bubmann", got ${resolved[0].speaker_name}`);
  assert(resolved[0].contact_id === "contact-1", `Expected contact-1, got ${resolved[0].contact_id}`);
});

test("falls back to 'Speaker N' (1-indexed) for an unlabeled speaker", () => {
  const resolved = resolveSegmentSpeakers([{ speaker: 1, text: "Hi" }], {});
  assert(resolved[0].speaker_name === "Speaker 2", `Expected "Speaker 2", got ${resolved[0].speaker_name}`);
  assert(resolved[0].contact_id === null, "Expected null contact_id");
});

test("returns an empty array for null segments", () => {
  assert(resolveSegmentSpeakers(null, {}).length === 0, "Expected empty array");
});

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll tests passed ✓");
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx tsx test/test-audio-recording-helpers.ts`
Expected: fails to even start — `Cannot find module '../src/tools/audioRecordingHelpers.js'` (the module doesn't exist yet).

- [ ] **Step 3: Implement the helper module**

Create `src/tools/audioRecordingHelpers.ts`:

```ts
export interface TranscriptSegment {
  speaker: number;
  text: string;
}

export interface SpeakerLabel {
  name: string;
  contact_id: string | null;
}

export type SpeakerLabels = Record<string, SpeakerLabel>;

export interface AudioRecordingRow {
  id: string;
  recording_group_id: string;
  source: string;
  title: string | null;
  duration_seconds: number | null;
  transcript: string | null;
  transcription_status: string;
  segments: TranscriptSegment[] | null;
  speaker_labels: SpeakerLabels;
  summary: string | null;
  created_at: string;
}

export interface AudioRecordingSession {
  recording_group_id: string;
  title: string | null;
  created_at: string;
  duration_seconds: number | null;
  transcription_status: string;
  transcript: string | null;
  summary: string | null;
  segments: TranscriptSegment[] | null;
  speaker_labels: SpeakerLabels;
}

/**
 * Prefers the "combined" track's row, falls back to the first row (input
 * order) — mirrors groupAudioRecordings() in the webapp
 * (src/modules/audioRecordings/api.ts).
 */
function pickPrimaryTrack(rows: AudioRecordingRow[]): AudioRecordingRow {
  return rows.find((r) => r.source === "combined") ?? rows[0];
}

export function groupSessionsByRecordingGroup(rows: AudioRecordingRow[]): AudioRecordingSession[] {
  const byGroup = new Map<string, AudioRecordingRow[]>();
  for (const row of rows) {
    const list = byGroup.get(row.recording_group_id) ?? [];
    list.push(row);
    byGroup.set(row.recording_group_id, list);
  }

  return Array.from(byGroup.values())
    .map((group) => {
      const primary = pickPrimaryTrack(group);
      return {
        recording_group_id: primary.recording_group_id,
        title: primary.title,
        created_at: primary.created_at,
        duration_seconds: primary.duration_seconds,
        transcription_status: primary.transcription_status,
        transcript: primary.transcript,
        summary: primary.summary,
        segments: primary.segments,
        speaker_labels: primary.speaker_labels,
      };
    })
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
}

export function transcriptSnippet(transcript: string | null, maxLen = 300): string | null {
  if (!transcript) return null;
  const trimmed = transcript.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.slice(0, maxLen).trimEnd() + "…";
}

export interface ResolvedSegment {
  speaker: number;
  speaker_name: string;
  contact_id: string | null;
  text: string;
}

/**
 * Mirrors speakerDisplayName() in the webapp
 * (src/modules/audioRecordings/segments.ts): falls back to "Speaker N"
 * (1-indexed) when no label was assigned to that speaker index.
 */
export function resolveSegmentSpeakers(
  segments: TranscriptSegment[] | null,
  speakerLabels: SpeakerLabels
): ResolvedSegment[] {
  if (!segments) return [];
  return segments.map((seg) => {
    const label = speakerLabels[String(seg.speaker)];
    return {
      speaker: seg.speaker,
      speaker_name: label?.name || `Speaker ${seg.speaker + 1}`,
      contact_id: label?.contact_id ?? null,
      text: seg.text,
    };
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx tsx test/test-audio-recording-helpers.ts`
Expected: `Results: 9 passed, 0 failed` / `All tests passed ✓`

- [ ] **Step 5: Commit**

```bash
git add src/tools/audioRecordingHelpers.ts test/test-audio-recording-helpers.ts
git commit -m "$(cat <<'EOF'
feat(audio-recordings): add pure session-grouping and speaker-resolution helpers

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

---

### Task 2: `search_audio_recordings` tool

**Files:**
- Modify: `src/tools/audioRecordings.ts`

**Interfaces:**
- Consumes: `groupSessionsByRecordingGroup`, `transcriptSnippet`, `AudioRecordingRow` from `./audioRecordingHelpers.js` (Task 1); `Ctx` from `../context.js`.
- Produces (consumed by Task 4):
  - `export const searchAudioRecordingsSchema`
  - `export async function searchAudioRecordings(ctx: Ctx, args: z.infer<typeof searchAudioRecordingsSchema>)`
  - Also produces (consumed by Task 3): `AUDIO_RECORDING_COLUMNS` (string constant), `attachContactsAndCompanies(ctx: Ctx, groupIds: string[])`

- [ ] **Step 1: Add the schema, query columns, and shared lookup helper**

Add to the top of `src/tools/audioRecordings.ts`, right after the existing imports:

```ts
import {
  groupSessionsByRecordingGroup,
  transcriptSnippet,
  type AudioRecordingRow,
} from "./audioRecordingHelpers.js";

const AUDIO_RECORDING_COLUMNS =
  "id, recording_group_id, source, title, duration_seconds, transcript, transcription_status, segments, speaker_labels, summary, created_at";

function endOfDayIfDateOnly(value: string): string {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59.999` : value;
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
```

- [ ] **Step 2: Add the tool schema and implementation**

Append to `src/tools/audioRecordings.ts`:

```ts
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
    .select(AUDIO_RECORDING_COLUMNS)
    .eq("user_id", ctx.userId)
    .order("created_at", { ascending: false });

  if (allowedGroupIds) q = q.in("recording_group_id", Array.from(allowedGroupIds));
  if (args.query) {
    q = q.or(`title.ilike.%${args.query}%,transcript.ilike.%${args.query}%,summary.ilike.%${args.query}%`);
  }
  if (args.since) q = q.gte("created_at", args.since);
  if (args.until) q = q.lte("created_at", endOfDayIfDateOnly(args.until));

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
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: exits 0, no TypeScript errors (`search_audio_recordings` isn't wired into `index.ts` yet, so this only checks `audioRecordings.ts` compiles standalone within the project).

- [ ] **Step 4: Commit**

```bash
git add src/tools/audioRecordings.ts
git commit -m "$(cat <<'EOF'
feat(audio-recordings): add search_audio_recordings tool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

---

### Task 3: `get_audio_recording` tool

**Files:**
- Modify: `src/tools/audioRecordings.ts`

**Interfaces:**
- Consumes: `groupSessionsByRecordingGroup`, `resolveSegmentSpeakers`, `AudioRecordingRow` from `./audioRecordingHelpers.js` (Task 1); `AUDIO_RECORDING_COLUMNS`, `attachContactsAndCompanies` (Task 2, same file).
- Produces (consumed by Task 4): `export const getAudioRecordingSchema`, `export async function getAudioRecording(ctx: Ctx, args: z.infer<typeof getAudioRecordingSchema>)`

- [ ] **Step 1: Add `resolveSegmentSpeakers` to the Task 1 import**

Modify the import added in Task 2, Step 1:

```ts
import {
  groupSessionsByRecordingGroup,
  transcriptSnippet,
  resolveSegmentSpeakers,
  type AudioRecordingRow,
} from "./audioRecordingHelpers.js";
```

- [ ] **Step 2: Add the tool schema and implementation**

Append to `src/tools/audioRecordings.ts`:

```ts
export const getAudioRecordingSchema = z.object({
  recording_group_id: z.string().uuid().describe(
    "recording_group_id of the session (from search_audio_recordings)"
  ),
});

export async function getAudioRecording(ctx: Ctx, args: z.infer<typeof getAudioRecordingSchema>) {
  const { data, error } = await ctx.db
    .from("audio_recordings")
    .select(AUDIO_RECORDING_COLUMNS)
    .eq("recording_group_id", args.recording_group_id)
    .eq("user_id", ctx.userId);
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
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/audioRecordings.ts
git commit -m "$(cat <<'EOF'
feat(audio-recordings): add get_audio_recording tool

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

---

### Task 4: Register both tools in the MCP server

**Files:**
- Modify: `src/tools/index.ts`

**Interfaces:**
- Consumes: `searchAudioRecordingsSchema`, `searchAudioRecordings`, `getAudioRecordingSchema`, `getAudioRecording` from `./audioRecordings.js` (Tasks 2 & 3).

- [ ] **Step 1: Extend the existing audioRecordings import**

Modify `src/tools/index.ts:50` (currently `import { updateAudioRecordingTranscriptSchema, updateAudioRecordingTranscript } from "./audioRecordings.js";`):

```ts
import {
  updateAudioRecordingTranscriptSchema, updateAudioRecordingTranscript,
  searchAudioRecordingsSchema, searchAudioRecordings,
  getAudioRecordingSchema, getAudioRecording,
} from "./audioRecordings.js";
```

- [ ] **Step 2: Register the two tools next to `update_audio_recording_transcript`**

In `src/tools/index.ts`, right after the `update_audio_recording_transcript` registration block (the one with description `"Overwrite an audio recording's cleaned transcript segments..."`), add:

```ts
  server.tool(
    "search_audio_recordings",
    "Search call/meeting recording sessions by linked contact, linked company, or a text substring in the title/transcript/summary. Returns transcript summaries and a short transcript snippet per session — never the audio file itself. Use get_audio_recording on a result's recording_group_id for the full transcript.",
    searchAudioRecordingsSchema.shape,
    async (args) => ok(await searchAudioRecordings(ctx, args as Parameters<typeof searchAudioRecordings>[1]))
  );

  server.tool(
    "get_audio_recording",
    "Get the full transcript and summary of one call/meeting recording session (segments with resolved speaker names, linked contacts/companies). Never returns the audio file itself.",
    getAudioRecordingSchema.shape,
    async (args) => ok(await getAudioRecording(ctx, args as Parameters<typeof getAudioRecording>[1]))
  );
```

- [ ] **Step 3: Verify the server builds and both tools are wired**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

Run: `grep -c "search_audio_recordings\|get_audio_recording" dist/tools/index.js`
Expected: `4` (2 tool-name string literals + 2 more from the description text mentioning `get_audio_recording`) — confirms the compiled output contains both registrations. If the count differs, inspect `dist/tools/index.js` directly rather than assuming — the exact count depends on how the description text ended up worded.

- [ ] **Step 4: Commit**

```bash
git add src/tools/index.ts
git commit -m "$(cat <<'EOF'
feat(audio-recordings): register search_audio_recordings and get_audio_recording tools

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

---

### Task 5: Extend `list_documents` with `doc_type`/entity filters

**Files:**
- Modify: `src/tools/documents.ts:56-83` (`listDocumentsSchema` and `listDocuments`)
- Modify: `src/tools/index.ts:254-258` (`list_documents` registration description)

**Interfaces:**
- No new exports — `listDocumentsSchema`/`listDocuments` keep their existing names, only the schema shape and `select(...)` change.

- [ ] **Step 1: Extend the schema**

In `src/tools/documents.ts`, replace the `listDocumentsSchema` definition:

```ts
export const listDocumentsSchema = z.object({
  folder_id: z.string().uuid().optional().nullable().describe(
    "Filter by folder UUID. Pass null to list only root-level documents (no folder). Omit entirely to list all documents."
  ),
  query: z.string().optional().describe("Search in file name or description"),
  doc_type: z.string().optional().describe(
    "Filter by document type, e.g. 'transcript' for project meeting transcripts or 'agent_index' for internal agent indexes"
  ),
  contact_id: z.string().uuid().optional().describe("Filter to documents linked to this contact"),
  company_id: z.string().uuid().optional().describe("Filter to documents linked to this company"),
  project_id: z.string().uuid().optional().describe("Filter to documents linked to this project"),
  limit: z.number().int().min(1).max(100).default(50),
});
```

- [ ] **Step 2: Apply the new filters and include `doc_type` in the select**

In `src/tools/documents.ts`, replace the `listDocuments` function body:

```ts
export async function listDocuments(ctx: Ctx, args: z.infer<typeof listDocumentsSchema>) {
  let q = ctx.db
    .from("documents")
    .select("id, file_name, file_size, description, folder_id, uploaded_at, contact_id, company_id, project_id, doc_type")
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(args.limit);

  if ("folder_id" in args && args.folder_id !== undefined) {
    if (args.folder_id === null) {
      q = q.is("folder_id", null);
    } else {
      q = q.eq("folder_id", args.folder_id);
    }
  }
  if (args.query) {
    q = q.or(`file_name.ilike.%${args.query}%,description.ilike.%${args.query}%`);
  }
  if (args.doc_type) q = q.eq("doc_type", args.doc_type);
  if (args.contact_id) q = q.eq("contact_id", args.contact_id);
  if (args.company_id) q = q.eq("company_id", args.company_id);
  if (args.project_id) q = q.eq("project_id", args.project_id);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}
```

- [ ] **Step 3: Update the tool description in the registration**

In `src/tools/index.ts`, replace the `list_documents` registration's description string:

```ts
  server.tool(
    "list_documents",
    "List documents with optional filters (folder, doc_type, linked contact/company/project) and text search. Omit folder_id to get all, pass null to get root-level only. Use doc_type: 'transcript' to find project meeting transcripts and their auto-generated summaries.",
    listDocumentsSchema.shape,
    async (args) => ok(await listDocuments(ctx, args as Parameters<typeof listDocuments>[1]))
  );
```

- [ ] **Step 4: Verify it compiles**

Run: `npm run build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/documents.ts src/tools/index.ts
git commit -m "$(cat <<'EOF'
feat(documents): add doc_type and entity filters to list_documents

Lets an agent find project-scoped transcript documents (doc_type=
'transcript') and their generated summaries by contact/company/project,
alongside the new audio_recordings-based transcript search.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

---

### Task 6: Full build verification and manual smoke test

**Files:** none (verification only)

- [ ] **Step 1: Run the full build**

Run: `npm run build`
Expected: exits 0, no TypeScript errors anywhere in `src/`.

- [ ] **Step 2: Run the helper unit tests**

Run: `npx tsx test/test-audio-recording-helpers.ts`
Expected: `All tests passed ✓`

- [ ] **Step 3: Manual smoke test against a real MCP session**

This step needs a live user session (RLS-gated — cannot be scripted with the service-role key, and a real user must actually have a recorded, transcribed call linked to a contact to observe a non-empty result). Do it interactively through the deployed MCP server (or `npm run dev` + an MCP inspector/Claude session connected via OAuth):

1. Call `search_contacts` with a real contact's name who has a linked audio recording.
2. Call `search_audio_recordings` with that contact's `id` — confirm the response contains `recording_group_id`, `summary`/`transcript_snippet`, and the `contacts` array includes that contact. Confirm **no** `storage_path`/signed URL/`mime_type` field appears anywhere in the response.
3. Call `get_audio_recording` with the `recording_group_id` from step 2 — confirm the full `transcript` and `segments` (with resolved `speaker_name`) come back, again with no audio-file reference.
4. Call `list_documents` with `doc_type: "transcript"` — confirm any project-uploaded transcript documents appear, each with `doc_type` in the response.

Record the outcome in the PR/commit description rather than as a new file — this is a one-time manual check, not a repeatable automated test.

- [ ] **Step 4: Final commit (only if Step 3 surfaced fixes)**

If the manual smoke test in Step 3 required any code changes, commit them:

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(audio-recordings): address findings from manual smoke test

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_015CkQPVhr4Uowo12omtmPAe
EOF
)"
```

If Step 3 needed no changes, skip this commit — Task 5's commit remains the last one.
