import {
  groupSessionsByRecordingGroup,
  transcriptSnippet,
  resolveSegmentSpeakers,
  renderTranscript,
  pageTranscript,
  TRANSCRIPT_PAGE_DEFAULT_CHARS,
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

test("returns null for a whitespace-only transcript", () => {
  assert(transcriptSnippet("   \n  ") === null, "Expected null");
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

console.log("\n=== renderTranscript / pageTranscript ===");

test("renders one 'Name: text' paragraph per segment", () => {
  const rendered = renderTranscript(
    resolveSegmentSpeakers([{ speaker: 0, text: " Hallo " }, { speaker: 1, text: "Hi" }], { "0": { name: "Jan", contact_id: null } }),
    "ignored"
  );
  assert(rendered === "Jan: Hallo\n\nSpeaker 2: Hi", `Got ${JSON.stringify(rendered)}`);
});

test("falls back to the plain transcript without segments", () => {
  assert(renderTranscript([], "  plain  ") === "plain", "Expected trimmed plain transcript");
  assert(renderTranscript([], null) === "", "Expected empty string");
});

test("a short transcript is one page with next_offset null", () => {
  const page = pageTranscript("A: x\n\nB: y", 0, TRANSCRIPT_PAGE_DEFAULT_CHARS);
  assert(page.text === "A: x\n\nB: y" && page.next_offset === null && page.total_chars === 10, JSON.stringify(page));
});

test("walking next_offset covers every paragraph exactly once and cuts only at breaks", () => {
  const paragraphs = Array.from({ length: 500 }, (_, i) => `Speaker ${i % 3}: Absatz ${i} ` + "wort ".repeat(40).trim());
  const full = paragraphs.join("\n\n");
  const seen: string[] = [];
  let offset: number | null = 0;
  let pages = 0;
  while (offset !== null) {
    const page = pageTranscript(full, offset, 5_000);
    assert(page.text.length <= 5_000, `Page too long: ${page.text.length}`);
    seen.push(...page.text.split("\n\n"));
    offset = page.next_offset;
    if (++pages > 1000) throw new Error("No progress");
  }
  assert(pages > 1, "Expected several pages");
  assert(seen.length === paragraphs.length, `Expected ${paragraphs.length} paragraphs, got ${seen.length}`);
  assert(seen.every((p, i) => p === paragraphs[i]), "Paragraphs split, lost or duplicated");
});

test("hard-cuts a window without whitespace and still makes progress", () => {
  const full = "x".repeat(2_500);
  const first = pageTranscript(full, 0, 1_000);
  assert(first.text.length === 1_000 && first.next_offset === 1_000, JSON.stringify({ len: first.text.length, next: first.next_offset }));
});

test("an offset past the end yields an empty last page", () => {
  const page = pageTranscript("abc", 99, 1_000);
  assert(page.text === "" && page.offset === 3 && page.next_offset === null, JSON.stringify(page));
});

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll tests passed ✓");
}
