import { z } from "zod";
import type { Ctx } from "../context.js";

// The Chief's overview (CRM migration 20261107000000_chief_agent.sql). The
// function is SECURITY INVOKER and this client carries the caller's token,
// so RLS decides what is in it — system agents, the caller's own agents,
// the caller's organization's projects and tasks.
export const getOverviewSchema = z.object({}).strict();

export async function getOverview(ctx: Ctx, _args: z.infer<typeof getOverviewSchema>) {
  const { data, error } = await ctx.db.rpc("get_chief_overview");
  if (error) throw new Error(`Could not load the overview: ${error.message}`);
  return data;
}
