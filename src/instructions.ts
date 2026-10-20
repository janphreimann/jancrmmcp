import type { Ctx } from "./context.js";

// What every client gets at connection start (the MCP `instructions` of the
// initialize result) — Claude Code and claude.ai alike, with or without a
// project. It carries the user's standing rules (user_agent_memory, written
// by remember_about_user, editable in Settings → Prompts → About me), so a
// rule like "address me as Herr Bauer" reaches every agent, not only the one
// that was told, and not only inside a project briefing.

// The memory protocol lives here and only here — the tool descriptions of
// remember_about_user, remember_for_project, remember and open_project say
// what each tool stores, not when to call it.
const BASE =
  "This server is the user's CRM. When a request concerns a project, call open_project first; before you finish, " +
  "call update_agent_status if the project's state changed.\n\n" +
  "Memory: after every user message, check whether it told you something that should still hold next time — " +
  "a rule, a preference, how they want to be addressed, a decision, a correction of your mistake — and save it in the " +
  "same turn, without being asked and without announcing it: remember_for_project if it concerns one project, " +
  "remember_about_user if it holds beyond it. Both replace the whole text: start from the current one (the project's " +
  "Memory in the briefing; the user's below), keep what still holds, drop what is outdated, don't duplicate.\n\n" +
  "Something that happened in a project (a meeting, a call, a decision the user tells you about) goes to " +
  "add_timeline_entry. The timeline is the project's history, never a log of your own work.";

export function renderInstructions(memory: string): string {
  const m = memory.trim();
  return m
    ? `${BASE}\n\nAbout the user — standing rules for every conversation (the current text of remember_about_user):\n${m}`
    : `${BASE}\n\nAbout the user: nothing saved yet.`;
}

// Only an initialize request reads the memory: the instructions are part of
// its result and nothing else, and every other request would pay a query
// for text it never sends.
export function isInitialize(body: unknown): boolean {
  const msgs = Array.isArray(body) ? body : [body];
  return msgs.some((m) => (m as { method?: unknown } | null)?.method === "initialize");
}

export async function loadInstructions(ctx: Ctx): Promise<string> {
  const { data, error } = await ctx.db.from("user_agent_memory").select("memory").eq("user_id", ctx.userId).maybeSingle();
  // Best effort: a failed read must not fail the connection.
  if (error) console.error("user_agent_memory could not be read:", error.message);
  return renderInstructions(data?.memory ?? "");
}
