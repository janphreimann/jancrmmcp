// The zone rule (spec §2.1): Claude must not be able to write `brief` or
// the removed `ai_summary` through update_project. With .strict() an
// unknown key is a validation error instead of being silently dropped.
//
// The schema alone is not the proof: server.tool(name, desc, schema.shape, cb)
// makes the SDK rebuild a plain z.object(shape), which strips unknown keys and
// loses .strict(). So the second half of this test goes through the real
// registration (registerAllTools) and a real tools/call over an in-memory
// transport — the exact path a client takes.
//
// projects.ts pulls in supabase.ts, which throws unless SUPABASE_* env vars
// are set — same reason test-mail-draft.ts loads dotenv before its imports.
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { updateProjectSchema } from "../src/tools/projects.js";
import { updateInitiativeSchema } from "../src/tools/initiatives.js";
import { registerAllTools } from "../src/tools/index.js";
import type { Ctx } from "../src/context.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
  if (!ok) failed++;
}

const id = "11111111-1111-4111-8111-111111111111";

// ── Schema level ────────────────────────────────────────────────────────────
check("schema: update_project rejects brief", !updateProjectSchema.safeParse({ id, brief: "x" }).success);
check("schema: update_project rejects ai_summary", !updateProjectSchema.safeParse({ id, ai_summary: "x" }).success);
check("schema: update_project accepts stage", updateProjectSchema.safeParse({ id, stage: "Active" }).success);
check("schema: update_project rejects deal-era stage", !updateProjectSchema.safeParse({ id, stage: "Identified" }).success);
check("schema: update_initiative rejects unknown key", !updateInitiativeSchema.safeParse({ id, foo: 1 }).success);

// ── Tool boundary (the path the SDK actually takes) ─────────────────────────
// A stub db that records every update payload. A rejected call must never
// reach it; an accepted one returns one matching row.
const writes: { table: string; payload: unknown }[] = [];
function stubDb(): SupabaseClient {
  const chain = (table: string) => {
    const q: Record<string, unknown> = {};
    q.update = (payload: unknown) => { writes.push({ table, payload }); return q; };
    q.eq = () => q;
    q.select = async () => ({ data: [{ id }], error: null });
    return q;
  };
  return { from: chain } as unknown as SupabaseClient;
}
const ctx: Ctx = { userId: id, orgId: id, db: stubDb(), admin: stubDb(), accessToken: "test" };

const server = new McpServer({ name: "strict-test", version: "0.0.0" });
registerAllTools(server, ctx);
const client = new Client({ name: "strict-test-client", version: "0.0.0" });
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await Promise.all([server.connect(serverT), client.connect(clientT)]);

async function call(name: string, args: Record<string, unknown>) {
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text?: string }[]).map((c) => c.text ?? "").join("\n");
    return { isError: !!res.isError, text };
  } catch (e) {
    return { isError: true, text: e instanceof Error ? e.message : String(e) };
  }
}

async function expectRejected(label: string, name: string, args: Record<string, unknown>, key: string) {
  const before = writes.length;
  const r = await call(name, args);
  check(`tool: ${label} is rejected`, r.isError, r.text);
  check(`tool: ${label} error names the key`, r.text.includes(key) && /unrecognized/i.test(r.text), r.text);
  check(`tool: ${label} never reaches the db`, writes.length === before);
  console.log(`       → ${r.text.replace(/\s+/g, " ").slice(0, 160)}`);
}

await expectRejected("update_project {id, brief}", "update_project", { id, brief: "x" }, "brief");
await expectRejected("update_project {id, ai_summary}", "update_project", { id, ai_summary: "x" }, "ai_summary");
await expectRejected("update_initiative {id, foo}", "update_initiative", { id, foo: 1 }, "foo");

const okCall = await call("update_project", { id, stage: "Active" });
check("tool: update_project {id, stage} succeeds", !okCall.isError, okCall.text);
const last = writes.at(-1);
check(
  "tool: update_project writes exactly {stage}",
  last?.table === "projects" && JSON.stringify(last.payload) === JSON.stringify({ stage: "Active" }),
  JSON.stringify(last),
);

const tools = await client.listTools();
const up = tools.tools.find((t) => t.name === "update_project");
check(
  "tools/list: update_project advertises additionalProperties:false",
  (up?.inputSchema as { additionalProperties?: unknown })?.additionalProperties === false,
  JSON.stringify(up?.inputSchema),
);

await client.close();
await server.close();

if (failed) process.exit(1);
