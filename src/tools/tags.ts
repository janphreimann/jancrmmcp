import { z } from "zod";
import { supabase, ORG_ID } from "../supabase.js";
import { STAGE_FROM_DB } from "../constants.js";

export const listTagsSchema = z.object({});

export async function listTags() {
  const { data, error } = await supabase
    .from("tags")
    .select("id, name, color")
    .eq("organization_id", ORG_ID!)
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const addTagToEntitySchema = z.object({
  entity_type: z.enum(["contact", "company", "deal"]),
  entity_id: z.string().uuid(),
  tag_id: z.string().uuid(),
});

export async function addTagToEntity(args: z.infer<typeof addTagToEntitySchema>) {
  const tableMap = {
    contact: "contact_tags",
    company: "company_tags",
    deal: "deal_tags",
  } as const;
  const colMap = {
    contact: "contact_id",
    company: "company_id",
    deal: "deal_id",
  } as const;

  const table = tableMap[args.entity_type];
  const col = colMap[args.entity_type];

  const { error } = await supabase
    .from(table as string)
    .upsert({ [col]: args.entity_id, tag_id: args.tag_id });
  if (error) throw new Error(error.message);
  return { message: `Tag added to ${args.entity_type}` };
}

export const getPipelineStatsSchema = z.object({});

export async function getPipelineStats() {
  const { data: deals, error } = await supabase
    .from("deals")
    .select("stage, target_volume")
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  const stats: Record<string, { count: number; total_volume: number }> = {};
  (deals ?? []).forEach((d: { stage: string; target_volume: number | null }) => {
    const stage = STAGE_FROM_DB[d.stage] ?? d.stage ?? "Unknown";
    if (!stats[stage]) stats[stage] = { count: 0, total_volume: 0 };
    stats[stage].count++;
    stats[stage].total_volume += d.target_volume ?? 0;
  });

  const { count: contactCount } = await supabase
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null);

  const { count: companyCount } = await supabase
    .from("companies")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null);

  const { count: openTaskCount } = await supabase
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .neq("status", "completed");

  return {
    deals_by_stage: stats,
    total_contacts: contactCount ?? 0,
    total_companies: companyCount ?? 0,
    open_tasks: openTaskCount ?? 0,
  };
}
