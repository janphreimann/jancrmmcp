import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";

export const searchContactsSchema = z.object({
  query: z.string().optional().describe("Text to search across first_name, last_name, email"),
  company_id: z.string().uuid().optional().describe("Filter by company UUID"),
  tag_ids: z.array(z.string().uuid()).optional().describe("Filter by tag UUIDs"),
  contact_type: z.string().optional(),
  rating: z.enum(["A", "B", "C", "D"]).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchContacts(args: z.infer<typeof searchContactsSchema>) {
  let q = supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email_1, phone_1, job_title, company_id, rating, contact_type, companies:company_id(id, name)"
    )
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .order("last_name")
    .limit(args.limit);

  if (args.query) {
    q = q.or(
      `first_name.ilike.%${args.query}%,last_name.ilike.%${args.query}%,email_1.ilike.%${args.query}%`
    );
  }
  if (args.company_id) q = q.eq("company_id", args.company_id);
  if (args.contact_type) q = q.eq("contact_type", args.contact_type);
  if (args.rating) q = q.eq("rating", args.rating);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let contacts = data ?? [];

  if (args.tag_ids && args.tag_ids.length > 0) {
    const { data: tagLinks } = await supabase
      .from("contact_tags")
      .select("contact_id, tag_id")
      .in("tag_id", args.tag_ids);

    const tagCount: Record<string, number> = {};
    (tagLinks ?? []).forEach((l: { contact_id: string; tag_id: string }) => {
      tagCount[l.contact_id] = (tagCount[l.contact_id] || 0) + 1;
    });
    const required = args.tag_ids.length;
    contacts = contacts.filter((c: { id: string }) => (tagCount[c.id] || 0) >= required);
  }

  return contacts;
}

export const getContactSchema = z.object({
  id: z.string().uuid(),
});

export async function getContact(args: z.infer<typeof getContactSchema>) {
  const { data, error } = await supabase
    .from("contacts")
    .select("*")
    .eq("id", args.id)
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: tagRows } = await supabase
    .from("contact_tags")
    .select("tag_id, tags:tag_id(id, name, color)")
    .eq("contact_id", args.id);

  return { ...data, tags: (tagRows ?? []).map((r: { tags: unknown }) => r.tags) };
}

export const createContactSchema = z.object({
  first_name: z.string().min(1),
  last_name: z.string().min(1),
  email_1: z.string().email().optional().nullable(),
  phone_1: z.string().optional().nullable(),
  job_title: z.string().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  contact_type: z.string().optional().nullable(),
  rating: z.enum(["A", "B", "C", "D"]).optional().nullable(),
  tag_ids: z.array(z.string().uuid()).optional(),
  notes: z.string().optional().nullable().describe("Internal notes"),
});

export async function createContact(args: z.infer<typeof createContactSchema>) {
  const { tag_ids, notes, ...fields } = args;
  const { data, error } = await supabase
    .from("contacts")
    .insert({ ...fields, internal_notes: notes ?? null, organization_id: ORG_ID })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (tag_ids && tag_ids.length > 0) {
    await supabase
      .from("contact_tags")
      .insert(tag_ids.map((tid) => ({ contact_id: data.id, tag_id: tid })));
  }
  return { id: data.id, message: "Contact created successfully" };
}

export const updateContactSchema = z.object({
  id: z.string().uuid(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  email_1: z.string().email().optional().nullable(),
  phone_1: z.string().optional().nullable(),
  job_title: z.string().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  contact_type: z.string().optional().nullable(),
  rating: z.enum(["A", "B", "C", "D"]).optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  do_not_contact: z.boolean().optional(),
});

export async function updateContact(args: z.infer<typeof updateContactSchema>) {
  const { id, ...updates } = args;
  const { error } = await supabase
    .from("contacts")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", ORG_ID!);
  if (error) throw new Error(error.message);
  return { id, message: "Contact updated successfully" };
}
