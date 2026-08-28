import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { STAGE_TO_DB, STAGE_FROM_DB, PROJECT_STAGES } from "../constants.js";

export const searchProjectsSchema = z.object({
  query: z.string().optional().describe("Fuzzy search in project name — tolerates typos"),
  stage: z.enum(PROJECT_STAGES).optional(),
  project_type: z.string().optional(),
  contact_id: z.string().uuid().optional().describe("Filter to projects linked to this contact"),
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

    projects = (data ?? []).map((d: { stage: string; [key: string]: unknown }) => ({
      ...d,
      stage: STAGE_FROM_DB[d.stage] ?? d.stage,
    }));

    if (args.stage) projects = projects.filter((d) => d.stage === args.stage);
    if (args.project_type) projects = projects.filter((d) => d.project_type === args.project_type);
  } else {
    let q = ctx.db
      .from("projects")
      .select("id, name, stage, project_type, target_volume, main_contact_id, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(args.limit);

    if (args.stage) q = q.eq("stage", STAGE_TO_DB[args.stage] ?? args.stage);
    if (args.project_type) q = q.eq("project_type", args.project_type);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    projects = (data ?? []).map((d: { stage: string; [key: string]: unknown }) => ({
      ...d,
      stage: STAGE_FROM_DB[d.stage] ?? d.stage,
    }));
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

export async function getProject(ctx: Ctx, args: z.infer<typeof getProjectSchema>) {
  const { data, error } = await ctx.db
    .from("projects")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const [contactLinks, companyLinks, tagRows] = await Promise.all([
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
  ]);

  return {
    ...data,
    stage: STAGE_FROM_DB[data.stage] ?? data.stage,
    contacts: (contactLinks.data ?? []).map((r: { contacts: unknown }) => r.contacts),
    companies: (companyLinks.data ?? []).map((r: { companies: unknown }) => r.companies),
    tags: (tagRows.data ?? []).map((r: { tags: unknown }) => r.tags),
  };
}

export const createProjectSchema = z.object({
  name: z.string().min(1),
  project_type: z.string().default("Other"),
  stage: z.enum(PROJECT_STAGES).default("Identified"),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  invested_volume: z.number().optional().nullable(),
  main_contact_id: z.string().uuid().optional().nullable(),
  contact_ids: z.array(z.string().uuid()).default([]),
  company_ids: z.array(z.string().uuid()).default([]),
  start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function createProject(ctx: Ctx, args: z.infer<typeof createProjectSchema>) {
  const { contact_ids, company_ids, stage, ...fields } = args;
  const { data, error } = await ctx.db
    .from("projects")
    .insert({
      ...fields,
      stage: STAGE_TO_DB[stage] ?? "identified",
      ...agentMeta(),
    })
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

export const updateProjectSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  stage: z.enum(PROJECT_STAGES).optional(),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  invested_volume: z.number().optional().nullable(),
  start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  actual_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  project_type: z.string().optional(),
});

export async function updateProject(ctx: Ctx, args: z.infer<typeof updateProjectSchema>) {
  const { id, stage, ...rest } = args;
  const updates: Record<string, unknown> = { ...rest };
  if (stage) updates.stage = STAGE_TO_DB[stage] ?? stage;
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
