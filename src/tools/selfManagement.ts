import { z } from "zod";
import type { Ctx } from "../context.js";

// Ein Agent darf nur sich selbst umbenennen/beschreiben oder sein eigenes
// Gedächtnis schreiben — nie beliebige Zeilen. agent_id kommt als Parameter,
// weil dieser MCP-Server (anders als eine zukünftige Erweiterung) keine
// Bindung "dieser Aufruf gehört zu Agent X" kennt; validiert wird stattdessen
// wie überall sonst hier über die Organisation, nicht per Vertrauen auf den
// Parameter — derselbe Maßstab wie bei jeder verlinkten Entity-ID
// (create_task etc.). Die eigene agent_id steht dem Agenten im fixen
// System-Prompt zur Verfügung (siehe SELF_DEFINING_AGENT_SYSTEM_PROMPT in
// der CRM-App).
//
// System agents (is_system — among them the CRM Assistant behind the
// project chat) may write their memory but not rename themselves. The memory
// half used to share the is_system = false filter, so every remember call of
// a system agent answered "not found" although its prompt told it to use it.
async function assertOwnOrgAgent(ctx: Ctx, agentId: string, opts: { allowSystem: boolean }): Promise<void> {
  let q = ctx.db
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("organization_id", ctx.orgId);
  if (!opts.allowSystem) q = q.eq("is_system", false);
  const { data, error } = await q.maybeSingle();
  if (error || !data) throw new Error(`Agent ${agentId} not found in your organization.`);
}

export const updateAgentProfileSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id, from your system prompt"),
  name: z.string().min(1).max(80).optional().describe("New display name"),
  color: z.enum(["gold", "orange", "coral", "pink", "purple", "lime", "green", "teal", "cyan", "blue"]).optional(),
  description: z.string().max(200).optional().describe("One-line description shown on your card in the CRM"),
});

export async function updateAgentProfile(ctx: Ctx, args: z.infer<typeof updateAgentProfileSchema>) {
  await assertOwnOrgAgent(ctx, args.agent_id, { allowSystem: false });
  const fields: Record<string, string> = {};
  if (args.name !== undefined) fields.name = args.name;
  if (args.color !== undefined) fields.color = args.color;
  if (args.description !== undefined) fields.description = args.description;
  if (Object.keys(fields).length === 0) throw new Error("Nothing to update — pass name, color, and/or description.");

  const { error } = await ctx.db.from("agents").update(fields).eq("id", args.agent_id);
  if (error) throw new Error(`Could not update profile: ${error.message}`);
  return { success: true, updated: Object.keys(fields) };
}

export const rememberSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id, from your system prompt"),
  memory: z.string().max(8000).describe(
    "The FULL replacement for your memory document — not an append. Include everything that still " +
    "matters: what your job is, patterns you've learned for doing it, " +
    "routines you've set up and why. Facts about the user go to remember_about_user and facts about one " +
    "project to remember_for_project — every agent sees those, only you see this. This is re-read on every single message you receive, so keep it curated, not a raw log."
  ),
});

export async function remember(ctx: Ctx, args: z.infer<typeof rememberSchema>) {
  await assertOwnOrgAgent(ctx, args.agent_id, { allowSystem: true });
  const { error } = await ctx.db.from("agents").update({ memory: args.memory }).eq("id", args.agent_id);
  if (error) throw new Error(`Could not save memory: ${error.message}`);
  return { success: true, length: args.memory.length };
}

// ── remember_about_user ─────────────────────────────────────────────────────
// What holds for the calling user across every project and every agent —
// how they work, rules they gave, preferences. Keyed to the user, not to an
// agent: agents.memory is seen by that one agent only, so a rule told to the
// CRM Assistant was unknown to Claude on claude.ai. Shown in every project
// briefing under "Memory" and in every in-app chat turn. The row is the
// caller's own (RLS user_id = auth.uid()), never anyone else's.
export const rememberAboutUserSchema = z.object({
  memory: z.string().max(4000).describe(
    "The FULL replacement for what you know about the user — not an append. Short bullet points of what holds " +
    "beyond a single project: how they work, rules they gave you, preferences, corrections of your mistakes. " +
    "Keep what still holds, drop what is outdated, don't duplicate. Empty string clears it."
  ),
});

export async function rememberAboutUser(ctx: Ctx, args: z.infer<typeof rememberAboutUserSchema>) {
  const memory = args.memory.trim();
  const { error } = await ctx.db
    .from("user_agent_memory")
    .upsert({ user_id: ctx.userId, memory, updated_at: new Date().toISOString() }, { onConflict: "user_id" });
  if (error) throw new Error(`Could not save memory: ${error.message}`);
  return { success: true, length: memory.length };
}
