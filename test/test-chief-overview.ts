// get_overview goes through the real registration and a real tools/call over
// an in-memory transport (same approach as test-update-schemas-strict.ts),
// with a fake ctx.db whose rpc records what it was asked.
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerAllTools } from "../src/tools/index.js";
import type { Ctx } from "../src/context.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
  if (!ok) failed++;
}

const calls: string[] = [];
const fakeDb = {
  rpc: async (fn: string) => {
    calls.push(fn);
    return { data: { agents: [{ id: "a1", name: "Inbox Sorter" }], tasks: { open: 1 } }, error: null };
  },
} as unknown as SupabaseClient;
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "test" };

const server = new McpServer({ name: "test", version: "0" });
registerAllTools(server, ctx);
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverT), (async () => {})()]);
const client = new Client({ name: "t", version: "0" });
await client.connect(clientT);

const tools = await client.listTools();
check("get_overview is registered", tools.tools.some((t) => t.name === "get_overview"));

let text = "";
try {
  const res = await client.callTool({ name: "get_overview", arguments: {} });
  text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
} catch (e) {
  text = e instanceof Error ? e.message : String(e);
}
check("calls get_chief_overview", calls.includes("get_chief_overview"), JSON.stringify(calls));
check("returns the overview", text.includes("Inbox Sorter"), text);

await client.close();
await server.close();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all checks passed");
