import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";

export const searchCompaniesSchema = z.object({
  query: z.string().optional().describe("Fuzzy search in company name — tolerates typos (e.g. 'Exalon' finds 'Exaloan')"),
  industry: z.string().optional().describe("Filter by industry (e.g. Technology, Financial Services)"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchCompanies(ctx: Ctx, args: z.infer<typeof searchCompaniesSchema>) {
  if (args.query) {
    const { data, error } = await ctx.db.rpc("search_companies_smart", {
      p_query: args.query,
      p_org_id: ctx.orgId,
      p_limit: args.limit,
    });
    if (error) throw new Error(error.message);

    let companies: Array<Record<string, unknown>> = data ?? [];
    if (args.industry) companies = companies.filter((c) => c.industry === args.industry);
    return companies;
  }

  let q = ctx.db
    .from("companies")
    .select("id, name, industry, website, address_city, address_country")
    .is("deleted_at", null)
    .order("name")
    .limit(args.limit);

  if (args.industry) q = q.eq("industry", args.industry);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const getCompanySchema = z.object({
  id: z.string().uuid(),
});

export async function getCompany(ctx: Ctx, args: z.infer<typeof getCompanySchema>) {
  const { data, error } = await ctx.db
    .from("companies")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: tagRows } = await ctx.db
    .from("company_tags")
    .select("tag_id, tags:tag_id(id, name, color)")
    .eq("company_id", args.id);

  const { data: contacts } = await ctx.db
    .from("contacts")
    .select("id, first_name, last_name, job_title")
    .eq("company_id", args.id)
    .is("deleted_at", null);

  return {
    ...data,
    tags: (tagRows ?? []).map((r: { tags: unknown }) => r.tags),
    contacts: contacts ?? [],
  };
}

export const createCompanySchema = z.object({
  name: z.string().min(1),
  industry: z.enum(["Technology", "Financial Services", "Healthcare", "Media & Entertainment", "Retail & Consumer", "Industrials", "Real Estate", "Energy", "Education", "Transport & Logistics", "Non-profit / NGO", "Other"]).optional().nullable(),
  sub_industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  founded_year: z.number().int().optional().nullable(),
  employee_range: z.enum(["1–10", "11–50", "51–200", "201–1,000", "> 1,000", "Unknown"]).optional().nullable(),
  address_street: z.string().optional().nullable(),
  address_extra: z.string().optional().nullable(),
  address_zip: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_state: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  tag_ids: z.array(z.string().uuid()).optional(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function createCompany(ctx: Ctx, args: z.infer<typeof createCompanySchema>) {
  const { tag_ids, ...fields } = args;
  const { data, error } = await ctx.db
    .from("companies")
    .insert({ ...fields, ...agentMeta() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (tag_ids && tag_ids.length > 0) {
    await ctx.db
      .from("company_tags")
      .insert(tag_ids.map((tid) => ({ company_id: data.id, tag_id: tid })));
  }
  return { id: data.id, message: "Company created successfully" };
}

export const updateCompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  industry: z.enum(["Technology", "Financial Services", "Healthcare", "Media & Entertainment", "Retail & Consumer", "Industrials", "Real Estate", "Energy", "Education", "Transport & Logistics", "Non-profit / NGO", "Other"]).optional().nullable(),
  sub_industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  founded_year: z.number().int().optional().nullable(),
  employee_range: z.enum(["1–10", "11–50", "51–200", "201–1,000", "> 1,000", "Unknown"]).optional().nullable(),
  address_street: z.string().optional().nullable(),
  address_extra: z.string().optional().nullable(),
  address_zip: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_state: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function updateCompany(ctx: Ctx, args: z.infer<typeof updateCompanySchema>) {
  const { id, ...updates } = args;
  const { data, error } = await ctx.db
    .from("companies")
    .update(updates)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  // Eine fremde UUID trifft durch die Policy auf null Zeilen. Ohne diese
  // Prüfung meldete das Tool trotzdem Erfolg.
  if (!data?.length) throw new Error(`Company ${id} not found`);
  return { id, message: "Company updated successfully" };
}
