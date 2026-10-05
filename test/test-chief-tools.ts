// The Chief's management tools through the real registration and a real
// tools/call over an in-memory transport (as test-chief-overview.ts), with a
// fake ctx.db that records every query and answers from a small script.
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { registerAllTools } from "../src/tools/index.js";
import type { Ctx } from "../src/context.js";
import {
  workerTools, createStandingOrderSchema, updateStandingOrderSchema, createProposalSchema, updateProposalStatusSchema,
} from "../src/tools/chief.js";

let failed = 0;
function check(name: string, ok: boolean, detail?: string) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${!ok && detail ? `\n       ${detail}` : ""}`);
  if (!ok) failed++;
}

const CHIEF = "11111111-1111-4111-8111-111111111111";
const MANAGED = "22222222-2222-4222-8222-222222222222";
const OWN = "33333333-3333-4333-8333-333333333333";
const SYSTEM = "44444444-4444-4444-8444-444444444444";
const P = "mcp__jan-crm__";

type Op = { table: string; action: "select" | "insert" | "update"; filters: Record<string, unknown>; values?: any; head?: boolean };
let ops: Op[] = [];
let rpcs: Array<{ fn: string; args: any }> = [];
let rpcResult: { data: unknown; error: unknown } = { data: null, error: null };

// What the user's own token would see: the Chief, one agent it created, one
// the user built. The system agent is visible (RLS) but never matches the
// own-worker filters below.
const agents: Record<string, any> = {
  [CHIEF]: { id: CHIEF, role: "chief", created_by: "u1", is_system: false, managed_by: null, deleted_at: null, organization_id: "o1", name: "Chief", tools: [`${P}search_contacts`, `${P}get_overview`, `${P}remember`, "Bash"] },
  [MANAGED]: { id: MANAGED, role: "worker", created_by: "u1", is_system: false, managed_by: CHIEF, deleted_at: null, organization_id: "o1", name: "Helper", tools: [] },
  [OWN]: { id: OWN, role: "worker", created_by: "u1", is_system: false, managed_by: null, deleted_at: null, organization_id: "o1", name: "Mine", tools: ["Bash"] },
  [SYSTEM]: { id: SYSTEM, role: "worker", created_by: null, is_system: true, managed_by: null, deleted_at: null, organization_id: "o1", name: "Sys", tools: [] },
};

function answer(op: Op): { data: unknown; error: unknown; count?: number } {
  if (op.table !== "agents") return { data: null, error: null };
  if (op.action === "insert") return { data: { id: "new-agent", ...op.values }, error: null };
  if (op.action === "update") return { data: [{ id: op.filters.id }], error: null };
  if (op.head) return { data: null, error: null, count: 0 };
  const rows = Object.values(agents).filter((a) =>
    Object.entries(op.filters).every(([k, v]) => (v === null ? a[k] === null : a[k] === v)));
  return { data: rows[0] ?? null, error: null };
}

function builder(table: string) {
  const op: Op = { table, action: "select", filters: {} };
  const settle = () => { ops.push(op); return Promise.resolve(answer(op)); };
  const b: any = {
    select: (_cols?: string, opts?: { head?: boolean }) => { if (opts?.head) op.head = true; return b; },
    insert: (v: unknown) => { op.action = "insert"; op.values = v; return b; },
    update: (v: unknown) => { op.action = "update"; op.values = v; return b; },
    eq: (c: string, v: unknown) => { op.filters[c] = v; return b; },
    is: (c: string, v: unknown) => { op.filters[c] = v; return b; },
    maybeSingle: settle,
    single: settle,
    then: (res: any, rej: any) => settle().then(res, rej),
  };
  return b;
}
const fakeDb = {
  from: (t: string) => builder(t),
  rpc: async (fn: string, args: any) => { rpcs.push({ fn, args }); return rpcResult; },
} as unknown as SupabaseClient;
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "test" };

const server = new McpServer({ name: "test", version: "0" });
registerAllTools(server, ctx);
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "t", version: "0" });
await client.connect(clientT);

async function call(name: string, args: Record<string, unknown>) {
  ops = []; rpcs = [];
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  return { isError: !!res.isError, text };
}
const writes = () => ops.filter((o) => o.action !== "select");

const names = (await client.listTools()).tools.map((t) => t.name);
for (const n of ["create_agent", "update_agent", "pause_agent", "delete_agent", "delegate"]) {
  check(`${n} is registered`, names.includes(n));
}

let r = await call("create_agent", { agent_id: OWN, name: "X", job: "Do X" });
check("create_agent refuses a non-Chief caller", r.isError && /Only your Chief/.test(r.text) && writes().length === 0, r.text);

r = await call("create_agent", { agent_id: CHIEF, name: "X", job: "Do X", tools: [`${P}search_contacts`, "Bash"] });
check("create_agent refuses Bash", r.isError && /Bash/.test(r.text) && writes().length === 0, r.text);

r = await call("create_agent", { agent_id: CHIEF, name: "X", job: "Do X", tools: [`${P}delegate`] });
check("create_agent refuses manager tools", r.isError && /delegate/.test(r.text) && writes().length === 0, r.text);

r = await call("create_agent", { agent_id: CHIEF, name: "Researcher", job: "Find facts.\nSecond line.", temporary: true });
const ins = writes()[0];
check("create_agent inserts a managed chat agent", !r.isError && ins?.action === "insert"
  && ins.values.managed_by === CHIEF && ins.values.execution_mode === "chat_stateless"
  && ins.values.system_prompt === "Find facts.\nSecond line." && ins.values.description === "Find facts.", r.text);
check("create_agent defaults to the Chief's CRM tools minus the manager tools",
  JSON.stringify(ins?.values.tools) === JSON.stringify([`${P}search_contacts`, `${P}remember`]), JSON.stringify(ins?.values.tools));
const hours = ins ? (Date.parse(ins.values.expires_at) - Date.now()) / 3_600_000 : 0;
check("temporary without hours expires in 48h", hours > 47.9 && hours < 48.1, String(hours));

r = await call("update_agent", { agent_id: CHIEF, target_agent_id: SYSTEM, name: "Hacked" });
check("update_agent refuses a system agent", r.isError && /not found/.test(r.text) && writes().length === 0, r.text);

r = await call("update_agent", { agent_id: CHIEF, target_agent_id: OWN, job: "New job" });
check("update_agent refuses re-tasking the user's own agent", r.isError && /set up by the user/.test(r.text) && writes().length === 0, r.text);

r = await call("update_agent", { agent_id: CHIEF, target_agent_id: OWN, name: "Renamed" });
check("update_agent renames the user's own agent", !r.isError && writes()[0]?.values.name === "Renamed", r.text);

r = await call("update_agent", { agent_id: CHIEF, target_agent_id: MANAGED, job: "Better job", expires_in_hours: null });
check("update_agent re-tasks a managed agent and clears expiry", !r.isError
  && writes()[0]?.values.system_prompt === "Better job" && writes()[0]?.values.expires_at === null, r.text);

r = await call("pause_agent", { agent_id: CHIEF, target_agent_id: OWN, paused: true });
check("pause_agent pauses the user's own agent", !r.isError && writes()[0]?.values.paused === true, r.text);

r = await call("pause_agent", { agent_id: CHIEF, target_agent_id: CHIEF, paused: true });
check("pause_agent refuses the Chief itself", r.isError && writes().length === 0, r.text);

r = await call("delete_agent", { agent_id: CHIEF, target_agent_id: OWN });
check("delete_agent refuses an agent the user built", r.isError && /set up by the user/.test(r.text) && writes().length === 0, r.text);

r = await call("delete_agent", { agent_id: CHIEF, target_agent_id: MANAGED });
check("delete_agent soft-deletes a managed agent", !r.isError && typeof writes()[0]?.values.deleted_at === "string", r.text);

rpcResult = { data: "d-1", error: null };
r = await call("delegate", { agent_id: CHIEF, to_agent_id: OWN, task: "Look into Acme" });
check("delegate calls create_delegation with the mapped arguments", !r.isError && rpcs[0]?.fn === "create_delegation"
  && rpcs[0].args.p_from_agent_id === CHIEF && rpcs[0].args.p_to_agent_id === OWN && rpcs[0].args.p_task === "Look into Acme"
  && r.text.includes("d-1"), r.text);

rpcResult = { data: null, error: { message: "Delegation depth limit (3) reached — do this part yourself." } };
r = await call("delegate", { agent_id: CHIEF, to_agent_id: OWN, task: "x" });
check("delegate passes the database's refusal through", r.isError && /depth limit/.test(r.text), r.text);

r = await call("create_agent", { agent_id: CHIEF, name: "X", job: "Y", is_system: true });
check("schemas are strict", r.isError, r.text);

r = await call("read_chat_history", { agent_id: "55555555-5555-4555-8555-555555555555" });
check("read_chat_history: an invisible agent is 'not found' and the RPC is not called",
  r.isError && /not found/.test(r.text) && rpcs.length === 0, r.text);

const delegateDescription = (await client.listTools()).tools.find((t) => t.name === "delegate")?.description ?? "";
check("delegate warns that a system agent's thread is visible to the whole organization",
  /visible to the whole organization/.test(delegateDescription)
  && /never put the user's private mail content or personal details into a task for a system agent/.test(delegateDescription)
  && /one of the user's own agents/.test(delegateDescription), delegateDescription);

// ── Standing orders and proposals ─────────────────────────────────────────
const SO = "66666666-6666-4666-8666-666666666666";
const PR = "77777777-7777-4777-8777-777777777777";
const PJ = "88888888-8888-4888-8888-888888888888";
for (const n of ["create_standing_order", "update_standing_order", "create_proposal", "update_proposal_status"]) {
  check(`${n} is registered`, names.includes(n));
}
check("create_standing_order schema is strict", !createStandingOrderSchema.safeParse({ agent_id: CHIEF, instruction: "x", extra: 1 }).success);
check("update_standing_order schema is strict", !updateStandingOrderSchema.safeParse({ agent_id: CHIEF, standing_order_id: SO, enabled: true, extra: 1 }).success);
check("create_proposal schema is strict", !createProposalSchema.safeParse({ agent_id: CHIEF, title: "t", body: "b", extra: 1 }).success);
check("update_proposal_status schema is strict", !updateProposalStatusSchema.safeParse({ agent_id: CHIEF, proposal_id: PR, status: "done", outcome: "ok", extra: 1 }).success);
for (const status of ["accepted", "rejected", "open"]) {
  check(`update_proposal_status rejects status ${status}`, !updateProposalStatusSchema.safeParse({ agent_id: CHIEF, proposal_id: PR, status, outcome: "ok" }).success);
}
check("update_proposal_status accepts done with an outcome", updateProposalStatusSchema.safeParse({ agent_id: CHIEF, proposal_id: PR, status: "done", outcome: "ok" }).success);
check("update_proposal_status rejects an empty outcome", !updateProposalStatusSchema.safeParse({ agent_id: CHIEF, proposal_id: PR, status: "done", outcome: "  " }).success);
check("update_standing_order accepts project_id null alone", updateStandingOrderSchema.safeParse({ agent_id: CHIEF, standing_order_id: SO, project_id: null }).success);

const nonChief: Array<[string, Record<string, unknown>]> = [
  ["create_standing_order", { agent_id: OWN, instruction: "Watch Acme" }],
  ["update_standing_order", { agent_id: OWN, standing_order_id: SO, enabled: false }],
  ["create_proposal", { agent_id: OWN, title: "t", body: "b" }],
  ["update_proposal_status", { agent_id: OWN, proposal_id: PR, status: "done", outcome: "ok" }],
];
for (const [tool, args] of nonChief) {
  r = await call(tool, args);
  check(`${tool} refuses a non-Chief caller and never calls rpc`, r.isError && /Only your Chief/.test(r.text) && rpcs.length === 0, r.text);
}

rpcResult = { data: SO, error: null };
r = await call("create_standing_order", { agent_id: CHIEF, instruction: "Watch Acme" });
check("create_standing_order calls the rpc with a null project", !r.isError && rpcs[0]?.fn === "create_standing_order"
  && JSON.stringify(rpcs[0].args) === JSON.stringify({ p_instruction: "Watch Acme", p_project_id: null }) && r.text.includes(SO), r.text);

rpcResult = { data: null, error: null };
r = await call("update_standing_order", { agent_id: CHIEF, standing_order_id: SO, project_id: null });
check("update_standing_order with project_id null clears the project", !r.isError && rpcs[0]?.fn === "update_standing_order"
  && rpcs[0].args.p_clear_project === true && rpcs[0].args.p_project_id === null && rpcs[0].args.p_id === SO, r.text);
r = await call("update_standing_order", { agent_id: CHIEF, standing_order_id: SO, project_id: PJ, enabled: false });
check("update_standing_order with a project does not clear it", !r.isError
  && rpcs[0].args.p_clear_project === false && rpcs[0].args.p_project_id === PJ && rpcs[0].args.p_enabled === false, r.text);
r = await call("update_standing_order", { agent_id: CHIEF, standing_order_id: SO });
check("update_standing_order with nothing to change is refused", r.isError && /Nothing to update/.test(r.text) && rpcs.length === 0, r.text);

rpcResult = { data: PR, error: null };
r = await call("create_proposal", { agent_id: CHIEF, title: "Send follow-up", body: "Why and what", project_id: PJ });
check("create_proposal calls create_chief_proposal", !r.isError && rpcs[0]?.fn === "create_chief_proposal"
  && rpcs[0].args.p_title === "Send follow-up" && rpcs[0].args.p_project_id === PJ && rpcs[0].args.p_standing_order_id === null
  && r.text.includes(PR), r.text);

rpcResult = { data: true, error: null };
r = await call("update_proposal_status", { agent_id: CHIEF, proposal_id: PR, status: "done", outcome: "Sent" });
check("update_proposal_status calls complete_chief_proposal", !r.isError && rpcs[0]?.fn === "complete_chief_proposal"
  && JSON.stringify(rpcs[0].args) === JSON.stringify({ p_id: PR, p_outcome: "Sent" }), r.text);
rpcResult = { data: false, error: null };
r = await call("update_proposal_status", { agent_id: CHIEF, proposal_id: PR, status: "done", outcome: "Sent" });
check("update_proposal_status reports a proposal that is not accepted", r.isError && /not accepted \(or already done\)/.test(r.text), r.text);

const listed = (await client.listTools()).tools;
for (const [n, key] of [["create_standing_order", "agent_id"], ["update_standing_order", "standing_order_id"], ["create_proposal", "agent_id"], ["update_proposal_status", "proposal_id"]]) {
  const props = Object.keys((listed.find((t) => t.name === n)?.inputSchema as any)?.properties ?? {});
  check(`${n} advertises its parameters`, props.includes("agent_id") && props.includes(key), JSON.stringify(props));
}

let threw = false;
try { workerTools([`${P}create_proposal`]); } catch { threw = true; }
check("create_proposal is manager-only", threw);
for (const n of ["create_standing_order", "update_standing_order", "update_proposal_status"]) {
  threw = false;
  try { workerTools([P + n]); } catch { threw = true; }
  check(`${n} is manager-only`, threw);
}

await client.close();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
console.log("all checks passed");
