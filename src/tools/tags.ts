import { z } from "zod";
import type { Ctx } from "../context.js";
import { STAGE_FROM_DB } from "../constants.js";

export const listTagsSchema = z.object({});

export async function listTags(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from("tags")
    .select("id, name, color")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const addTagToEntitySchema = z.object({
  entity_type: z.enum(["contact", "company", "project"]),
  entity_id: z.string().uuid(),
  tag_id: z.string().uuid(),
});

export async function addTagToEntity(ctx: Ctx, args: z.infer<typeof addTagToEntitySchema>) {
  const tableMap = {
    contact: "contact_tags",
    company: "company_tags",
    project: "project_tags",
  } as const;
  const colMap = {
    contact: "contact_id",
    company: "company_id",
    project: "project_id",
  } as const;

  const table = tableMap[args.entity_type];
  const col = colMap[args.entity_type];

  // Der Trigger leitet die Organisation der Verknüpfung aus der Elternzeile ab,
  // eine fremde entity_id scheitert also am WITH CHECK der Policy. Der Tag
  // dagegen hängt an keinem Elternteil — ohne diese Prüfung ließe sich eine
  // fremde tag_id an einen eigenen Datensatz hängen.
  const { data: tag } = await ctx.db
    .from("tags").select("id").eq("id", args.tag_id).maybeSingle();
  if (!tag) throw new Error(`Tag ${args.tag_id} not found`);

  const { error } = await ctx.db
    .from(table as string)
    .upsert({ [col]: args.entity_id, tag_id: args.tag_id });
  if (error) throw new Error(`Could not tag ${args.entity_type} ${args.entity_id}: ${error.message}`);
  return { message: `Tag added to ${args.entity_type}` };
}

export const getPipelineStatsSchema = z.object({});

export async function getPipelineStats(ctx: Ctx) {
  const { data: projects, error } = await ctx.db
    .from("projects")
    .select("stage, target_volume")
    .is("deleted_at", null);
  if (error) throw new Error(error.message);

  const stats: Record<string, { count: number; total_volume: number }> = {};
  (projects ?? []).forEach((d: { stage: string; target_volume: number | null }) => {
    const stage = STAGE_FROM_DB[d.stage] ?? d.stage ?? "Unknown";
    if (!stats[stage]) stats[stage] = { count: 0, total_volume: 0 };
    stats[stage].count++;
    stats[stage].total_volume += d.target_volume ?? 0;
  });

  const { count: contactCount } = await ctx.db
    .from("contacts")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null);

  const { count: companyCount } = await ctx.db
    .from("companies")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null);

  const { count: openTaskCount } = await ctx.db
    .from("tasks")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null)
    .neq("status", "completed");

  return {
    projects_by_stage: stats,
    total_contacts: contactCount ?? 0,
    total_companies: companyCount ?? 0,
    open_tasks: openTaskCount ?? 0,
  };
}
