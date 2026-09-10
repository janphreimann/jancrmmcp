import { z } from "zod";
import type { Ctx } from "../context.js";

async function assertOwnOrgAgent(ctx: Ctx, agentId: string): Promise<void> {
  const { data, error } = await ctx.db
    .from("agents")
    .select("id")
    .eq("id", agentId)
    .eq("organization_id", ctx.orgId)
    .eq("is_system", false)
    .maybeSingle();
  if (error || !data) throw new Error(`Agent ${agentId} not found in your organization.`);
}

// Exactly the fields agent_triggers already has (see
// supabase/migrations/20261028001300_agent_triggers.sql in the CRM repo) —
// this tool is a thin, self-service front door onto the same table a human
// already edits by hand in AgentFormPanel. organization_id, last_fired_at
// etc. are set by the database (default + trigger from agent_id), never by
// this tool.
export const scheduleRoutineSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id, from your system prompt"),
  name: z.string().min(1).describe("A short, descriptive name for this routine, chosen by you (e.g. \"Daily inbox screen\") — shown in the UI, never left blank"),
  interval_minutes: z.number().int().positive().optional().describe("Fire every N minutes"),
  schedule_hour: z.number().int().min(0).max(23).optional().describe("Fire daily at this hour (local time)"),
  schedule_minute: z.number().int().min(0).max(59).optional().describe("Minute of the hour, default 0"),
  schedule_weekday: z.number().int().min(0).max(6).optional().describe("0=Sunday..6=Saturday, omit for every day"),
  prompt_template: z.string().min(1).describe("The exact message you will receive as if the user just sent it, when this fires — the literal instruction you'll act on, not a description of the routine"),
  max_runs_per_day: z.number().int().positive().nullable().optional().describe("Optional safety cap on runs/day. Omit or pass null for unlimited (the default)."),
});

export async function scheduleRoutine(ctx: Ctx, args: z.infer<typeof scheduleRoutineSchema>) {
  if (args.interval_minutes == null && args.schedule_hour == null && args.schedule_minute == null) {
    throw new Error("Provide interval_minutes, or schedule_hour/schedule_minute for a fixed daily time.");
  }
  await assertOwnOrgAgent(ctx, args.agent_id);
  const { data, error } = await ctx.db
    .from("agent_triggers")
    .insert({
      agent_id: args.agent_id,
      created_by: ctx.userId,
      kind: "schedule",
      name: args.name,
      interval_minutes: args.interval_minutes ?? null,
      schedule_hour: args.schedule_hour ?? null,
      schedule_minute: args.schedule_minute ?? 0,
      schedule_weekday: args.schedule_weekday ?? null,
      prompt_template: args.prompt_template,
      max_runs_per_day: args.max_runs_per_day ?? null,
    })
    .select("id")
    .single();
  if (error) throw new Error(`Could not schedule routine: ${error.message}`);
  return { success: true, routine_id: data.id };
}

export const updateRoutineSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id"),
  routine_id: z.string().uuid(),
  name: z.string().min(1).optional().describe("Rename the routine"),
  interval_minutes: z.number().int().positive().nullable().optional(),
  schedule_hour: z.number().int().min(0).max(23).nullable().optional(),
  schedule_minute: z.number().int().min(0).max(59).nullable().optional(),
  schedule_weekday: z.number().int().min(0).max(6).nullable().optional(),
  prompt_template: z.string().min(1).optional(),
  enabled: z.boolean().optional().describe("Set false to pause without deleting"),
  max_runs_per_day: z.number().int().positive().nullable().optional().describe("Optional safety cap on runs/day. Pass null to remove the cap (unlimited)."),
});

export async function updateRoutine(ctx: Ctx, args: z.infer<typeof updateRoutineSchema>) {
  await assertOwnOrgAgent(ctx, args.agent_id);
  const { routine_id, agent_id, ...rest } = args;
  const fields = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  if (Object.keys(fields).length === 0) throw new Error("Nothing to update.");
  const { data, error } = await ctx.db
    .from("agent_triggers")
    .update(fields)
    .eq("id", routine_id)
    .eq("agent_id", agent_id)
    .select("id");
  if (error) throw new Error(`Could not update routine: ${error.message}`);
  if (!data?.length) throw new Error(`Routine ${routine_id} not found on this agent.`);
  return { success: true };
}

export const cancelRoutineSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id"),
  routine_id: z.string().uuid(),
});

export async function cancelRoutine(ctx: Ctx, args: z.infer<typeof cancelRoutineSchema>) {
  await assertOwnOrgAgent(ctx, args.agent_id);
  const { data, error } = await ctx.db
    .from("agent_triggers")
    .delete()
    .eq("id", args.routine_id)
    .eq("agent_id", args.agent_id)
    .select("id");
  if (error) throw new Error(`Could not cancel routine: ${error.message}`);
  if (!data?.length) throw new Error(`Routine ${args.routine_id} not found on this agent.`);
  return { success: true };
}
