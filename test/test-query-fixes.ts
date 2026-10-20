// Berlin due dates, escaped ilike terms, filters before the limit, and
// create tools that no longer swallow a failed link insert. Tool functions
// run against a fake ctx.db that records every call of each query chain.
import "dotenv/config";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "../src/context.js";
import { berlinToIso, nextDay } from "../src/berlinTime.js";
import { escapeLike } from "../src/tools/queryHelpers.js";
import { createTask, updateTask, searchTasks, createTaskSchema, updateTaskSchema, searchTasksSchema } from "../src/tools/tasks.js";
import { searchContacts, searchContactsSchema, createContact, createContactSchema } from "../src/tools/contacts.js";
import { searchCompanies, searchCompaniesSchema, createCompany, createCompanySchema } from "../src/tools/companies.js";
import { searchProjects, searchProjectsSchema, createProject, createProjectSchema } from "../src/tools/projects.js";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${ok || !detail ? "" : "\n       " + detail}`);
  if (!ok) failed++;
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return (e as Error).message; }
}

// ── Berlin time ──────────────────────────────────────────────────────────
check("winter: 09:00 Berlin = 08:00Z", berlinToIso("2026-01-15", "09:00") === "2026-01-15T08:00:00.000Z");
check("summer: 09:00 Berlin = 07:00Z", berlinToIso("2026-07-15", "09:00") === "2026-07-15T07:00:00.000Z");
check("spring change day: 09:00 = 07:00Z", berlinToIso("2026-03-29", "09:00") === "2026-03-29T07:00:00.000Z");
check("day before spring change: 09:00 = 08:00Z", berlinToIso("2026-03-28", "09:00") === "2026-03-28T08:00:00.000Z");
check("skipped 02:30 lands at 03:30 CEST", berlinToIso("2026-03-29", "02:30") === "2026-03-29T01:30:00.000Z");
check("autumn change day: 09:00 = 08:00Z", berlinToIso("2026-10-25", "09:00") === "2026-10-25T08:00:00.000Z");
check("midnight in summer is 22:00Z the day before", berlinToIso("2026-07-15") === "2026-07-14T22:00:00.000Z");
check("nextDay crosses months", nextDay("2026-02-28") === "2026-03-01" && nextDay("2026-12-31") === "2027-01-01");
check("invalid date is rejected", (() => { try { berlinToIso("2026-02-30", "09:00"); return false; } catch { return true; } })());

// ── escapeLike ───────────────────────────────────────────────────────────
check("escapeLike escapes % _ \\", escapeLike("50%_a\\b") === "50\\%\\_a\\\\b", escapeLike("50%_a\\b"));
check("escapeLike drops *", escapeLike("a*b") === "a b");

// ── fake db ──────────────────────────────────────────────────────────────
type Call = [string, ...unknown[]];
type Chain = { kind: "from" | "rpc"; target: string; args?: unknown; calls: Call[] };
let chains: Chain[] = [];
let respond: (c: Chain) => { data: unknown; error: unknown } = () => ({ data: [], error: null });

function builder(chain: Chain) {
  const settle = () => { chains.push(chain); return Promise.resolve(respond(chain)); };
  const b: Record<string, unknown> = {};
  for (const m of ["select", "insert", "update", "delete", "upsert", "eq", "neq", "is", "in", "ilike", "lt", "lte", "gt", "gte", "order", "limit", "range", "or"]) {
    b[m] = (...a: unknown[]) => { chain.calls.push([m, ...a]); return b; };
  }
  b.single = settle;
  b.maybeSingle = settle;
  b.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => settle().then(res, rej);
  return b;
}
const fakeDb = {
  from: (t: string) => builder({ kind: "from", target: t, calls: [] }),
  rpc: (fn: string, args: unknown) => builder({ kind: "rpc", target: fn, args, calls: [] }),
} as unknown as SupabaseClient;
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "t" };
const has = (c: Chain | undefined, m: string, ...a: unknown[]) =>
  !!c?.calls.some(([n, ...x]) => n === m && a.every((v, i) => JSON.stringify(x[i]) === JSON.stringify(v)));
const reset = (r: typeof respond = () => ({ data: [], error: null })) => { chains = []; respond = r; };

// ── tasks ────────────────────────────────────────────────────────────────
reset((c) => ({ data: c.calls.some(([m]) => m === "insert") ? { id: "t1" } : [{ id: "t1" }], error: null }));
await createTask(ctx, createTaskSchema.parse({ title: "Call", due_date: "2026-07-15" }));
let ins = chains[0]?.calls.find(([m]) => m === "insert")?.[1] as Record<string, unknown> | undefined;
check("create_task: due 09:00 Berlin in summer", ins?.due_date === "2026-07-15T07:00:00.000Z", String(ins?.due_date));
reset((c) => ({ data: c.calls.some(([m]) => m === "insert") ? { id: "t1" } : [{ id: "t1" }], error: null }));
await createTask(ctx, createTaskSchema.parse({ title: "Call", due_date: "2026-12-01", due_time: "14:30" }));
ins = chains[0]?.calls.find(([m]) => m === "insert")?.[1] as Record<string, unknown> | undefined;
check("create_task: 14:30 Berlin in winter", ins?.due_date === "2026-12-01T13:30:00.000Z", String(ins?.due_date));
check("create_task schema rejects a malformed time", !createTaskSchema.safeParse({ title: "x", due_date: "2026-12-01", due_time: "9" }).success);

reset(() => ({ data: [{ id: "t1" }], error: null }));
await updateTask(ctx, updateTaskSchema.parse({ id: "11111111-1111-4111-8111-111111111111", due_date: "2026-07-15", due_time: "18:00" }));
const upd = chains[0]?.calls.find(([m]) => m === "update")?.[1] as Record<string, unknown> | undefined;
check("update_task: 18:00 Berlin in summer", upd?.due_date === "2026-07-15T16:00:00.000Z", String(upd?.due_date));

reset();
await searchTasks(ctx, searchTasksSchema.parse({ query: "100%_done", due_after: "2026-07-01", due_before: "2026-07-31" }));
check("search_tasks: ilike term escaped", has(chains[0], "ilike", "title", "%100\\%\\_done%"), JSON.stringify(chains[0]?.calls));
check("search_tasks: due_after from Berlin midnight", has(chains[0], "gte", "due_date", "2026-06-30T22:00:00.000Z"));
check("search_tasks: due_before up to the next Berlin midnight", has(chains[0], "lt", "due_date", "2026-07-31T22:00:00.000Z"));

// ── contacts: filters before the limit ───────────────────────────────────
reset();
await searchContacts(ctx, searchContactsSchema.parse({ query: "Anna", company_id: "22222222-2222-4222-8222-222222222222", source: "Referral", limit: 5 }));
let rpc = chains.find((c) => c.kind === "rpc");
check("contacts: with filters the RPC returns its whole ranked pool", (rpc?.args as { p_limit: number })?.p_limit === 1000, JSON.stringify(rpc?.args));
check("contacts: company and source filtered in the query", has(rpc, "eq", "company_id", "22222222-2222-4222-8222-222222222222") && has(rpc, "eq", "source", "Referral"));
check("contacts: limit after the filters, best score first", has(rpc, "limit", 5) && has(rpc, "order", "match_score", { ascending: false }));

reset();
await searchContacts(ctx, searchContactsSchema.parse({ query: "Anna", limit: 5 }));
rpc = chains.find((c) => c.kind === "rpc");
check("contacts: without filters the RPC limit stays the requested one", (rpc?.args as { p_limit: number })?.p_limit === 5);

const T1 = "33333333-3333-4333-8333-333333333333", T2 = "44444444-4444-4444-8444-444444444444";
reset((c) => {
  if (c.target === "contact_tags") {
    const tag = c.calls.find(([m, col]) => m === "eq" && col === "tag_id")?.[2];
    const rows = tag === T1 ? [{ contact_id: "c1" }, { contact_id: "c2" }] : [{ contact_id: "c2" }, { contact_id: "c3" }];
    return { data: rows, error: null };
  }
  return { data: [{ id: "c2", last_name: "B" }], error: null };
});
const tagged = await searchContacts(ctx, searchContactsSchema.parse({ tag_ids: [T1, T2], limit: 10 }));
const main = chains.find((c) => c.target === "contacts");
check("contacts: tag filter is the intersection, pushed into the query", has(main, "in", "id", ["c2"]), JSON.stringify(main?.calls));
check("contacts: tag links are read page by page", chains.filter((c) => c.target === "contact_tags").every((c) => has(c, "range", 0, 999)));
check("contacts: tagged result", tagged.length === 1 && tagged[0].id === "c2");

reset((c) => ({ data: c.target === "contact_tags" ? [] : [{ id: "x" }], error: null }));
check("contacts: no contact with the tags → empty, no main query",
  (await searchContacts(ctx, searchContactsSchema.parse({ tag_ids: [T1], limit: 10 }))).length === 0 && !chains.some((c) => c.target === "contacts"));

// ── companies and projects ───────────────────────────────────────────────
reset();
await searchCompanies(ctx, searchCompaniesSchema.parse({ query: "Acme", industry: "Technology", limit: 3 }));
rpc = chains.find((c) => c.kind === "rpc");
check("companies: industry filtered in the query before the limit",
  (rpc?.args as { p_limit: number })?.p_limit === 1000 && has(rpc, "eq", "industry", "Technology") && has(rpc, "limit", 3));

const C = "55555555-5555-4555-8555-555555555555";
reset((c) => ({ data: c.target === "project_contacts" ? [{ project_id: "p1" }, { project_id: "p2" }] : [], error: null }));
await searchProjects(ctx, searchProjectsSchema.parse({ query: "Relaunch", contact_id: C, stage: "Active", limit: 4 }));
rpc = chains.find((c) => c.kind === "rpc");
check("projects: contact, stage filtered in the query before the limit",
  (rpc?.args as { p_limit: number })?.p_limit === 1000 && has(rpc, "in", "id", ["p1", "p2"]) && has(rpc, "eq", "stage", "Active") && has(rpc, "limit", 4));
reset((c) => ({ data: c.target === "project_contacts" ? [{ project_id: "p1" }] : [], error: null }));
await searchProjects(ctx, searchProjectsSchema.parse({ contact_id: C, limit: 4 }));
check("projects: contact filter also without a query", has(chains.find((c) => c.target === "projects"), "in", "id", ["p1"]));

// ── create tools surface a failed link insert ────────────────────────────
const failLinks = (joinTable: string) => (c: Chain) => {
  if (c.target === joinTable) return { data: null, error: { message: "violates foreign key" } };
  return { data: { id: "new1" }, error: null };
};
reset(failLinks("contact_tags"));
let msg = await rejects(() => createContact(ctx, createContactSchema.parse({ first_name: "A", last_name: "B", tag_ids: [T1] })));
check("create_contact: failed tag insert is an error", !!msg && /tags could not be added/.test(msg), String(msg));
check("create_contact: the contact is rolled back", chains.some((c) => c.target === "contacts" && has(c, "delete") && has(c, "eq", "id", "new1")));

reset(failLinks("company_tags"));
msg = await rejects(() => createCompany(ctx, createCompanySchema.parse({ name: "Acme", tag_ids: [T1] })));
check("create_company: failed tag insert is an error and rolled back",
  !!msg && /tags could not be added/.test(msg) && chains.some((c) => c.target === "companies" && has(c, "delete")), String(msg));

reset(failLinks("project_companies"));
msg = await rejects(() => createProject(ctx, createProjectSchema.parse({ name: "P", company_ids: [C] })));
check("create_project: failed link insert is an error and rolled back",
  !!msg && /could not be linked/.test(msg) && chains.some((c) => c.target === "projects" && has(c, "delete")), String(msg));

reset((c) => ({ data: { id: "new1" }, error: null }));
msg = await rejects(() => createContact(ctx, createContactSchema.parse({ first_name: "A", last_name: "B", tag_ids: [T1] })));
check("create_contact: success path unchanged", msg === null && !chains.some((c) => has(c, "delete")), String(msg));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
