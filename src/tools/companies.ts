import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";

export const searchCompaniesSchema = z.object({
  query: z.string().optional().describe("Search in company name"),
  company_type: z.string().optional(),
  rating: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchCompanies(args: z.infer<typeof searchCompaniesSchema>) {
  let q = supabase
    .from("companies")
    .select("id, name, company_type, rating, website, address_city, address_country")
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .order("name")
    .limit(args.limit);

  if (args.query) q = q.ilike("name", `%${args.query}%`);
  if (args.company_type) q = q.eq("company_type", args.company_type);
  if (args.rating) q = q.eq("rating", args.rating);

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
  company_type: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  rating: z.string().optional().nullable(),
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
  company_type: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  rating: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  internal_notes: z.string().optional().nullable(),
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
