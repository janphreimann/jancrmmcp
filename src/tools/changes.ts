import { z } from "zod";
import type { Ctx } from "../context.js";
import { berlinToIso } from "../berlinTime.js";

// changes_since: one digest across the CRM — what is new or changed since a
// point in time. The work is crm_changes_since() (CRM migration
// 20261107006400): SECURITY INVOKER, so it sees exactly what the caller's RLS
// shows, and the user-bound tables (mail accounts, recordings) are filtered
// to auth.uid() inside as well. chief_changes_since() is not reused: it is
// the Chief's project feed (project activity only, minus the Chief's own
// turn windows, which need chief_state).

/** How far back changes_since looks at most, in days. */
export const CHANGES_MAX_DAYS = 90;

export const changesSinceSchema = z.object({
  since: z.string().describe(`Point in time: ISO timestamp or YYYY-MM-DD (Berlin midnight); at most ${CHANGES_MAX_DAYS} days back`),
  top: z.number().int().min(1).max(10).default(5).describe("Newest items listed per area (counts are always complete)"),
});

export function changesSinceArg(since: string, now = new Date()): string {
  const iso = /^\d{4}-\d{2}-\d{2}$/.test(since)
    ? berlinToIso(since)
    : (() => {
        const t = Date.parse(since);
        if (Number.isNaN(t)) throw new Error(`"${since}" is not a date (YYYY-MM-DD) or ISO timestamp.`);
        return new Date(t).toISOString();
      })();
  if (Date.parse(iso) > now.getTime()) throw new Error("`since` lies in the future.");
  if (now.getTime() - Date.parse(iso) > CHANGES_MAX_DAYS * 86_400_000) {
    throw new Error(`\`since\` is too far back — at most ${CHANGES_MAX_DAYS} days.`);
  }
  return iso;
}

export async function changesSince(ctx: Ctx, args: z.infer<typeof changesSinceSchema>) {
  const since = changesSinceArg(args.since);
  const { data, error } = await ctx.db.rpc("crm_changes_since", { p_since: since, p_top: args.top ?? 5 });
  if (error) throw new Error(error.message);
  return data;
}
