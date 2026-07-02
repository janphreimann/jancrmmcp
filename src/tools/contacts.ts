import { z } from "zod";
import { supabase, ORG_ID, agentMeta } from "../supabase.js";

export const searchContactsSchema = z.object({
  query: z.string().optional().describe("Text to search across first_name, last_name, email"),
  company_id: z.string().uuid().optional().describe("Filter by company UUID"),
  tag_ids: z.array(z.string().uuid()).optional().describe("Filter by tag UUIDs"),
  source: z.string().optional().describe("Filter by source (e.g. Referral, Conference / Event)"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchContacts(args: z.infer<typeof searchContactsSchema>) {
  let q = supabase
    .from("contacts")
    .select(
      "id, first_name, last_name, email_1, phone_1, job_title, company_id, source, companies:company_id(id, name)"
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
  if (args.source) q = q.eq("source", args.source);

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
  salutation: z.enum(["Mr.", "Ms.", "Dr.", "Prof.", "Prof. Dr."]).optional().nullable(),
  suffix: z.string().optional().nullable(),
  email_1: z.string().email().optional().nullable(),
  email_1_label: z.enum(["Work", "Personal", "Other"]).optional().nullable(),
  email_2: z.string().email().optional().nullable(),
  email_2_label: z.enum(["Work", "Personal", "Other"]).optional().nullable(),
  phone_1: z.string().optional().nullable(),
  phone_1_label: z.enum(["Mobile", "Work", "Home", "Other"]).optional().nullable(),
  phone_2: z.string().optional().nullable(),
  phone_2_label: z.enum(["Mobile", "Work", "Home", "Other"]).optional().nullable(),
  phone_3: z.string().optional().nullable(),
  job_title: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  notes: z.string().optional().nullable(),
  tag_ids: z.array(z.string().uuid()).optional(),
});

export async function createContact(args: z.infer<typeof createContactSchema>) {
  const { tag_ids, ...fields } = args;
  const { data, error } = await supabase
    .from("contacts")
    .insert({ ...fields, organization_id: ORG_ID, ...agentMeta() })
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
  salutation: z.enum(["Mr.", "Ms.", "Dr.", "Prof.", "Prof. Dr."]).optional().nullable(),
  suffix: z.string().optional().nullable(),
  email_1: z.string().email().optional().nullable(),
  email_1_label: z.enum(["Work", "Personal", "Other"]).optional().nullable(),
  email_2: z.string().email().optional().nullable(),
  email_2_label: z.enum(["Work", "Personal", "Other"]).optional().nullable(),
  phone_1: z.string().optional().nullable(),
  phone_1_label: z.enum(["Mobile", "Work", "Home", "Other"]).optional().nullable(),
  phone_2: z.string().optional().nullable(),
  phone_2_label: z.enum(["Mobile", "Work", "Home", "Other"]).optional().nullable(),
  phone_3: z.string().optional().nullable(),
  job_title: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  linkedin_url: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  notes: z.string().optional().nullable(),
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
