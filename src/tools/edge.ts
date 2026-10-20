import { supabaseUrl } from "../supabase.js";
import type { Ctx } from "../context.js";

/**
 * Calls a CRM edge function with the caller's own JWT (never the service
 * key): the function resolves the user itself via getUser() and checks
 * ownerSessionOk(), which accepts registered MCP sessions.
 *
 * Retries once on 503 — platform-level gateway errors (cold-start crash,
 * transient overload) return a fast 503 with HTML before the function code
 * even runs. Any other status is the function's own answer and is returned
 * as is; the caller decides what an error means.
 */
export async function callEdgeFunction<T = Record<string, unknown>>(
  ctx: Ctx,
  name: string,
  body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<{ status: number; ok: boolean; json: T }> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 30_000);
    let resp: Response;
    try {
      resp = await fetch(`${supabaseUrl}/functions/v1/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${ctx.accessToken}` },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 503 && attempt === 1) {
      await resp.body?.cancel();
      await new Promise((r) => setTimeout(r, 2_000));
      continue;
    }

    const rawText = await resp.text();
    try {
      return { status: resp.status, ok: resp.ok, json: JSON.parse(rawText) as T };
    } catch {
      const preview = rawText.slice(0, 200).trim();
      throw new Error(
        resp.status === 503 && !preview
          ? "Edge function returned 503 on both attempts — Supabase platform may be degraded"
          : `Edge function returned non-JSON (HTTP ${resp.status}): ${preview}`
      );
    }
  }
  throw new Error("Edge function returned 503 on both attempts — Supabase platform may be degraded");
}
