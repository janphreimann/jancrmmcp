import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";

export const searchContactsSchema = z.object({
  query: z.string().optional().describe("Fuzzy search across first name, last name and email — tolerates typos and word-order variants (e.g. 'Schiller Benjamin' or 'Beniamin Schiler')"),
  company_id: z.string().uuid().optional().describe("Filter by company UUID"),
  tag_ids: z.array(z.string().uuid()).optional().describe("Filter by tag UUIDs"),
  source: z.string().optional().describe("Filter by source (e.g. Referral, Conference / Event)"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchContacts(ctx: Ctx, args: z.infer<typeof searchContactsSchema>) {
  let contacts: Array<Record<string, unknown>>;

  if (args.query) {
    const { data, error } = await ctx.db.rpc("search_contacts_smart", {
      p_query: args.query,
      p_org_id: ctx.orgId,
      p_limit: args.limit,
    });
    if (error) throw new Error(error.message);

    contacts = (data ?? []).map((c: Record<string, unknown>) => ({
      id: c.id,
      first_name: c.first_name,
      last_name: c.last_name,
      email_1: c.email_1,
      phone_1: c.phone_1,
      job_title: c.job_title,
      company_id: c.company_id,
      companies: c.company_id ? { id: c.company_id, name: c.company_name } : null,
      source: c.source,
      match_score: c.match_score,
    }));

    if (args.company_id) contacts = contacts.filter((c) => c.company_id === args.company_id);
    if (args.source) contacts = contacts.filter((c) => c.source === args.source);
  } else {
    let q = ctx.db
      .from("contacts")
      .select(
        "id, first_name, last_name, email_1, phone_1, job_title, company_id, source, companies:company_id(id, name)"
      )
      .is("deleted_at", null)
      .order("last_name")
      .limit(args.limit);

    if (args.company_id) q = q.eq("company_id", args.company_id);
    if (args.source) q = q.eq("source", args.source);

    const { data, error } = await q;
    if (error) throw new Error(error.message);
    contacts = data ?? [];
  }

  if (args.tag_ids && args.tag_ids.length > 0) {
    const { data: tagLinks } = await ctx.db
      .from("contact_tags")
      .select("contact_id, tag_id")
      .in("tag_id", args.tag_ids);

    const tagCount: Record<string, number> = {};
    (tagLinks ?? []).forEach((l: { contact_id: string; tag_id: string }) => {
      tagCount[l.contact_id] = (tagCount[l.contact_id] || 0) + 1;
    });
    const required = args.tag_ids.length;
    contacts = contacts.filter((c) => (tagCount[c.id as string] || 0) >= required);
  }

  return contacts;
}

export const getContactSchema = z.object({
  id: z.string().uuid(),
});

export async function getContact(ctx: Ctx, args: z.infer<typeof getContactSchema>) {
  const { data, error } = await ctx.db
    .from("contacts")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: tagRows } = await ctx.db
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
  date_of_birth: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  nationality: z.string().optional().nullable(),
  preferred_language: z.enum(["German", "English", "French", "Spanish", "Italian", "Other"]).optional().nullable(),
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
  website: z.string().optional().nullable(),
  address_street: z.string().optional().nullable(),
  address_extra: z.string().optional().nullable(),
  address_zip: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_state: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  notes: z.string().optional().nullable(),
  tag_ids: z.array(z.string().uuid()).optional(),
});

export async function createContact(ctx: Ctx, args: z.infer<typeof createContactSchema>) {
  const { tag_ids, ...fields } = args;
  // organization_id setzt der BEFORE-INSERT-Trigger aus auth.uid() — nie von
  // hier aus, sonst hinge die Zuordnung wieder am Client.
  const { data, error } = await ctx.db
    .from("contacts")
    .insert({ ...fields, ...agentMeta() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (tag_ids && tag_ids.length > 0) {
    await ctx.db
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
  date_of_birth: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  nationality: z.string().optional().nullable(),
  preferred_language: z.enum(["German", "English", "French", "Spanish", "Italian", "Other"]).optional().nullable(),
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
  website: z.string().optional().nullable(),
  address_street: z.string().optional().nullable(),
  address_extra: z.string().optional().nullable(),
  address_zip: z.string().optional().nullable(),
  address_city: z.string().optional().nullable(),
  address_state: z.string().optional().nullable(),
  address_country: z.string().optional().nullable(),
  source: z.enum(["Personal Meeting", "Referral", "Conference / Event", "Online / Social Media", "Work", "Import", "Other"]).optional().nullable(),
  notes: z.string().optional().nullable(),
});

export async function updateContact(ctx: Ctx, args: z.infer<typeof updateContactSchema>) {
  const { id, ...updates } = args;
  const { data, error } = await ctx.db
    .from("contacts")
    .update(updates)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  // Eine fremde UUID trifft durch die Policy auf null Zeilen. Ohne diese
  // Prüfung meldete das Tool trotzdem Erfolg.
  if (!data?.length) throw new Error(`Contact ${id} not found`);
  return { id, message: "Contact updated successfully" };
}
