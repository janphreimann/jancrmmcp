// Shape of public.read_agent_chat_history() in the CRM database (migration
// 20261105003600_stateless_chat_agents.sql in ../janreimanncrm). Tool calls
// arrive without their output — only the ids found in it — and inputs already
// cut to 200 characters there.
export type HistoryToolCall = {
  name: string;
  input: string;
  is_error: boolean;
  ids: string[];
};

export type HistoryMessage = {
  index: number;
  role: "user" | "agent";
  at: string | null;
  origin: "chat" | "routine" | "agent_message" | null;
  from_agent_name: string | null;
  text: string;
  text_truncated: boolean;
  tool_calls: HistoryToolCall[];
};

export type HistoryResult = {
  total: number;
  messages: HistoryMessage[];
};

// Same speaker labels and tool-trace format as the context window the agent
// already sees every turn (src/modules/agents/contextWindow.ts in the CRM) —
// paging back should read like scrolling up, not like a second format.
function speaker(message: HistoryMessage): string {
  if (message.role === "agent") return "you";
  if (message.origin === "routine") return "routine";
  if (message.origin === "agent_message") {
    return message.from_agent_name ? `agent "${message.from_agent_name}"` : "another agent";
  }
  return "user";
}

export function formatToolCalls(calls: HistoryToolCall[]): string | undefined {
  if (calls.length === 0) return undefined;
  return calls
    .map((call) =>
      [
        call.name.replace(/^mcp__.+?__/, ""),
        call.input === "{}" ? "" : call.input,
        call.is_error ? "✗" : "",
        call.ids.length > 0 ? `→ ${call.ids.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" ")
    )
    .join(" · ");
}

export function formatHistory(result: HistoryResult) {
  const messages = result.messages.map((message) => ({
    index: message.index,
    at: message.at,
    from: speaker(message),
    text: message.text_truncated ? `${message.text} … [truncated]` : message.text,
    tools: formatToolCalls(message.tool_calls),
  }));
  const oldest = messages.length > 0 ? messages[0].index : null;
  return {
    total_messages: result.total,
    messages,
    // Pass as `before` to continue further back; null once #0 is reached or
    // nothing matched.
    next_before: oldest != null && oldest > 0 ? oldest : null,
  };
}
