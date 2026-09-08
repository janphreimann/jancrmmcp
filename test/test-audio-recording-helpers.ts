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
