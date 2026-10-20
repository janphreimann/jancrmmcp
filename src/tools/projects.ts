import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { chunk, IN_CHUNK } from "./queryHelpers.js";
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
  // A contact's projects become an id filter of the main query, so every
  // filter runs before the limit (filtering a cut top N in JS lost matches).
  let projectIds: string[] | null = null;
  if (args.contact_id) {
    const { data: links, error: linkError } = await ctx.db
      .from("project_contacts")
      .select("project_id")
      .eq("contact_id", args.contact_id);
    if (linkError) throw new Error(linkError.message);
    projectIds = [...new Set((links ?? []).map((l) => l.project_id))];
    if (!projectIds.length) return [];
  }
  const filtered = !!(projectIds || args.stage || args.initiative_id);

  const rows: Array<Record<string, unknown>> = [];
  for (const ids of projectIds ? chunk(projectIds) : [null]) {
    if (args.query) {
      let q = ctx.db
        .rpc("search_projects_smart", {
          p_query: args.query,
          p_org_id: ctx.orgId,
          p_limit: filtered ? 1000 : args.limit,
        })
        .order("match_score", { ascending: false })
        .limit(args.limit);
      if (ids) q = q.in("id", ids);
      if (args.stage) q = q.eq("stage", args.stage);
      if (args.initiative_id) q = q.eq("initiative_id", args.initiative_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    } else {
      let q = ctx.db
        .from("projects")
        .select(PROJECT_LIST_COLUMNS)
        .is("deleted_at", null)
        .order("updated_at", { ascending: false })
        .limit(args.limit);
      if (ids) q = q.in("id", ids);
      if (args.stage) q = q.eq("stage", args.stage);
      if (args.initiative_id) q = q.eq("initiative_id", args.initiative_id);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      rows.push(...((data ?? []) as Array<Record<string, unknown>>));
    }
  }
  if (projectIds && projectIds.length > IN_CHUNK) {
    if (args.query) rows.sort((a, b) => Number(b.match_score) - Number(a.match_score));
    else rows.sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  }
  return rows.slice(0, args.limit);
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
  // All or nothing, like create_contact: a project missing the people it was
  // created for, reported as success, is worse than an error to retry.
  const links = [
    allContactIds.length
      ? ctx.db.from("project_contacts").insert(allContactIds.map((cid) => ({ project_id: data.id, contact_id: cid })))
      : null,
    company_ids.length
      ? ctx.db.from("project_companies").insert(company_ids.map((cid) => ({ project_id: data.id, company_id: cid })))
      : null,
  ];
  for (const link of links) {
    if (!link) continue;
    const { error: linkError } = await link;
    if (linkError) {
      await ctx.db.from("projects").delete().eq("id", data.id);
      throw new Error(`Project not created — contacts/companies could not be linked: ${linkError.message}`);
    }
  }
  return { id: data.id, message: "Project created successfully" };
}

// Zone rule (spec §2.1): neither the description (human-owned, use
// propose_description) nor the status note (use update_agent_status) is
// writable here. .strict() turns an attempt into a validation error instead
// of a silent drop. create_project still takes a description — a new project
// has no human text yet to protect.
export const updateProjectSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().optional(),
    stage: z.enum(PROJECT_STAGES).optional(),
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
