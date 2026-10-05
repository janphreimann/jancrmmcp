import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import type { TimelineRow } from "../briefing.js";
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

// ── remember_for_project ────────────────────────────────────────────────────
// Claude's second zone next to agent_status: not where the project stands
// (that changes every session) but what the user told Claude about it —
// constraints, preferences, corrections. Kept apart from the status so a
// status rewrite can never drop an instruction, and apart from the
// human-owned description so Claude can write it without a proposal.
export const rememberForProjectSchema = z.object({
  project_id: z.string().uuid(),
  memory: z.string().max(4000).describe(
    "The FULL replacement for this project's memory — not an append. Short bullet points of what the user told you " +
    "that still holds: constraints, preferences, decisions, corrections of your own mistakes. Drop what no longer " +
    "applies. Empty string clears it."
  ),
});

export async function rememberForProject(ctx: Ctx, args: z.infer<typeof rememberForProjectSchema>) {
  const memory = args.memory.trim();
  const { data, error } = await ctx.db
    .from("projects")
    .update({ agent_memory: memory, agent_memory_updated_at: new Date().toISOString() })
    .eq("id", args.project_id)
    .select("id");
  if (error) throw new Error(error.message);
  if (!data?.length) throw new Error(`Project ${args.project_id} not found`);
  return { id: args.project_id, message: "Project memory saved", length: memory.length };
}

// ── add_timeline_entry ──────────────────────────────────────────────────────
// The timeline is the project's history for the humans in it: what happened,
// short. It is not Claude's notebook — where the project stands is
// agent_status, what the user told Claude is agent_memory. So the one way
// Claude writes here is an event the user reported that the CRM doesn't
// already hold (a meeting, a call, a decision). It is filed under the user,
// who reported it; metadata.via_agent marks who typed it.
export const addTimelineEntrySchema = z.object({
  project_id: z.string().uuid(),
  occurred_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).describe(
    "The day the event happened (YYYY-MM-DD) — not today unless it happened today. \"Yesterday\" in the user's message means yesterday's date."
  ),
  text: z.string().min(10).max(600).describe(
    "One or two short sentences in English, the first line a headline of the event. Facts only: who, what, the outcome. " +
    "No \"Jan reported\", no notes about what you did or could not do."
  ),
  type: z.enum(["note", "decision", "milestone"]).default("note").describe(
    "decision: something was decided. milestone: a deliverable or phase was completed. note: anything else that happened."
  ),
  contact_ids: z.array(z.string().uuid()).max(10).optional().describe("Contacts involved in the event"),
  company_ids: z.array(z.string().uuid()).max(10).optional().describe("Companies involved in the event"),
});

const ENTRY_TYPE: Record<z.infer<typeof addTimelineEntrySchema>["type"], string> = {
  note: "note", decision: "decision", milestone: "completed",
};

export async function addTimelineEntry(ctx: Ctx, args: z.infer<typeof addTimelineEntrySchema>) {
  // Tags carry the names (the timeline renders them without a lookup), so
  // they are read under the caller's token: an id they cannot see is dropped.
  const [contacts, companies] = await Promise.all([
    args.contact_ids?.length
      ? ctx.db.from("contacts").select("id, first_name, last_name").in("id", args.contact_ids)
      : Promise.resolve({ data: [], error: null }),
    args.company_ids?.length
      ? ctx.db.from("companies").select("id, name, website").in("id", args.company_ids)
      : Promise.resolve({ data: [], error: null }),
  ]);
  if (contacts.error) throw new Error(contacts.error.message);
  if (companies.error) throw new Error(companies.error.message);

  const today = new Date().toISOString().slice(0, 10);
  // A past day has no meaningful time of day: noon UTC keeps it on that date
  // in every European timezone, and date_only tells the UI not to show it.
  const occurredAt = args.occurred_on === today ? new Date().toISOString() : `${args.occurred_on}T12:00:00Z`;
  const contactTags = (contacts.data ?? []).map((c: { id: string; first_name: string | null; last_name: string | null }) => ({
    id: c.id, name: [c.first_name, c.last_name].filter(Boolean).join(" "),
  }));
  const companyTags = (companies.data ?? []).map((c: { id: string; name: string; website: string | null }) => ({
    id: c.id, name: c.name, website: c.website,
  }));

  const { data, error } = await ctx.db
    .from("project_journal")
    .insert({
      project_id: args.project_id,
      entry_type: ENTRY_TYPE[args.type],
      content: args.text.trim(),
      occurred_at: occurredAt,
      metadata: {
        via_agent: true,
        ...(args.occurred_on !== today && { date_only: true }),
        ...(contactTags.length && { contacts: contactTags }),
        ...(companyTags.length && { companies: companyTags }),
      },
      is_system: false,
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
  return { id: data.id, message: "Added to the timeline" };
}

// ── propose_description ─────────────────────────────────────────────────────
export const proposeDescriptionSchema = z.object({
  project_id: z.string().uuid(),
  proposed_description: z.string().min(1).describe("The full replacement text of the description (markdown), not a diff."),
  reason: z.string().min(5).describe("One or two sentences: what changed and why the description should say it."),
});

const OPEN_DESCRIPTION_PROPOSAL_MESSAGE = "An open description proposal already exists — wait for the user to resolve it.";

export async function proposeDescription(ctx: Ctx, args: z.infer<typeof proposeDescriptionSchema>) {
  const { data: open, error: openErr } = await ctx.db
    .from("project_journal")
    .select("id")
    .eq("project_id", args.project_id)
    .eq("entry_type", "description_proposal")
    .eq("metadata->>status", "open")
    .limit(1);
  if (openErr) throw new Error(openErr.message);
  if (open?.length) throw new Error(OPEN_DESCRIPTION_PROPOSAL_MESSAGE);

  const { data, error } = await ctx.db
    .from("project_journal")
    .insert({
      project_id: args.project_id,
      entry_type: "description_proposal",
      content: args.reason.trim(),
      metadata: { proposed_description: args.proposed_description, reason: args.reason.trim(), status: "open" },
      is_system: true,
      created_by: ctx.userId,
    })
    .select("id")
    .single();
  if (error) {
    // Race: another call passed the pre-check first and the partial unique
    // index (project_journal_one_open_description_proposal) caught this one.
    if ((error as { code?: string }).code === "23505") throw new Error(OPEN_DESCRIPTION_PROPOSAL_MESSAGE);
    // A project the caller can't see fails here too (RLS/insert trigger) —
    // same message as "not found" so this isn't an oracle for foreign ids.
    // Anything else is a genuine fault and must surface as such.
    if (isNotFoundError(error)) throw new Error(`Project ${args.project_id} not found`);
    throw new Error(error.message);
  }
  return { id: data.id, message: "Description proposal recorded — the user will apply or reject it" };
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

type ThreadMail = { id: string; occurred_at: string; direction: string | null; from_name: string | null; preview: string };

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
    const flat = r.preview ? r.preview.replace(/\s+/g, " ").trim() : "";
    const preview = flat && r.preview !== r.title ? ` — ${flat.slice(0, 160)}` : "";
    // A mail row is a whole conversation (project_timeline groups replies);
    // list its earlier mails underneath so each one stays reachable.
    const thread = r.kind === "email" ? ((r.meta["thread"] ?? []) as ThreadMail[]) : [];
    const note = thread.length > 1 ? ` (conversation, ${thread.length} mails)` : "";
    const line = `- ${r.occurred_at.slice(0, 16).replace("T", " ")} ${label}: ${r.title}${note}${preview} [${REF_KIND[r.kind]}:${r.item_id}]`;
    if (!note) return line;
    const earlier = thread.filter((m) => m.id !== r.item_id).map((m) => {
      const dir = m.direction === "outbound" ? "out" : `in${m.from_name ? ` from ${m.from_name}` : ""}`;
      const text = m.preview ? ` — ${m.preview.replace(/\s+/g, " ").trim().slice(0, 120)}` : "";
      return `    - ${m.occurred_at.slice(0, 16).replace("T", " ")} ${dir}${text} [email:${m.id}]`;
    });
    return [line, ...earlier].join("\n");
  });
  const nextBefore = rows.length === args.limit ? rows[rows.length - 1].occurred_at : "end";
  return [...lines, "", `next_before: ${nextBefore}`].join("\n");
}
