import { z } from "zod";
import type { Ctx } from "../context.js";
import { renderBriefing, type Briefing } from "../briefing.js";
import { isNotFoundError } from "./dbErrors.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const openProjectSchema = z.object({
  query: z.string().min(1).describe(
    "Project name (fuzzy, typos tolerated) or UUID. If several projects match you get a list back — ask the user which one, never guess."
  ),
});

type Hit = { id: string; name: string; match_score: number; stage?: string; initiative_id?: string | null; updated_at?: string };

/**
 * Opens on one hit, or on a clear winner (score ≥ 0.6 and more than 0.25
 * ahead of the runner-up). Anything else is a list for the user to
 * disambiguate — never a silent LIMIT 1.
 */
export function resolveProjectQuery(hits: Hit[]): { kind: "none" } | { kind: "one"; id: string } | { kind: "many" } {
  if (hits.length === 0) return { kind: "none" };
  if (hits.length === 1) return { kind: "one", id: hits[0].id };
  const [top, second] = hits;
  if (top.match_score >= 0.6 && top.match_score - second.match_score > 0.25) return { kind: "one", id: top.id };
  return { kind: "many" };
}

export async function openProject(ctx: Ctx, args: z.infer<typeof openProjectSchema>): Promise<string> {
  let projectId: string | null = null;
  const q = args.query.trim();

  if (UUID_RE.test(q)) {
    projectId = q;
  } else {
    const { data, error } = await ctx.db.rpc("search_projects_smart", { p_query: q, p_org_id: ctx.orgId, p_limit: 6 });
    if (error) throw new Error(error.message);
    const hits = (data ?? []) as Hit[];
    const r = resolveProjectQuery(hits);
    if (r.kind === "none") {
      return `No project matches "${q}". Try search_projects with a shorter query, or create_project.`;
    }
    if (r.kind === "many") {
      const initiativeIds = [...new Set(hits.map((h) => h.initiative_id).filter(Boolean))] as string[];
      const { data: inits } = initiativeIds.length
        ? await ctx.db.from("initiatives").select("id, name").in("id", initiativeIds)
        : { data: [] as { id: string; name: string }[] };
      const initName = new Map((inits ?? []).map((i: { id: string; name: string }) => [i.id, i.name]));
      const lines = hits.map((h) => {
        const bits = [h.stage, h.initiative_id ? initName.get(h.initiative_id) : null, h.updated_at ? `updated ${h.updated_at.slice(0, 10)}` : null]
          .filter(Boolean).join(", ");
        return `- **${h.name}** (${bits}) — ${h.id}`;
      });
      return ["Several projects match — ask the user which one and call open_project with the id.", ...lines].join("\n");
    }
    projectId = r.id;
  }

  const { data: since, error: stampErr } = await ctx.db.rpc("stamp_project_visit", { p_project_id: projectId, p_channel: "mcp" });
  if (stampErr) {
    // A foreign/unknown id fails the FK (23503), the RLS WITH CHECK (42501),
    // or (P0001) the `set_organization_id_from_project()` trigger's own
    // RAISE for a nonexistent project — stamp_project_visit itself has no
    // RAISE. Same message as "not found" so the answer is not an oracle for
    // which ids exist. Anything else is a real fault (network, revoked
    // grant, misconfig) and must surface as such.
    if (isNotFoundError(stampErr)) return "No project with that id (or you have no access).";
    throw new Error(stampErr.message);
  }

  const { data: briefing, error } = await ctx.db.rpc("get_project_briefing", { p_project_id: projectId, p_since: since ?? null });
  if (error) throw new Error(error.message);
  if (!briefing) return "No project with that id (or you have no access).";

  return renderBriefing(briefing as Briefing, new Date());
}
