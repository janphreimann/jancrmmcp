import type { Ctx } from "../context.js";

/**
 * A user term for `.ilike(column, `%${term}%`)`: `%` and `_` are LIKE
 * wildcards and `\` is LIKE's escape character, so all three are escaped;
 * PostgREST also reads `*` as `%` before Postgres sees the pattern, which no
 * escape survives — it is dropped. Not for `.or()` strings, which split on
 * commas and parentheses (those strip the term, see orTerm in mail.ts).
 */
export function escapeLike(term: string): string {
  return term.replace(/\*/g, " ").replace(/[\\%_]/g, (c) => `\\${c}`).trim();
}

/** Ids per `.in("id", …)` request — keeps the URL well under PostgREST's limits. */
export const IN_CHUNK = 200;

export function chunk<T>(items: T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** PostgREST answers at most this many rows per request (Supabase's max-rows). */
const PAGE = 1000;

/**
 * Ids of the contacts that carry every one of `tagIds`. Read page by page, so
 * a tag on more than 1000 contacts is not cut off by PostgREST's row cap.
 */
export async function contactIdsWithAllTags(ctx: Ctx, tagIds: string[]): Promise<Set<string>> {
  let result: Set<string> | null = null;
  for (const tagId of [...new Set(tagIds)]) {
    const found = new Set<string>();
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await ctx.db
        .from("contact_tags")
        .select("contact_id")
        .eq("tag_id", tagId)
        .order("contact_id")
        .range(from, from + PAGE - 1);
      if (error) throw new Error(error.message);
      for (const r of data ?? []) if (!result || result.has(r.contact_id)) found.add(r.contact_id);
      if ((data ?? []).length < PAGE) break;
    }
    result = found;
    if (result.size === 0) break;
  }
  return result ?? new Set();
}
