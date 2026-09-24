import { z } from "zod";
import type { Ctx } from "../context.js";

// Read-only on purpose: logging an interaction is a user action in the CRM
// UI (see ../CLAUDE.md — no create_interaction without sign-off).

export const getInteractionSchema = z.object({ id: z.string().uuid() });

export async function getInteraction(ctx: Ctx, args: z.infer<typeof getInteractionSchema>) {
  const { data, error } = await ctx.db
    .from("interactions")
    .select("id, type, title, date, content, next_steps, internal_notes, sentiment, duration_min, project_id, created_at, created_by_agent, agent_approved")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const [contacts, companies, tasks, documents] = await Promise.all([
    ctx.db.from("interaction_contacts").select("contacts:contact_id(id, first_name, last_name, email_1)").eq("interaction_id", args.id),
    ctx.db.from("interaction_companies").select("companies:company_id(id, name)").eq("interaction_id", args.id),
    ctx.db.from("tasks").select("id, title, status").eq("interaction_id", args.id).is("deleted_at", null),
    ctx.db.from("documents").select("id, file_name").eq("interaction_id", args.id).is("deleted_at", null),
  ]);

  return {
    ...data,
    contacts: (contacts.data ?? []).map((r: { contacts: unknown }) => r.contacts),
    companies: (companies.data ?? []).map((r: { companies: unknown }) => r.companies),
    linked_tasks: tasks.data ?? [],
    linked_documents: documents.data ?? [],
  };
}

// The plain object is what server.tool() needs (`.shape`); the refined
// schema is what the handler validates with — a ZodEffects has no .shape.
export const listInteractionsObject = z.object({
  project_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
  company_id: z.string().uuid().optional(),
  since: z.string().optional().describe("ISO date YYYY-MM-DD, inclusive"),
  limit: z.number().int().min(1).max(100).default(25),
});

export const listInteractionsSchema = listInteractionsObject.refine(
  (a) => a.project_id || a.contact_id || a.company_id,
  { message: "Pass at least one of project_id, contact_id, company_id" }
);

export async function listInteractions(ctx: Ctx, raw: unknown) {
  const args = listInteractionsSchema.parse(raw);
  let ids: string[] | null = null;
  if (args.contact_id) {
    const { data } = await ctx.db.from("interaction_contacts").select("interaction_id").eq("contact_id", args.contact_id);
    ids = (data ?? []).map((r: { interaction_id: string }) => r.interaction_id);
  }
  if (args.company_id) {
    const { data } = await ctx.db.from("interaction_companies").select("interaction_id").eq("company_id", args.company_id);
    const cids = (data ?? []).map((r: { interaction_id: string }) => r.interaction_id);
    ids = ids ? ids.filter((i) => cids.includes(i)) : cids;
  }
  if (ids && ids.length === 0) return [];

  let q = ctx.db
    .from("interactions")
    .select("id, type, title, date, next_steps, project_id")
    .is("deleted_at", null)
    .order("date", { ascending: false })
    .limit(args.limit);
  if (args.project_id) q = q.eq("project_id", args.project_id);
  if (ids) q = q.in("id", ids);
  if (args.since) q = q.gte("date", args.since);
  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const rows = data ?? [];
  const rowIds = rows.map((r: { id: string }) => r.id);
  const { data: links } = rowIds.length
    ? await ctx.db.from("interaction_contacts").select("interaction_id, contacts:contact_id(first_name, last_name)").in("interaction_id", rowIds)
    : { data: [] };
  const names: Record<string, string[]> = {};
  for (const l of (links ?? []) as unknown as { interaction_id: string; contacts: { first_name: string; last_name: string } | null }[]) {
    if (l.contacts) (names[l.interaction_id] ||= []).push(`${l.contacts.first_name} ${l.contacts.last_name}`.trim());
  }
  return rows.map((r: { id: string; next_steps: string | null; [k: string]: unknown }) => ({
    ...r,
    contact_names: names[r.id] ?? [],
    has_next_steps: !!r.next_steps,
    next_steps: undefined,
  }));
}
