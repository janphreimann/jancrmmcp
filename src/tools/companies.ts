import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";

export const searchCompaniesSchema = z.object({
  query: z.string().optional().describe("Fuzzy search in company name and short name — tolerates typos (e.g. 'Exalon' finds 'Exaloan')"),
  industry: z.string().optional().describe("Filter by industry (e.g. Technology, Financial Services)"),
  source: z.string().optional().describe("Filter by source (e.g. Referral, Conference / Event)"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchCompanies(args: z.infer<typeof searchCompaniesSchema>) {
  if (args.query) {
    const { data, error } = await supabase.rpc("search_companies_smart", {
      p_query: args.query,
      p_org_id: ORG_ID,
      p_limit: args.limit,
    });
    if (error) throw new Error(error.message);

    let companies: Array<Record<string, unknown>> = data ?? [];
    if (args.industry) companies = companies.filter((c) => c.industry === args.industry);
    if (args.source) companies = companies.filter((c) => c.source === args.source);
    return companies;
  }

  let q = supabase
    .from("companies")
    .select("id, name, industry, website, address_city, address_country, source")
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .order("name")
    .limit(args.limit);

  if (args.industry) q = q.eq("industry", args.industry);
  if (args.source) q = q.eq("source", args.source);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const getCompanySchema = z.object({
  id: z.string().uuid(),
});

export async function getCompany(args: z.infer<typeof getCompanySchema>) {
  const { data, error } = await supabase
    .from("companies")
    .select("*")
    .eq("id", args.id)
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: tagRows } = await supabase
    .from("company_tags")
    .select("tag_id, tags:tag_id(id, name, color)")
    .eq("company_id", args.id);

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, first_name, last_name, job_title")
    .eq("company_id", args.id)
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null);

  return {
    ...data,
    tags: (tagRows ?? []).map((r: { tags: unknown }) => r.tags),
    contacts: contacts ?? [],
  };
}

export const createCompanySchema = z.object({
  name: z.string().min(1),
  short_name: z.string().optional().nullable(),
  industry: z.enum(["Technology", "Financial Services", "Healthcare", "Media & Entertainment", "Retail & Consumer", "Industrials", "Real Estate", "Energy", "Education", "Transport & Logistics", "Non-profit / NGO", "Other"]).optional().nullable(),
  sub_industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  founded_year: z.number().int().optional().nullable(),
  employee_range: z.enum(["1–10", "11–50", "51–200", "201–1,000", "> 1,000", "Unknown"]).optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: z.string().optional().nullable(),
  tag_ids: z.array(z.string().uuid()).optional(),
  description: z.string().optional().nullable(),
});

export async function createCompany(args: z.infer<typeof createCompanySchema>) {
  const { tag_ids, ...fields } = args;
  const { data, error } = await supabase
    .from("companies")
    .insert({ ...fields, organization_id: ORG_ID })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (tag_ids && tag_ids.length > 0) {
    await supabase
      .from("company_tags")
      .insert(tag_ids.map((tid) => ({ company_id: data.id, tag_id: tid })));
  }
  return { id: data.id, message: "Company created successfully" };
}

export const updateCompanySchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  short_name: z.string().optional().nullable(),
  industry: z.enum(["Technology", "Financial Services", "Healthcare", "Media & Entertainment", "Retail & Consumer", "Industrials", "Real Estate", "Energy", "Education", "Transport & Logistics", "Non-profit / NGO", "Other"]).optional().nullable(),
  sub_industry: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  founded_year: z.number().int().optional().nullable(),
  employee_range: z.enum(["1–10", "11–50", "51–200", "201–1,000", "> 1,000", "Unknown"]).optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  do_not_contact: z.boolean().optional(),
  do_not_contact_reason: z.string().optional().nullable(),
});

export async function updateCompany(args: z.infer<typeof updateCompanySchema>) {
  const { id, ...updates } = args;
  const { error } = await supabase
    .from("companies")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", ORG_ID!);
  if (error) throw new Error(error.message);
  return { id, message: "Company updated successfully" };
}
