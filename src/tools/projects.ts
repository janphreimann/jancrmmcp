import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { PROJECT_STAGES } from "../constants.js";

const PROJECT_LIST_COLUMNS = "id, name, stage, budget_amount, initiative_id, main_contact_id, created_at, updated_at";

export const searchProjectsSchema = z.object({
  query: z.string().optional().describe("Fuzzy search in project name — tolerates typos"),
  stage: z.enum(PROJECT_STAGES).optional(),
  contact_id: z.string().uuid().optional().describe("Filter to projects linked to this contact"),
  initiative_id: z.string().uuid().optional().describe("Filter to projects in this initiative"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchProjects(ctx: Ctx, args: z.infer<typeof searchProjectsSchema>) {
  let projects: Array<Record<string, unknown>>;

  if (args.query) {
    const { data, error } = await ctx.db.rpc("search_projects_smart", {
      p_query: args.query,
      p_org_id: ctx.orgId,
      p_limit: args.limit,
    });
    if (error) throw new Error(error.message);
    projects = (data ?? []) as Array<Record<string, unknown>>;
    if (args.stage) projects = projects.filter((d) => d.stage === args.stage);
    if (args.initiative_id) projects = projects.filter((d) => d.initiative_id === args.initiative_id);
  } else {
    let q = ctx.db
      .from("projects")
      .select(PROJECT_LIST_COLUMNS)
      .is("deleted_at", null)
      .order("updated_at", { ascending: false })
      .limit(args.limit);
    if (args.stage) q = q.eq("stage", args.stage);
    if (args.initiative_id) q = q.eq("initiative_id", args.initiative_id);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    projects = (data ?? []) as Array<Record<string, unknown>>;
  }

  if (args.contact_id) {
    const { data: links } = await ctx.db
      .from("project_contacts")
      .select("project_id")
      .eq("contact_id", args.contact_id);
    const projectIds = new Set((links ?? []).map((l: { project_id: string }) => l.project_id));
    projects = projects.filter((d) => projectIds.has(d["id"] as string));
  }

  return projects;
}

export const getProjectSchema = z.object({
  id: z.string().uuid(),
});

/**
 * Raw record plus its links. Orientation (state, delta, open items, index)
 * is open_project's job — this stays for programmatic access to the row.
 */
export async function getProject(ctx: Ctx, args: z.infer<typeof getProjectSchema>) {
  const { data, error } = await ctx.db
    .from("projects")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const [contactLinks, companyLinks, tagRows, initiativeRow] = await Promise.all([
    ctx.db
      .from("project_contacts")
      .select("contact_id, contacts:contact_id(id, first_name, last_name, email_1)")
      .eq("project_id", args.id),
    ctx.db
      .from("project_companies")
      .select("company_id, companies:company_id(id, name)")
      .eq("project_id", args.id),
    ctx.db
      .from("project_tags")
      .select("tag_id, tags:tag_id(id, name, color)")
      .eq("project_id", args.id),
    data.initiative_id
      ? ctx.db.from("initiatives").select("id, name, description, status").eq("id", data.initiative_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ]);

  return {
    ...data,
    contacts: (contactLinks.data ?? []).map((r: { contacts: unknown }) => r.contacts),
    companies: (companyLinks.data ?? []).map((r: { companies: unknown }) => r.companies),
    tags: (tagRows.data ?? []).map((r: { tags: unknown }) => r.tags),
    initiative: initiativeRow.data ?? null,
  };
}

export const createProjectSchema = z.object({
  name: z.string().min(1),
  stage: z.enum(PROJECT_STAGES).default("Planning"),
  description: z.string().optional().nullable(),
  budget_amount: z.number().optional().nullable(),
  main_contact_id: z.string().uuid().optional().nullable(),
  contact_ids: z.array(z.string().uuid()).default([]),
  company_ids: z.array(z.string().uuid()).default([]),
  initiative_id: z.string().uuid().optional().nullable(),
  start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function createProject(ctx: Ctx, args: z.infer<typeof createProjectSchema>) {
  const { contact_ids, company_ids, ...fields } = args;
  const { data, error } = await ctx.db
    .from("projects")
    .insert({ ...fields, description: fields.description ?? "", created_by: ctx.userId, ...agentMeta() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const allContactIds = Array.from(
    new Set([...(fields.main_contact_id ? [fields.main_contact_id] : []), ...contact_ids])
  );
  if (allContactIds.length > 0) {
    await ctx.db
      .from("project_contacts")
      .insert(allContactIds.map((cid) => ({ project_id: data.id, contact_id: cid })));
  }
  if (company_ids.length > 0) {
    await ctx.db
      .from("project_companies")
      .insert(company_ids.map((cid) => ({ project_id: data.id, company_id: cid })));
  }
  return { id: data.id, message: "Project created successfully" };
}

// Zone rule (spec §2.1): neither `brief` (human-owned, use propose_brief)
// nor the status note (use update_agent_status) is writable here. .strict()
// turns an attempt into a validation error instead of a silent drop.
export const updateProjectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().optional(),
    stage: z.enum(PROJECT_STAGES).optional(),
    description: z.string().optional().nullable(),
    budget_amount: z.number().optional().nullable(),
    initiative_id: z.string().uuid().optional().nullable(),
    start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
    expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  })
  .strict();

export async function updateProject(ctx: Ctx, args: z.infer<typeof updateProjectSchema>) {
  const { id, ...updates } = args;
  const { data, error } = await ctx.db
    .from("projects")
    .update(updates)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  // Eine fremde UUID trifft durch die Policy auf null Zeilen. Ohne diese
  // Prüfung meldete das Tool trotzdem Erfolg.
  if (!data?.length) throw new Error(`Project ${id} not found`);
  return { id, message: "Project updated successfully" };
}
