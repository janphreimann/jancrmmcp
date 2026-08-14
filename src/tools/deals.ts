import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { STAGE_TO_DB, STAGE_FROM_DB, DEAL_STAGES } from "../constants.js";

export const searchDealsSchema = z.object({
  query: z.string().optional().describe("Fuzzy search in deal name — tolerates typos"),
  stage: z.enum(DEAL_STAGES).optional(),
  deal_type: z.string().optional(),
  contact_id: z.string().uuid().optional().describe("Filter to deals linked to this contact"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchDeals(ctx: Ctx, args: z.infer<typeof searchDealsSchema>) {
  let deals: Array<Record<string, unknown>>;

  if (args.query) {
    const { data, error } = await ctx.db.rpc("search_deals_smart", {
      p_query: args.query,
      p_org_id: ctx.orgId,
      p_limit: args.limit,
    });
    if (error) throw new Error(error.message);

    deals = (data ?? []).map((d: { stage: string; [key: string]: unknown }) => ({
      ...d,
      stage: STAGE_FROM_DB[d.stage] ?? d.stage,
    }));

    if (args.stage) deals = deals.filter((d) => d.stage === args.stage);
    if (args.deal_type) deals = deals.filter((d) => d.deal_type === args.deal_type);
  } else {
    let q = ctx.db
      .from("deals")
      .select("id, name, stage, deal_type, target_volume, main_contact_id, created_at")
      .is("deleted_at", null)
      .order("created_at", { ascending: false })
      .limit(args.limit);

    if (args.stage) q = q.eq("stage", STAGE_TO_DB[args.stage] ?? args.stage);
    if (args.deal_type) q = q.eq("deal_type", args.deal_type);

    const { data, error } = await q;
    if (error) throw new Error(error.message);

    deals = (data ?? []).map((d: { stage: string; [key: string]: unknown }) => ({
      ...d,
      stage: STAGE_FROM_DB[d.stage] ?? d.stage,
    }));
  }

  if (args.contact_id) {
    const { data: links } = await ctx.db
      .from("deal_contacts")
      .select("deal_id")
      .eq("contact_id", args.contact_id);
    const dealIds = new Set((links ?? []).map((l: { deal_id: string }) => l.deal_id));
    deals = deals.filter((d) => dealIds.has(d["id"] as string));
  }

  return deals;
}

export const getDealSchema = z.object({
  id: z.string().uuid(),
});

export async function getDeal(ctx: Ctx, args: z.infer<typeof getDealSchema>) {
  const { data, error } = await ctx.db
    .from("deals")
    .select("*")
    .eq("id", args.id)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const [contactLinks, companyLinks, tagRows] = await Promise.all([
    ctx.db
      .from("deal_contacts")
      .select("contact_id, contacts:contact_id(id, first_name, last_name, email_1)")
      .eq("deal_id", args.id),
    ctx.db
      .from("deal_companies")
      .select("company_id, companies:company_id(id, name)")
      .eq("deal_id", args.id),
    ctx.db
      .from("deal_tags")
      .select("tag_id, tags:tag_id(id, name, color)")
      .eq("deal_id", args.id),
  ]);

  return {
    ...data,
    stage: STAGE_FROM_DB[data.stage] ?? data.stage,
    contacts: (contactLinks.data ?? []).map((r: { contacts: unknown }) => r.contacts),
    companies: (companyLinks.data ?? []).map((r: { companies: unknown }) => r.companies),
    tags: (tagRows.data ?? []).map((r: { tags: unknown }) => r.tags),
  };
}

export const createDealSchema = z.object({
  name: z.string().min(1),
  deal_type: z.string().default("Other"),
  stage: z.enum(DEAL_STAGES).default("Identified"),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  invested_volume: z.number().optional().nullable(),
  main_contact_id: z.string().uuid().optional().nullable(),
  contact_ids: z.array(z.string().uuid()).default([]),
  company_ids: z.array(z.string().uuid()).default([]),
  start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function createDeal(ctx: Ctx, args: z.infer<typeof createDealSchema>) {
  const { contact_ids, company_ids, stage, ...fields } = args;
  const { data, error } = await ctx.db
    .from("deals")
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
      .from("deal_contacts")
      .insert(allContactIds.map((cid) => ({ deal_id: data.id, contact_id: cid })));
  }
  if (company_ids.length > 0) {
    await ctx.db
      .from("deal_companies")
      .insert(company_ids.map((cid) => ({ deal_id: data.id, company_id: cid })));
  }
  return { id: data.id, message: "Deal created successfully" };
}

export const updateDealSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  invested_volume: z.number().optional().nullable(),
  start_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  actual_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  deal_type: z.string().optional(),
});

export async function updateDeal(ctx: Ctx, args: z.infer<typeof updateDealSchema>) {
  const { id, stage, ...rest } = args;
  const updates: Record<string, unknown> = { ...rest };
  if (stage) updates.stage = STAGE_TO_DB[stage] ?? stage;
  const { data, error } = await ctx.db
    .from("deals")
    .update(updates)
    .eq("id", id)
    .select("id");
  if (error) throw new Error(error.message);
  // Eine fremde UUID trifft durch die Policy auf null Zeilen. Ohne diese
  // Prüfung meldete das Tool trotzdem Erfolg.
  if (!data?.length) throw new Error(`Deal ${id} not found`);
  return { id, message: "Deal updated successfully" };
}
