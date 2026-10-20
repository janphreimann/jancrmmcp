// set_recording_preference through the real registration and a real
// tools/call over an in-memory transport, with a fake ctx.db that records
// every query on agent_prompt_overrides.
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerTools } from "../src/tools/index.js";
import type { Ctx } from "../src/context.js";
import { workerTools } from "../src/tools/chief.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
  if (!ok) failed++;
}

type Op = { action: string; filters: Record<string, unknown>; values?: any; onConflict?: string };
let ops: Op[] = [];
let stored: string | null = "Old wish";

function builder(table: string) {
  if (table !== "agent_prompt_overrides") throw new Error(`unexpected table ${table}`);
  const op: Op = { action: "select", filters: {} };
  const settle = () => {
    ops.push(op);
    if (op.action === "select") return Promise.resolve({ data: stored === null ? null : { value: stored }, error: null });
    return Promise.resolve({ data: null, error: null });
  };
  const b: any = {
    select: () => b,
    upsert: (v: unknown, o?: { onConflict?: string }) => { op.action = "upsert"; op.values = v; op.onConflict = o?.onConflict; return b; },
    delete: () => { op.action = "delete"; return b; },
    eq: (c: string, v: unknown) => { op.filters[c] = v; return b; },
    maybeSingle: settle,
    then: (res: any, rej: any) => settle().then(res, rej),
  };
  return b;
}

const fakeDb = { from: builder } as unknown as SupabaseClient;
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "test" };

const server = new McpServer({ name: "t", version: "0" });
registerTools(server, ctx, "agent");
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "c", version: "0" });
await Promise.all([server.connect(a), client.connect(b)]);

async function call(args: Record<string, unknown>) {
  const res: any = await client.callTool({ name: "set_recording_preference", arguments: args });
  return { isError: !!res.isError, body: res.isError ? res.content?.[0]?.text : JSON.parse(res.content[0].text) };
}

console.log("set_recording_preference");

ops = []; stored = "Old wish";
let r = await call({ step: "summary", preference: "  Shorter, in English.  " });
const up = ops.find((o) => o.action === "upsert");
check("upserts the trimmed text under the step's key for the caller", !!up && up.values.key === "recording_pref_summary" && up.values.user_id === "u1" && up.values.value === "Shorter, in English." && up.onConflict === "user_id,key", JSON.stringify(ops));
check("returns the previous text", r.body?.previous === "Old wish", JSON.stringify(r.body));

ops = []; stored = "Old wish";
r = await call({ step: "tasks", preference: "" });
const del = ops.find((o) => o.action === "delete");
check("empty preference deletes the row (back to defaults)", !!del && del.filters.key === "recording_pref_tasks" && del.filters.user_id === "u1", JSON.stringify(ops));
check("reports null as the new preference", r.body?.preference === null, JSON.stringify(r.body));

r = await call({ step: "everything", preference: "x" });
check("rejects an unknown step", r.isError);

r = await call({ step: "summary", preference: "x".repeat(2001) });
check("rejects text over 2000 characters", r.isError);

let threw = false;
try { workerTools(["mcp__jan-crm__set_recording_preference"]); } catch { threw = true; }
check("is never handed to a worker agent", threw);

console.log(failed ? `\n${failed} failed` : "\nall passed");
process.exit(failed ? 1 : 0);
