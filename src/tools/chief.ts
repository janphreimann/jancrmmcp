import { z } from "zod";
import type { Ctx } from "../context.js";

// The Chief's overview (CRM migration 20261107000000_chief_agent.sql). The
// function is SECURITY INVOKER and this client carries the caller's token,
// so RLS decides what is in it — system agents, the caller's own agents,
// the caller's organization's projects and tasks.
export const getOverviewSchema = z.object({}).strict();

export async function getOverview(ctx: Ctx, _args: z.infer<typeof getOverviewSchema>) {
  const { data, error } = await ctx.db.rpc("get_chief_overview");
  if (error) throw new Error(`Could not load the overview: ${error.message}`);
  return data;
}

// ── Agent management and delegation (spec §4.4, §4.5, §6) ─────────────────
// The MCP server does not know which agent calls it — every agent runs on the
// user's token. So each tool takes the caller's own agent id and checks it
// is the user's Chief: a small agent cannot play manager by accident. The
// real boundary is still RLS (the user's own rows); these checks are about
// roles inside it.

const CRM_PREFIX = "mcp__jan-crm__";
// Never handed to an agent the Chief creates: the manager's own tools.
const MANAGER_ONLY = new Set(
  ["get_overview", "delegate", "create_agent", "update_agent", "pause_agent", "delete_agent", "update_agent_profile",
    "create_standing_order", "update_standing_order", "create_proposal", "update_proposal_status"]
    .map((n) => CRM_PREFIX + n)
);
const MAX_MANAGED_AGENTS = 20;
const DEFAULT_TEMPORARY_HOURS = 48;

function isWorkerTool(name: string): boolean {
  return /^mcp__jan-crm__[a-z_]+$/.test(name) && !MANAGER_ONLY.has(name);
}

// CRM tools only: the Chief has no shell, files or web, and creating a
// helper must not be the way to get them.
export function workerTools(requested: string[]): string[] {
  const bad = requested.filter((t) => !isWorkerTool(t));
  if (bad.length) {
    throw new Error(
      `Not allowed for an agent you create: ${bad.join(", ")}. Only CRM tools (${CRM_PREFIX}…) and none of your own manager tools.`
    );
  }
  return [...new Set(requested)];
}

const firstLine = (s: string) => s.trim().split("\n")[0].slice(0, 200);
const expiryFrom = (hours: number) => new Date(Date.now() + hours * 3_600_000).toISOString();

async function loadCallerChief(ctx: Ctx, agentId: string): Promise<{ id: string; tools: string[] }> {
  const { data, error } = await ctx.db
    .from("agents")
    .select("id, tools")
    .eq("id", agentId)
    .eq("organization_id", ctx.orgId)
    .eq("role", "chief")
    .eq("created_by", ctx.userId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) {
    throw new Error("Only your Chief can manage agents — pass the Chief's own agent id (from its system prompt) as agent_id.");
  }
  return data as { id: string; tools: string[] };
}

// The user's own worker agents — never a system agent (they belong to the
// whole organization), never a Chief. Foreign and nonexistent read the same.
async function loadOwnWorker(ctx: Ctx, targetId: string): Promise<{ id: string; name: string; managed_by: string | null }> {
  const { data, error } = await ctx.db
    .from("agents")
    .select("id, name, managed_by")
    .eq("id", targetId)
    .eq("organization_id", ctx.orgId)
    .eq("created_by", ctx.userId)
    .eq("is_system", false)
    .eq("role", "worker")
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) {
    throw new Error(`Agent ${targetId} not found among the user's own agents. System agents belong to the whole organization — use them, never change them.`);
  }
  return data as { id: string; name: string; managed_by: string | null };
}

function assertManagedBy(target: { name: string; managed_by: string | null }, chiefId: string) {
  if (target.managed_by !== chiefId) {
    throw new Error(`${target.name} was set up by the user — you can rename or pause it, but its job, tools and existence are the user's.`);
  }
}

export const createAgentSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  name: z.string().trim().min(1).max(80).describe("Display name"),
  job: z.string().trim().min(1).max(4000).describe("What this agent does — its standing instructions, written as a brief to a colleague. The first line becomes its card description."),
  tools: z.array(z.string()).max(80).optional().describe("Full tool names (mcp__jan-crm__…). Omit to give it the same CRM tools you have."),
  temporary: z.boolean().optional().describe(`true for a one-off helper: it is removed automatically after expires_in_hours (default ${DEFAULT_TEMPORARY_HOURS})`),
  expires_in_hours: z.number().int().min(1).max(720).optional().describe("Remove the agent after this many hours"),
}).strict();

export async function createAgent(ctx: Ctx, args: z.infer<typeof createAgentSchema>) {
  const chief = await loadCallerChief(ctx, args.agent_id);
  const tools = args.tools ? workerTools(args.tools) : chief.tools.filter(isWorkerTool);

  const { count, error: countError } = await ctx.db
    .from("agents")
    .select("id", { count: "exact", head: true })
    .eq("managed_by", chief.id)
    .is("deleted_at", null);
  if (countError) throw new Error(`Could not count your agents: ${countError.message}`);
  if ((count ?? 0) >= MAX_MANAGED_AGENTS) {
    throw new Error(`You already manage ${MAX_MANAGED_AGENTS} agents — delete one you no longer need first.`);
  }

  const hours = args.expires_in_hours ?? (args.temporary ? DEFAULT_TEMPORARY_HOURS : null);
  const { data, error } = await ctx.db
    .from("agents")
    .insert({
      name: args.name,
      description: firstLine(args.job),
      system_prompt: args.job,
      append_system_prompt: "",
      tools,
      model: null,
      skill_ids: [],
      external_skill_names: [],
      mcp_servers: [],
      chrome_enabled: false,
      execution_mode: "chat_stateless",
      managed_by: chief.id,
      expires_at: hours ? expiryFrom(hours) : null,
    })
    .select("id, name, expires_at")
    .single();
  if (error) throw new Error(`Could not create the agent: ${error.message}`);
  return { success: true, agent_id: data.id, name: data.name, expires_at: data.expires_at, tools };
}

export const updateAgentSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  target_agent_id: z.string().uuid().describe("The agent to change"),
  name: z.string().trim().min(1).max(80).optional(),
  job: z.string().trim().min(1).max(4000).optional().describe("Replaces its standing instructions (only agents you created)"),
  tools: z.array(z.string()).max(80).optional().describe("Replaces its tools (only agents you created)"),
  expires_in_hours: z.number().int().min(1).max(720).nullable().optional().describe("New expiry from now; null keeps it for good (only agents you created)"),
}).strict();

export async function updateAgent(ctx: Ctx, args: z.infer<typeof updateAgentSchema>) {
  const chief = await loadCallerChief(ctx, args.agent_id);
  const target = await loadOwnWorker(ctx, args.target_agent_id);
  const fields: Record<string, unknown> = {};
  if (args.name !== undefined) fields.name = args.name;
  if (args.job !== undefined || args.tools !== undefined || args.expires_in_hours !== undefined) {
    assertManagedBy(target, chief.id);
    if (args.job !== undefined) { fields.system_prompt = args.job; fields.description = firstLine(args.job); }
    if (args.tools !== undefined) fields.tools = workerTools(args.tools);
    if (args.expires_in_hours !== undefined) fields.expires_at = args.expires_in_hours === null ? null : expiryFrom(args.expires_in_hours);
  }
  if (Object.keys(fields).length === 0) throw new Error("Nothing to update — pass name, job, tools or expires_in_hours.");
  const { error } = await ctx.db.from("agents").update(fields).eq("id", target.id);
  if (error) throw new Error(`Could not update ${target.name}: ${error.message}`);
  return { success: true, updated: Object.keys(fields) };
}

export const pauseAgentSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  target_agent_id: z.string().uuid(),
  paused: z.boolean().describe("true = no routines and no delegated tasks until resumed"),
}).strict();

export async function pauseAgent(ctx: Ctx, args: z.infer<typeof pauseAgentSchema>) {
  await loadCallerChief(ctx, args.agent_id);
  const target = await loadOwnWorker(ctx, args.target_agent_id);
  const { error } = await ctx.db.from("agents").update({ paused: args.paused }).eq("id", target.id);
  if (error) throw new Error(`Could not ${args.paused ? "pause" : "resume"} ${target.name}: ${error.message}`);
  return { success: true, paused: args.paused };
}

export const deleteAgentSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  target_agent_id: z.string().uuid().describe("An agent you created"),
}).strict();

export async function deleteAgent(ctx: Ctx, args: z.infer<typeof deleteAgentSchema>) {
  const chief = await loadCallerChief(ctx, args.agent_id);
  const target = await loadOwnWorker(ctx, args.target_agent_id);
  assertManagedBy(target, chief.id);
  const { error } = await ctx.db.from("agents").update({ deleted_at: new Date().toISOString() }).eq("id", target.id);
  if (error) throw new Error(`Could not delete ${target.name}: ${error.message}`);
  return { success: true, deleted: target.name };
}

export const delegateSchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id"),
  to_agent_id: z.string().uuid().describe("The agent that should do the task (id from the overview)"),
  task: z.string().min(1).max(8000).describe("The complete task. The other agent sees nothing of your conversation — include every fact, id and expectation it needs, and say what the result should contain."),
}).strict();

// The database decides everything else (create_delegation in
// 20261107000300_chief_delegation.sql): visibility, paused targets, no
// delegation to a Chief, depth ≤ 3, 30 per hour, and that only the Chief
// delegates at the root.
export async function delegate(ctx: Ctx, args: z.infer<typeof delegateSchema>) {
  const { data, error } = await ctx.db.rpc("create_delegation", {
    p_from_agent_id: args.agent_id,
    p_to_agent_id: args.to_agent_id,
    p_task: args.task,
  });
  if (error) throw new Error(error.message);
  return {
    delegation_id: data,
    status: "open",
    note: "The desktop app runs it now. The result comes back as a new message in your thread (\"Result from …\") — don't wait or poll; finish your turn.",
  };
}

// ── Standing orders and proposals (spec §3.4, §4.5) ───────────────────────
// Chief only, like the manager tools above. Every limit lives in the RPCs
// (CRM migration 20261107000500_chief_standing_orders.sql). There is
// deliberately no tool to accept or reject a proposal: that is the user's
// click in the app, and nothing the Chief reads can make it happen.

export const createStandingOrderSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  instruction: z.string().trim().min(1).max(2000).describe("What to watch for and what to do, in the user's own words"),
  project_id: z.string().uuid().optional().describe("Only for this project; omit for all projects"),
}).strict();

export async function createStandingOrder(ctx: Ctx, args: z.infer<typeof createStandingOrderSchema>) {
  await loadCallerChief(ctx, args.agent_id);
  const { data, error } = await ctx.db.rpc("create_standing_order", {
    p_instruction: args.instruction,
    p_project_id: args.project_id ?? null,
  });
  if (error) throw new Error(error.message);
  return { success: true, standing_order_id: data, note: "The desktop app wakes you when something changes that may concern it." };
}

export const updateStandingOrderSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  standing_order_id: z.string().uuid(),
  instruction: z.string().trim().min(1).max(2000).optional(),
  enabled: z.boolean().optional().describe("false switches it off without deleting it"),
  project_id: z.string().uuid().nullable().optional().describe("A project id, or null for all projects"),
}).strict();

export async function updateStandingOrder(ctx: Ctx, args: z.infer<typeof updateStandingOrderSchema>) {
  // Checked here, not with .refine: a ZodEffects has no .shape, so the MCP SDK
  // would advertise the tool with no parameters at all.
  if (args.instruction === undefined && args.enabled === undefined && args.project_id === undefined) {
    throw new Error("Nothing to update — pass instruction, enabled or project_id.");
  }
  await loadCallerChief(ctx, args.agent_id);
  const { error } = await ctx.db.rpc("update_standing_order", {
    p_id: args.standing_order_id,
    p_instruction: args.instruction ?? null,
    p_enabled: args.enabled ?? null,
    p_project_id: args.project_id ?? null,
    p_clear_project: args.project_id === null,
  });
  if (error) throw new Error(error.message);
  return { success: true };
}

export const createProposalSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  title: z.string().trim().min(1).max(200).describe("What you propose, as one line"),
  body: z.string().max(8000).describe("Markdown: why, and exactly what you will do if the user accepts — every step, record and id"),
  project_id: z.string().uuid().optional(),
  standing_order_id: z.string().uuid().optional().describe("The standing order that led to it"),
}).strict();

export async function createProposal(ctx: Ctx, args: z.infer<typeof createProposalSchema>) {
  await loadCallerChief(ctx, args.agent_id);
  const { data, error } = await ctx.db.rpc("create_chief_proposal", {
    p_title: args.title,
    p_body: args.body,
    p_project_id: args.project_id ?? null,
    p_standing_order_id: args.standing_order_id ?? null,
  });
  if (error) throw new Error(error.message);
  return { success: true, proposal_id: data, status: "open", note: "The user accepts or rejects it in the app. Do not carry it out before you are told it was accepted." };
}

export const updateProposalStatusSchema = z.object({
  agent_id: z.string().uuid().describe("Your own (the Chief's) agent id"),
  proposal_id: z.string().uuid(),
  status: z.literal("done").describe("The only status you set: an accepted proposal you have carried out"),
  outcome: z.string().trim().min(1).max(2000).describe("One or two lines: what you did (or what stopped you)"),
}).strict();

export async function updateProposalStatus(ctx: Ctx, args: z.infer<typeof updateProposalStatusSchema>) {
  await loadCallerChief(ctx, args.agent_id);
  const { data, error } = await ctx.db.rpc("complete_chief_proposal", { p_id: args.proposal_id, p_outcome: args.outcome });
  if (error) throw new Error(error.message);
  if (data !== true) throw new Error("This proposal is not accepted (or already done) — only an accepted proposal can be marked done.");
  return { success: true, status: "done" };
}
