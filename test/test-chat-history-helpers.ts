import { formatHistory, formatToolCalls, type HistoryMessage } from "../src/tools/chatHistoryHelpers.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (e: any) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

function assert(condition: boolean, msg: string) {
  if (!condition) throw new Error(msg);
}

function message(overrides: Partial<HistoryMessage>): HistoryMessage {
  return {
    index: overrides.index ?? 0,
    role: overrides.role ?? "user",
    at: overrides.at ?? null,
    origin: overrides.origin ?? "chat",
    from_agent_name: overrides.from_agent_name ?? null,
    text: overrides.text ?? "hello",
    text_truncated: overrides.text_truncated ?? false,
    tool_calls: overrides.tool_calls ?? [],
  };
}

console.log("\nchatHistoryHelpers");

test("labels speakers like the context window does", () => {
  const out = formatHistory({
    total: 4,
    messages: [
      message({ index: 0, role: "user", origin: "chat" }),
      message({ index: 1, role: "agent" }),
      message({ index: 2, role: "user", origin: "routine" }),
      message({ index: 3, role: "user", origin: "agent_message", from_agent_name: "Rowan" }),
    ],
  });
  assert(out.messages.map((m) => m.from).join("|") === 'user|you|routine|agent "Rowan"', JSON.stringify(out.messages));
});

test("next_before points at the oldest returned index, null once #0 is included", () => {
  const paged = formatHistory({ total: 50, messages: [message({ index: 30 }), message({ index: 31 })] });
  assert(paged.next_before === 30, `expected 30, got ${paged.next_before}`);
  const start = formatHistory({ total: 50, messages: [message({ index: 0 }), message({ index: 1 })] });
  assert(start.next_before === null, `expected null, got ${start.next_before}`);
  const empty = formatHistory({ total: 0, messages: [] });
  assert(empty.next_before === null && empty.total_messages === 0, JSON.stringify(empty));
});

test("marks truncated text", () => {
  const out = formatHistory({ total: 1, messages: [message({ text: "abc", text_truncated: true })] });
  assert(out.messages[0].text === "abc … [truncated]", out.messages[0].text);
});

test("formats tool calls with short names, error mark and ids, omitting empty inputs", () => {
  const trace = formatToolCalls([
    { name: "mcp__jan-crm__search_contacts", input: '{"query":"Müller"}', is_error: false, ids: ["3f2a1c4e-1111-4222-8333-444455556666"] },
    { name: "mcp__jan-crm__list_tags", input: "{}", is_error: false, ids: [] },
    { name: "Bash", input: '{"command":"ls"}', is_error: true, ids: [] },
  ]);
  assert(
    trace === 'search_contacts {"query":"Müller"} → 3f2a1c4e-1111-4222-8333-444455556666 · list_tags · Bash {"command":"ls"} ✗',
    String(trace)
  );
  assert(formatToolCalls([]) === undefined, "empty list should give undefined");
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
