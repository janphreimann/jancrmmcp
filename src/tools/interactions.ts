import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";
import { INTERACTION_TYPES } from "../constants.js";

export const createInteractionSchema = z.object({
  type: z.enum(INTERACTION_TYPES),
  date: z.string().describe("ISO date YYYY-MM-DD"),
  title: z.string().min(1),
  content: z.string().optional().nullable().describe("Notes / summary of the interaction"),
  next_steps: z.string().optional().nullable(),
  internal_notes: z.string().optional().nullable(),
  sentiment: z.string().optional().nullable().describe("e.g. Positive, Neutral, Negative"),
  contact_ids: z.array(z.string().uuid()).default([]),
  company_ids: z.array(z.string().uuid()).default([]),
  deal_id: z.string().uuid().optional().nullable(),
  duration_min: z.number().int().optional().nullable(),
});

export async function createInteraction(args: z.infer<typeof createInteractionSchema>) {
  const { contact_ids, company_ids, ...fields } = args;
  const { data, error } = await supabase
    .from("interactions")
    .insert({ ...fields, organization_id: ORG_ID })
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  if (contact_ids.length > 0) {
    await supabase
      .from("interaction_contacts")
      .insert(contact_ids.map((cid) => ({ interaction_id: data.id, contact_id: cid })));
  }
  if (company_ids.length > 0) {
    await supabase
      .from("interaction_companies")
      .insert(company_ids.map((cid) => ({ interaction_id: data.id, company_id: cid })));
  }
  return { id: data.id, message: "Interaction logged successfully" };
}
