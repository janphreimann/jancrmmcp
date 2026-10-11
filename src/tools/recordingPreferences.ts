import { z } from "zod";
import type { Ctx } from "../context.js";

// How recordings and uploaded transcripts are processed (cleanup, summary,
// task suggestions) is a fixed pipeline in the desktop app, not an agent.
// Its prompts have two halves: the reply format, fixed in code, and the
// user's own wishes per step, which this tool writes. Per user, in
// agent_prompt_overrides (RLS: user_id = auth.uid()); the app reads them
// fresh on every run, so a change applies from the next recording.

const KEY = { cleanup: "recording_pref_cleanup", summary: "recording_pref_summary", tasks: "recording_pref_tasks" } as const;

export const setRecordingPreferenceSchema = z.object({
  step: z.enum(["cleanup", "summary", "tasks"]).describe("cleanup = tidying the raw transcript; summary = the summary text; tasks = which task suggestions are made"),
  preference: z.string().max(2000).describe("The complete new wish text for this step — merge with the current text (shown in your overview), don't drop earlier wishes. Empty string resets the step to its defaults."),
}).strict();

export async function setRecordingPreference(ctx: Ctx, args: z.infer<typeof setRecordingPreferenceSchema>) {
  const key = KEY[args.step];
  const { data: before, error: readErr } = await ctx.db
    .from("agent_prompt_overrides").select("value").eq("user_id", ctx.userId).eq("key", key).maybeSingle();
  if (readErr) throw new Error(readErr.message);

  const text = args.preference.trim();
  if (text) {
    const { error } = await ctx.db
      .from("agent_prompt_overrides")
      .upsert({ user_id: ctx.userId, key, value: text, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
    if (error) throw new Error(error.message);
  } else {
    const { error } = await ctx.db.from("agent_prompt_overrides").delete().eq("user_id", ctx.userId).eq("key", key);
    if (error) throw new Error(error.message);
  }
  return {
    step: args.step,
    previous: (before as { value?: string } | null)?.value ?? null,
    preference: text || null,
    message: text ? "Saved — applies from the next recording or uploaded transcript." : "Reset to defaults.",
  };
}
