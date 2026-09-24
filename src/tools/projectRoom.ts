import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { isAgentSession, type TimelineRow } from "../briefing.js";
import { isNotFoundError } from "./dbErrors.js";

// ── update_agent_status ─────────────────────────────────────────────────────
export const updateAgentStatusSchema = z.object({
  project_id: z.string().uuid(),
  status: z.string().min(10).max(2000).describe(
    "3–8 sentences of plain prose: where the project stands, what happened last, what is next or blocking. No headings. Replaces the previous status."
  ),
});

export async function updateAgentStatus(ctx: Ctx, args: z.infer<typeof updateAgentStatusSchema>) {
  const { data, error } = await ctx.db
    .from("projects")
    .update({ agent_status: args.status.trim(), agent_status_updated_at: new Date().toISOString() })
    .eq("id", args.project_id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`Project ${args.project_id} not found`);
  return { id: args.project_id, message: "Status updated" };
}

// ── log_project_activity ────────────────────────────────────────────────────
// project_journal has no created_by_agent/agent_approved columns (it's a
// system log, not an entity table with an AgentBadge) — no agentMeta() here.
export const logProjectActivitySchema = z.object({
  project_id: z.string().uuid(),
  summary: z.string().min(10).max(4000).describe("One paragraph: what you did in this session and what is left open."),
});

export async function logProjectActivity(ctx: Ctx, args: z.infer<typeof logProjectActivitySchema>) {
  const { data, error } = await ctx.db
    .from("project_journal")
    .insert({
      project_id: args.project_id,
      entry_type: "agent_session",
      content: args.summary.trim(),
      metadata: { tool: "log_project_activity" },
      is_system: true,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) {
    // A project the caller can't see fails via the FK/RLS/trigger on
    // project_id — same message as "not found" so this isn't an oracle for
    // foreign ids. Anything else (network, grant, a real constraint
    // violation) is a genuine fault and must surface as such.
    if (isNotFoundError(error)) throw new Error(`Project ${args.project_id} not found`);
    throw new Error(error.message);
  }
  return { id: data.id, message: "Session logged" };
}

// ── propose_brief ───────────────────────────────────────────────────────────
export const proposeBriefSchema = z.object({
  project_id: z.string().uuid(),
  proposed_brief: z.string().min(1).describe("The full replacement text of the brief (markdown), not a diff."),
  reason: z.string().min(5).describe("One or two sentences: what changed and why the brief should say it."),
});

const OPEN_BRIEF_PROPOSAL_MESSAGE = "An open brief proposal already exists — wait for the user to resolve it.";

export async function proposeBrief(ctx: Ctx, args: z.infer<typeof proposeBriefSchema>) {
  const { data: open, error: openErr } = await ctx.db
    .from("project_journal")
    .select("id")
    .eq("project_id", args.project_id)
    .eq("entry_type", "brief_proposal")
    .eq("metadata->>status", "open")
    .limit(1);
  if (openErr) throw new Error(openErr.message);
  if (open?.length) throw new Error(OPEN_BRIEF_PROPOSAL_MESSAGE);

  const { data, error } = await ctx.db
    .from("project_journal")
    .insert({
      project_id: args.project_id,
      entry_type: "brief_proposal",
      content: args.reason.trim(),
      metadata: { proposed_brief: args.proposed_brief, reason: args.reason.trim(), status: "open" },
      is_system: true,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) {
    // Race: another call passed the pre-check first and the partial unique
    // index (project_journal_one_open_brief_proposal) caught this one.
    if ((error as { code?: string }).code === "23505") throw new Error(OPEN_BRIEF_PROPOSAL_MESSAGE);
    // A project the caller can't see fails here too (RLS/insert trigger) —
    // same message as "not found" so this isn't an oracle for foreign ids.
    // Anything else is a genuine fault and must surface as such.
    if (isNotFoundError(error)) throw new Error(`Project ${args.project_id} not found`);
    throw new Error(error.message);
  }
  return { id: data.id, message: "Brief proposal recorded — the user will apply or reject it" };
}

// ── link_project_item ───────────────────────────────────────────────────────
export const linkProjectItemSchema = z.object({
  project_id: z.string().uuid(),
  item_type: z.enum(["email", "audio_recording", "calendar_event"]),
  item_id: z.string().uuid().describe("email id, recording_group_id, or calendar event id"),
});

const ITEM_TABLE: Record<z.infer<typeof linkProjectItemSchema>["item_type"], { table: string; column: string }> = {
  email: { table: "email_messages", column: "id" },
  audio_recording: { table: "audio_recordings", column: "recording_group_id" },
  calendar_event: { table: "calendar_events", column: "id" },
};

const LINK_LINKED_MESSAGE = "Already linked to the project";
const LINK_PROMOTED_MESSAGE = "Linked to the project (shown with an Agent badge until the user approves)";

/**
 * Flips an existing, non-linked project_items row to linked. Guarded with
 * `.neq("status", "linked")` so a concurrent promote never double-stamps
 * `linked_at`/`linked_by`; on zero rows we re-read to tell "someone else
 * just linked it" (report the same success) from "the row disappeared or
 * the project vanished out from under us" (not found).
 */
async function promoteProjectItem(ctx: Ctx, id: string, projectId: string) {
  const { data, error } = await ctx.db
    .from("project_items")
    .update({ status: "linked", linked_by: ctx.userId, linked_at: new Date().toISOString(), ...agentMeta() })
    .eq("id", id)
    .neq("status", "linked")
    .select("id");
  if (error) throw new Error(error.message);
  if (data?.length) return { id, message: LINK_PROMOTED_MESSAGE };

  const { data: after, error: afterErr } = await ctx.db.from("project_items").select("id, status").eq("id", id).maybeSingle();
  if (afterErr) throw new Error(afterErr.message);
  if (after?.status === "linked") return { id: after.id, message: LINK_LINKED_MESSAGE };
  throw new Error(`Project ${projectId} not found`);
}

export async function linkProjectItem(ctx: Ctx, args: z.infer<typeof linkProjectItemSchema>) {
  // The caller must be able to read the target; a foreign id yields zero
  // rows through RLS and gets the same "not found" as a nonexistent one.
  const t = ITEM_TABLE[args.item_type];
  const { data: target, error: targetErr } = await ctx.db.from(t.table).select(t.column).eq(t.column, args.item_id).limit(1);
  if (targetErr) throw new Error(targetErr.message);
  if (!target?.length) throw new Error("Item not found");

  // A row may already exist (suggested/dismissed by the basket, or linked by
  // a human). Never overwrite a human link with agent provenance — only
  // promote a non-linked row, or insert a fresh one.
  const { data: existing, error: existingErr } = await ctx.db
    .from("project_items")
    .select("id, status")
    .eq("project_id", args.project_id)
    .eq("item_type", args.item_type)
    .eq("item_id", args.item_id)
    .maybeSingle();
  if (existingErr) throw new Error(existingErr.message);

  if (existing?.status === "linked") {
    return { id: existing.id, message: LINK_LINKED_MESSAGE };
  }

  if (existing) {
    return promoteProjectItem(ctx, existing.id, args.project_id);
  }

  const { data, error } = await ctx.db
    .from("project_items")
    .insert({
      project_id: args.project_id,
      item_type: args.item_type,
      item_id: args.item_id,
      status: "linked",
      linked_by: ctx.userId,
      linked_at: new Date().toISOString(),
      ...agentMeta(),
    })
    .select("id")
    .single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      // Concurrent link_project_item call won the race between our select
      // and our insert. Re-read the row it created and report its actual
      // state instead of erroring on a call that, semantically, succeeded.
      const { data: after, error: afterErr } = await ctx.db
        .from("project_items")
        .select("id, status")
        .eq("project_id", args.project_id)
        .eq("item_type", args.item_type)
        .eq("item_id", args.item_id)
        .maybeSingle();
      if (afterErr) throw new Error(afterErr.message);
      if (after?.status === "linked") return { id: after.id, message: LINK_LINKED_MESSAGE };
      if (after) return promoteProjectItem(ctx, after.id, args.project_id);
      throw new Error(`Project ${args.project_id} not found`);
    }
    if (isNotFoundError(error)) throw new Error(`Project ${args.project_id} not found`);
    throw new Error(error.message);
  }
  return { id: data.id, message: LINK_PROMOTED_MESSAGE };
}

// ── list_project_timeline ───────────────────────────────────────────────────
const KINDS = ["journal", "task_created", "task_completed", "interaction", "email", "audio_recording", "calendar_event", "document"] as const;

export const listProjectTimelineSchema = z.object({
  project_id: z.string().uuid(),
  before: z.string().datetime({ offset: true }).optional().describe("Page backwards: only rows older than this ISO timestamp"),
  since: z.string().datetime({ offset: true }).optional().describe("Only rows newer than this ISO timestamp"),
  kinds: z.array(z.enum(KINDS)).optional().describe("Restrict to these kinds"),
  limit: z.number().int().min(1).max(100).default(40),
});

const KIND_LABEL: Record<(typeof KINDS)[number], string> = {
  journal: "Journal", task_created: "Task added", task_completed: "Task done", interaction: "Interaction",
  email: "Mail", audio_recording: "Recording", calendar_event: "Event", document: "Document",
};
const REF_KIND: Record<(typeof KINDS)[number], string> = {
  journal: "journal", task_created: "task", task_completed: "task", interaction: "interaction",
  email: "email", audio_recording: "recording", calendar_event: "event", document: "document",
};

export async function listProjectTimeline(ctx: Ctx, args: z.infer<typeof listProjectTimelineSchema>): Promise<string> {
  const { data, error } = await ctx.db.rpc("project_timeline", {
    p_project_id: args.project_id,
    p_since: args.since ?? null,
    p_before: args.before ?? null,
    p_limit: args.limit,
    p_kinds: args.kinds ?? null,
  });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as TimelineRow[];
  if (!rows.length) return "No timeline rows in that range.";

  const lines = rows.map((r) => {
    let label = KIND_LABEL[r.kind];
    if (r.kind === "email") label = r.meta["direction"] === "outbound" ? "Mail out" : "Mail in";
    // Claude's own session log is shown in full (see isAgentSession); every
    // other preview keeps its 160-char cap.
    const flat = r.preview ? r.preview.replace(/\s+/g, " ").trim() : "";
    const preview = flat && r.preview !== r.title ? ` — ${isAgentSession(r) ? flat : flat.slice(0, 160)}` : "";
    return `- ${r.occurred_at.slice(0, 16).replace("T", " ")} ${label}: ${r.title}${preview} [${REF_KIND[r.kind]}:${r.item_id}]`;
  });
  const nextBefore = rows.length === args.limit ? rows[rows.length - 1].occurred_at : "end";
  return [...lines, "", `next_before: ${nextBefore}`].join("\n");
}
