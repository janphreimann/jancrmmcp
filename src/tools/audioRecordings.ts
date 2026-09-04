import { z } from "zod";
import type { Ctx } from "../context.js";

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
