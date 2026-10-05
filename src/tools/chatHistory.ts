import { z } from "zod";
import type { Ctx } from "../context.js";
import { formatHistory, type HistoryResult } from "./chatHistoryHelpers.js";

// A chat agent sees its memory plus a sliding window of its own thread every
// turn (the CRM's contextWindow.ts); this is how it reaches what lies before
// that window. No assertOwnOrgAgent() like the other self-management tools:
// that one excludes system agents, and they need their history too. Instead
// a plain RLS read of `agents` (no is_system filter) checks visibility first.
// The database function runs as the caller, so the agent_chat_sessions policies
// decide — a user-owned thread only for its owner, a system agent's thread for
// its organization — and a foreign agent id comes back exactly like one that
// was never talked to.
export const readChatHistorySchema = z.object({
  agent_id: z.string().uuid().describe("Your own agent id — named in your context window header"),
  before: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Only messages older than this index (the #n numbers in your context window). Pass the returned next_before to keep paging back."),
  query: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Case-insensitive text to look for in message texts and tool calls; newest matches first. Combine with before to search only further back."),
  limit: z.number().int().min(1).max(30).optional().describe("How many messages to return, default 10"),
});

export async function readChatHistory(ctx: Ctx, args: z.infer<typeof readChatHistorySchema>) {
  // RLS decides what the caller may read (system agents of the organization,
  // the caller's own agents — deleted ones too, they stay an archive). A
  // foreign id and one that never existed get the same answer.
  const { data: visible, error: visibleError } = await ctx.db
    .from("agents")
    .select("id")
    .eq("id", args.agent_id)
    .maybeSingle();
  if (visibleError || !visible) throw new Error(`Agent ${args.agent_id} not found.`);
  const { data, error } = await ctx.db.rpc("read_agent_chat_history", {
    p_agent_id: args.agent_id,
    p_before: args.before ?? null,
    p_query: args.query ?? null,
    p_limit: args.limit ?? 10,
  });
  if (error) throw new Error(`Could not read chat history: ${error.message}`);
  return formatHistory(data as HistoryResult);
}
