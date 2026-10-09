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
  if (!trimmed) return null;
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

// Claude Code lets at most 25,000 tokens of one MCP result into the model;
// anything larger is parked in a local file that only an agent with
// Read/Bash can open. A 67-minute meeting came to 141 KB and left the Chief
// (MCP tools only) unable to read its own recording. 40,000 characters of
// German transcript stay around 12,000 tokens, well below that line.
export const TRANSCRIPT_PAGE_DEFAULT_CHARS = 40_000;
export const TRANSCRIPT_PAGE_MAX_CHARS = 60_000;

/**
 * One line per segment ("Name: text"), paragraphs between them. Without
 * segments (no diarization) the plain transcript stands in. The output
 * depends only on the stored row, so a character offset into it stays valid
 * from one call to the next.
 */
export function renderTranscript(segments: ResolvedSegment[], transcript: string | null): string {
  if (segments.length > 0) {
    return segments.map((s) => `${s.speaker_name}: ${s.text.trim()}`).join("\n\n");
  }
  return transcript?.trim() ?? "";
}

export interface TranscriptPage {
  text: string;
  offset: number;
  next_offset: number | null;
  total_chars: number;
}

/**
 * Cuts at most maxChars from offset, preferring a paragraph break, then a
 * line break, then a space in the second half of the window — never in the
 * middle of a word unless the window holds no whitespace at all.
 */
export function pageTranscript(full: string, offset: number, maxChars: number): TranscriptPage {
  const start = Math.min(Math.max(0, Math.floor(offset)), full.length);
  let end = Math.min(start + maxChars, full.length);
  if (end < full.length) {
    const window = full.slice(start, end);
    for (const sep of ["\n\n", "\n", " "]) {
      const at = window.lastIndexOf(sep);
      if (at > window.length / 2) {
        end = start + at + sep.length;
        break;
      }
    }
  }
  return {
    text: full.slice(start, end).trim(),
    offset: start,
    next_offset: end < full.length ? end : null,
    total_chars: full.length,
  };
}
