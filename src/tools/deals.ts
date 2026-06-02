import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";
import { STAGE_TO_DB, STAGE_FROM_DB, DEAL_STAGES } from "../constants.js";

export const searchDealsSchema = z.object({
  query: z.string().optional().describe("Search in deal name"),
  stage: z.enum(DEAL_STAGES).optional(),
  deal_type: z.string().optional(),
  contact_id: z.string().uuid().optional().describe("Filter to deals linked to this contact"),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchDeals(args: z.infer<typeof searchDealsSchema>) {
  let q = supabase
    .from("deals")
    .select("id, name, stage, deal_type, priority, target_volume, currency, main_contact_id, created_at")
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(args.limit);

  if (args.query) q = q.ilike("name", `%${args.query}%`);
  if (args.stage) q = q.eq("stage", STAGE_TO_DB[args.stage] ?? args.stage);
  if (args.deal_type) q = q.eq("deal_type", args.deal_type);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  let deals: Array<Record<string, unknown>> = (data ?? []).map(
    (d: { stage: string; [key: string]: unknown }) => ({
      ...d,
      stage: STAGE_FROM_DB[d.stage] ?? d.stage,
    })
  );

  if (args.contact_id) {
    const { data: links } = await supabase
      .from("deal_contacts")
      .select("deal_id")
      .eq("contact_id", args.contact_id);
    const dealIds = new Set((links ?? []).map((l: { deal_id: string }) => l.deal_id));
    deals = deals.filter((d) => dealIds.has(d["id"] as string));
  }

  return deals;
}

export const createDealSchema = z.object({
  name: z.string().min(1),
  deal_type: z.string().default("Other"),
  stage: z.enum(DEAL_STAGES).default("Identified"),
  priority: z.enum(["High", "Medium", "Low"]).default("Medium"),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  currency: z.enum(["EUR", "USD", "GBP", "CHF", "JPY"]).default("EUR"),
  main_contact_id: z.string().uuid().optional().nullable(),
  contact_ids: z.array(z.string().uuid()).default([]),
  company_ids: z.array(z.string().uuid()).default([]),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function createDeal(args: z.infer<typeof createDealSchema>) {
  const { contact_ids, company_ids, stage, ...fields } = args;
  const { data, error } = await supabase
    .from("deals")
    .insert({
      ...fields,
      stage: STAGE_TO_DB[stage] ?? "identified",
      organization_id: ORG_ID,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const allContactIds = Array.from(
    new Set([...(fields.main_contact_id ? [fields.main_contact_id] : []), ...contact_ids])
  );
  if (allContactIds.length > 0) {
    await supabase
      .from("deal_contacts")
      .insert(allContactIds.map((cid) => ({ deal_id: data.id, contact_id: cid })));
  }
  if (company_ids.length > 0) {
    await supabase
      .from("deal_companies")
      .insert(company_ids.map((cid) => ({ deal_id: data.id, company_id: cid })));
  }
  return { id: data.id, message: "Deal created successfully" };
}

export const updateDealSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  stage: z.enum(DEAL_STAGES).optional(),
  priority: z.enum(["High", "Medium", "Low"]).optional(),
  description: z.string().optional().nullable(),
  target_volume: z.number().optional().nullable(),
  expected_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  actual_close_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
  deal_type: z.string().optional(),
});

export async function updateDeal(args: z.infer<typeof updateDealSchema>) {
  const { id, stage, ...rest } = args;
  const updates: Record<string, unknown> = { ...rest };
  if (stage) updates.stage = STAGE_TO_DB[stage] ?? stage;
  const { error } = await supabase
    .from("deals")
    .update(updates)
    .eq("id", id)
    .eq("organization_id", ORG_ID!);
  if (error) throw new Error(error.message);
  return { id, message: "Deal updated successfully" };
}
