import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";

export const searchInitiativesSchema = z.object({
  query: z.string().optional().describe("Case-insensitive substring match on the initiative name"),
  status: z.enum(["active", "paused", "done"]).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});

export async function searchInitiatives(ctx: Ctx, args: z.infer<typeof searchInitiativesSchema>) {
  let q = ctx.db
    .from("initiatives")
    .select("id, name, description, status, target_date, created_at")
    .order("created_at", { ascending: false })
    .limit(args.limit);
  if (args.query) q = q.ilike("name", `%${args.query}%`);
  if (args.status) q = q.eq("status", args.status);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const getInitiativeSchema = z.object({
  id: z.string().uuid(),
});

export async function getInitiative(ctx: Ctx, args: z.infer<typeof getInitiativeSchema>) {
  const { data, error } = await ctx.db
    .from("initiatives")
    .select("*")
    .eq("id", args.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const { data: projects } = await ctx.db
    .from("projects")
    .select("id, name, stage")
    .eq("initiative_id", args.id)
    .is("deleted_at", null);

  return { ...data, projects: projects ?? [] };
}

export const createInitiativeSchema = z.object({
  name: z.string().min(1),
  description: z.string().default("").describe("What this initiative is and what success looks like"),
  status: z.enum(["active", "paused", "done"]).default("active"),
  target_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function createInitiative(ctx: Ctx, args: z.infer<typeof createInitiativeSchema>) {
  const { data, error } = await ctx.db
    .from("initiatives")
    .insert({ ...args, created_by: ctx.userId, ...agentMeta() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Initiative created successfully" };
}

export const updateInitiativeSchema = z.object({
  id: z.string().uuid(),
  name: z.string().optional(),
  description: z.string().optional(),
  status: z.enum(["active", "paused", "done"]).optional(),
  target_date: z.string().optional().nullable().describe("ISO date YYYY-MM-DD"),
});

export async function updateInitiative(ctx: Ctx, args: z.infer<typeof updateInitiativeSchema>) {
  const { id, ...updates } = args;
  const { data, error } = await ctx.db.from("initiatives").update(updates).eq("id", id).select("id");
  if (error) throw new Error(error.message);
  // A foreign UUID matches zero rows through the policy — without this check
  // the tool would still report success.
  if (!data?.length) throw new Error(`Initiative ${id} not found`);
  return { id, message: "Initiative updated successfully" };
}

export const suggestNextStepSchema = z.object({
  project_id: z.string().uuid(),
  title: z.string().min(1).describe("A short, actionable next step — phrased like a task title"),
  rationale: z.string().default("").describe("One or two sentences: why this, why now"),
});

/**
 * A structured, unconfirmed suggestion rather than free prose in the journal
 * or brief — the user reviews it in the CRM UI and either turns it into a
 * real task or dismisses it. Check open_next_steps in get_project's response
 * first so you don't suggest something already decided.
 */
export async function suggestNextStep(ctx: Ctx, args: z.infer<typeof suggestNextStepSchema>) {
  const { data, error } = await ctx.db
    .from("project_next_steps")
    .insert({ ...args, created_by: ctx.userId, ...agentMeta() })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Next step suggested — awaiting user review" };
}
