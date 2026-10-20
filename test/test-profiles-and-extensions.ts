// Tool profiles (/mcp for Jan, /mcp/agent for the desktop agents), the
// description budget of Jan's profile, the memory protocol stated once, and
// the extended/new read tools: list_emails, create_email_draft (reply),
// list_documents (text search), list_calendar_events, share_status,
// changes_since. Tool functions run against a fake ctx.db that records every
// call; edge functions against a stubbed fetch.
import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "../src/context.js";
import { registerTools, AGENT_ONLY_TOOLS, type ToolProfile } from "../src/tools/index.js";
import { renderInstructions } from "../src/instructions.js";
import {
  listEmails, listEmailsSchema, searchEmailsArgs, createEmailDraft, createEmailDraftSchema, draftPayload,
} from "../src/tools/mail.js";
import { listDocuments, listDocumentsSchema, documentSearchFilter } from "../src/tools/documents.js";
import { listCalendarEvents, listCalendarEventsSchema, calendarRange, calendarFilter } from "../src/tools/calendar.js";
import { shareStatus, shareStatusSchema, compactRecipient, SHARE_READ_ACTIONS } from "../src/tools/share.js";
import { changesSince, changesSinceSchema, changesSinceArg } from "../src/tools/changes.js";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${ok || !detail ? "" : "\n       " + detail}`);
  if (!ok) failed++;
}
async function rejects(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return (e as Error).message; }
}
function throws(fn: () => unknown): string | null {
  try { fn(); return null; } catch (e) { return (e as Error).message; }
}

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
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "tok" };
const has = (c: Chain | undefined, m: string, ...a: unknown[]) =>
  !!c?.calls.some(([n, ...x]) => n === m && a.every((v, i) => JSON.stringify(x[i]) === JSON.stringify(v)));
const reset = (r: typeof respond = () => ({ data: [], error: null })) => { chains = []; respond = r; };

// ── stubbed fetch (edge functions) ───────────────────────────────────────
type Sent = { url: string; auth: string | null; body: Record<string, unknown> };
let sent: Sent[] = [];
let answer: (s: Sent) => { status: number; json: unknown } = () => ({ status: 200, json: {} });
globalThis.fetch = (async (url: string, init: RequestInit) => {
  const s: Sent = { url: String(url), auth: new Headers(init.headers).get("Authorization"), body: JSON.parse(String(init.body)) };
  sent.push(s);
  const a = answer(s);
  return new Response(JSON.stringify(a.json), { status: a.status, headers: { "Content-Type": "application/json" } });
}) as typeof fetch;

// ── profiles ─────────────────────────────────────────────────────────────
async function listTools(profile: ToolProfile) {
  const server = new McpServer({ name: "t", version: "1" });
  registerTools(server, ctx, profile);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "c", version: "1" });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools;
}
const jan = await listTools("jan");
const agent = await listTools("agent");
const janNames = new Set(jan.map((t) => t.name));
const agentNames = new Set(agent.map((t) => t.name));

const needAgentId = [
  "update_agent_profile", "remember", "read_chat_history", "schedule_routine", "update_routine", "cancel_routine",
  "get_overview", "delegate", "create_agent", "update_agent", "pause_agent", "delete_agent",
  "create_standing_order", "update_standing_order", "create_proposal", "update_proposal_status",
];
const droppedForJan = ["get_pipeline_stats", "suggest_next_step", "create_initiative", "update_initiative"];
const newTools = ["list_calendar_events", "share_status", "changes_since"];

check("Jan's profile lacks every agent_id tool", needAgentId.every((n) => !janNames.has(n)), needAgentId.filter((n) => janNames.has(n)).join(", "));
check("Jan's profile lacks the dropped tools", droppedForJan.every((n) => !janNames.has(n)));
check("Jan's profile keeps search_initiatives, get_initiative, open_project", ["search_initiatives", "get_initiative", "open_project"].every((n) => janNames.has(n)));
check("agent profile has every agent tool and the dropped ones", [...needAgentId, ...droppedForJan].every((n) => agentNames.has(n)));
check("both profiles have the new tools", newTools.every((n) => janNames.has(n) && agentNames.has(n)));
check("AGENT_ONLY_TOOLS is exactly the 20 tools", AGENT_ONLY_TOOLS.length === 20 && [...needAgentId, ...droppedForJan].every((n) => AGENT_ONLY_TOOLS.includes(n)));
check("agent profile = Jan's profile + AGENT_ONLY_TOOLS", agent.length === jan.length + AGENT_ONLY_TOOLS.length && jan.every((t) => agentNames.has(t.name)));
check("tool counts: Jan 55, agent 75", jan.length === 55 && agent.length === 75, `${jan.length} / ${agent.length}`);
// Every tool the desktop runtime can grant (CRM src/modules/agents/tools.ts) exists in the agent profile.
const desktop = [
  "search_contacts", "get_contact", "create_contact", "update_contact", "search_companies", "get_company", "create_company", "update_company",
  "search_projects", "get_project", "create_project", "update_project", "search_initiatives", "get_initiative", "create_initiative", "update_initiative",
  "suggest_next_step", "open_project", "update_agent_status", "remember_for_project", "add_timeline_entry", "propose_description", "link_project_item",
  "list_project_timeline", "get_interaction", "list_interactions", "create_task", "search_tasks", "get_task", "update_task", "create_calendar_event",
  "list_calendar_events", "create_email_draft", "list_emails", "get_email", "list_tags", "add_tag_to_entity", "get_pipeline_stats", "list_folders",
  "create_folder", "rename_folder", "list_documents", "get_document_content", "create_text_document", "upload_binary_document",
  "update_document_content", "update_document", "delete_document", "list_note_folders", "search_notes", "get_note", "create_note", "update_note",
  "share_status", "changes_since", "search_audio_recordings", "get_audio_recording", "remember_about_user", "set_recording_preference",
  ...needAgentId,
];
check("agent profile covers every tool the desktop app can grant", desktop.every((n) => agentNames.has(n)), desktop.filter((n) => !agentNames.has(n)).join(", "));

// ── description budget ───────────────────────────────────────────────────
const descChars = (tools: { description?: string }[]) => tools.reduce((n, t) => n + (t.description?.length ?? 0), 0);
const janChars = descChars(jan);
// Before the split every client got 72 tools with 13,449 description characters.
check("Jan's profile: description chars dropped below 9,000 (was 13,449)", janChars < 9_000, String(janChars));
const desc = (n: string) => agent.find((t) => t.name === n)?.description ?? "";
const memoryTools = ["open_project", "remember_about_user", "remember_for_project", "remember"];
// Before: open_project 1,180, remember_about_user 844, remember_for_project 724, remember 285.
const budget: Record<string, number> = { open_project: 500, remember_about_user: 300, remember_for_project: 300, remember: 200 };
check("memory tool descriptions are short", memoryTools.every((n) => desc(n).length > 0 && desc(n).length <= budget[n]), memoryTools.map((n) => `${n}=${desc(n).length}`).join(" "));
check("no memory tool description repeats the protocol", memoryTools.every((n) => !/without being asked|after every user message/i.test(desc(n))));
check("the protocol is in the instructions", /after every user message/i.test(renderInstructions("")) && /without being asked/.test(renderInstructions("")));

// ── list_emails ──────────────────────────────────────────────────────────
const accounts = (c: Chain) => c.target === "ms_email_accounts" ? { data: [{ id: "a1" }, { id: "a2" }], error: null } : { data: [], error: null };
reset(accounts);
await listEmails(ctx, listEmailsSchema.parse({ search: "angebot", contact_id: "11111111-1111-4111-8111-111111111111" }));
const accQ = chains.find((c) => c.target === "ms_email_accounts");
const rpc = chains.find((c) => c.target === "search_emails");
check("list_emails: accounts filtered on ctx.userId", has(accQ, "eq", "user_id", "u1"));
check("list_emails: all accounts by default", JSON.stringify((rpc?.args as Record<string, unknown>)?.p_account_ids) === '["a1","a2"]');
check("list_emails: full text and contact go to the RPC", (rpc?.args as Record<string, unknown>)?.p_query === "angebot" && (rpc?.args as Record<string, unknown>)?.p_contact_id === "11111111-1111-4111-8111-111111111111");
reset((c) => c.target === "ms_email_accounts" ? { data: [{ id: "a1" }], error: null } : { data: [], error: null });
await listEmails(ctx, listEmailsSchema.parse({ account_id: "22222222-2222-4222-8222-222222222222" }));
check("list_emails: account filter checks ownership", has(chains[0], "eq", "id", "22222222-2222-4222-8222-222222222222") && has(chains[0], "eq", "user_id", "u1"));
reset(() => ({ data: [], error: null }));
check("list_emails: foreign account is an error", !!(await rejects(() => listEmails(ctx, listEmailsSchema.parse({ account_id: "22222222-2222-4222-8222-222222222222" })))));
reset(accounts);
check("list_emails: folder by name needs an account", /needs account_id/.test((await rejects(() => listEmails(ctx, listEmailsSchema.parse({ folder: "INBOX" })))) ?? ""));

let a = searchEmailsArgs(listEmailsSchema.parse({ from: "2026-07-01", to: "2026-07-31" }), ["a1"], null);
check("list_emails: from = Berlin midnight", a.p_from === "2026-06-30T22:00:00.000Z", String(a.p_from));
check("list_emails: to includes the whole Berlin day", a.p_to === "2026-07-31T22:00:00.000Z", String(a.p_to));
check("list_emails: from after to is rejected", !!throws(() => searchEmailsArgs(listEmailsSchema.parse({ from: "2026-08-01", to: "2026-07-01" }), ["a1"], null)));
check("list_emails: range over a year is rejected", !!throws(() => searchEmailsArgs(listEmailsSchema.parse({ from: "2024-01-01", to: "2026-01-01" }), ["a1"], null)));
check("list_emails: junk date is rejected", !!throws(() => searchEmailsArgs(listEmailsSchema.parse({ from: "next week" }), ["a1"], null)));
a = searchEmailsArgs(listEmailsSchema.parse({ thread: "s:angebot website" }), ["a1"], null);
check("list_emails: thread key goes to p_thread", a.p_thread === "s:angebot website" && a.p_thread_message_id === null);
a = searchEmailsArgs(listEmailsSchema.parse({ thread: "33333333-3333-4333-8333-333333333333" }), ["a1"], null);
check("list_emails: email id goes to p_thread_message_id", a.p_thread === null && a.p_thread_message_id === "33333333-3333-4333-8333-333333333333");
check("list_emails: limit capped at 50 by the schema", !listEmailsSchema.safeParse({ limit: 51 }).success);
reset((c) => c.target === "ms_email_accounts" ? { data: [{ id: "a1" }], error: null }
  : { data: [{ id: "m1", account_id: "a1", subject: "S", from_name: null, from_address: "x@y.de", to_addresses: ["j@j.net"], preview: "p", received_at: "t", is_read: true, has_attachments: false, direction: "inbound", thread_key: "s:s", body_text: "never" }], error: null });
const mails = await listEmails(ctx, listEmailsSchema.parse({}));
check("list_emails: compact rows with thread_key, no body", mails.length === 1 && mails[0].thread_key === "s:s" && !("body_text" in mails[0]) && !("to" in mails[0]));

// ── create_email_draft (reply) ───────────────────────────────────────────
const reply = createEmailDraftSchema.parse({ reply_to: "44444444-4444-4444-8444-444444444444", body_html: "Danke!", reply_all: true });
const p = draftPayload(reply, undefined);
check("draft: reply sends only the id and flags, no headers", p.reply_to === reply.reply_to && p.reply_all === true && p.quote_original === false
  && !("in_reply_to" in p) && !("references" in p) && !("account_id" in p));
check("draft: reply_all without reply_to is rejected", !!throws(() => draftPayload(createEmailDraftSchema.parse({ reply_all: true }), "a1")));
reset(accounts); sent = [];
answer = () => ({ status: 200, json: { appended: true, folder: "Drafts", account_id: "a2", to: ["anna@x.de"], cc: [], subject: "Re: Angebot" } });
const r = await createEmailDraft(ctx, reply);
check("draft: reply without account_id doesn't pick the default account", !chains.some((c) => c.target === "ms_email_accounts") && !("account_id" in sent[0].body));
check("draft: edge function called with the caller's token", sent[0].url.endsWith("/functions/v1/mail-create-draft") && sent[0].auth === "Bearer tok");
check("draft: result echoes the reply's recipients and subject", r.subject === "Re: Angebot" && r.account_id === "a2" && JSON.stringify(r.to) === '["anna@x.de"]');
reset(accounts); sent = [];
answer = () => ({ status: 200, json: { appended: true, folder: "Drafts" } });
await createEmailDraft(ctx, createEmailDraftSchema.parse({ to: ["a@b.de"], subject: "Hi" }));
check("draft: a plain draft still resolves the default account", sent[0].body.account_id === "a1" && !("reply_to" in sent[0].body));

// ── list_documents (text search) ─────────────────────────────────────────
check("documents: filter searches the extracted text too", documentSearchFilter("frist") === "file_name.ilike.%frist%,description.ilike.%frist%,extracted_text.ilike.%frist%");
reset((c) => c.kind === "rpc" ? { data: [{ id: "d1", snippet: "…die Frist beträgt…" }], error: null } : { data: [{ id: "d1" }, { id: "d2" }], error: null });
const docs = await listDocuments(ctx, listDocumentsSchema.parse({ query: "frist, (x)" })) as Record<string, unknown>[];
const docQ = chains.find((c) => c.target === "documents");
check("documents: or() term is stripped", has(docQ, "or", documentSearchFilter("frist   x")), JSON.stringify(docQ?.calls.find(([m]) => m === "or")));
check("documents: never selects the text itself", !docQ?.calls.some(([m, s]) => m === "select" && String(s).includes("extracted_text")));
const snip = chains.find((c) => c.target === "document_text_snippets");
check("documents: snippets only for the page's ids", JSON.stringify((snip?.args as Record<string, unknown>)?.p_ids) === '["d1","d2"]');
check("documents: snippet attached as text_match", docs[0].text_match === "…die Frist beträgt…" && !("text_match" in docs[1]));
reset();
await listDocuments(ctx, listDocumentsSchema.parse({}));
check("documents: no query, no snippet call", !chains.some((c) => c.kind === "rpc"));

// ── list_calendar_events ─────────────────────────────────────────────────
const range = calendarRange({ from: "2026-07-01", to: "2026-07-31" });
check("calendar: Berlin day range, to inclusive", range.from === "2026-06-30T22:00:00.000Z" && range.to === "2026-07-31T22:00:00.000Z");
check("calendar: more than 92 days is rejected", /at most 92/.test(throws(() => calendarRange({ from: "2026-01-01", to: "2026-06-01" })) ?? ""));
check("calendar: to before from is rejected", !!throws(() => calendarRange({ from: "2026-07-02", to: "2026-07-01T00:00:00Z" })));
check("calendar: overlap filter incl. recurring series", calendarFilter(range, "") ===
  "and(start_at.lt.2026-07-31T22:00:00.000Z,end_at.gt.2026-06-30T22:00:00.000Z),and(rrule.not.is.null,start_at.lt.2026-07-31T22:00:00.000Z)");
check("calendar: search is ANDed in one filter", calendarFilter(range, "Anna").startsWith("and(or(and(start_at") && calendarFilter(range, "Anna").includes("summary.ilike.%Anna%"));
reset(() => ({ data: [{ id: "e1", summary: "Call", description: null, location: null, start_at: "s", end_at: "e", all_day: false, calendar_name: "Work", status: "confirmed", rrule: "FREQ=WEEKLY" }], error: null }));
const events = await listCalendarEvents(ctx, listCalendarEventsSchema.parse({ from: "2026-07-01", to: "2026-07-07", search: "a,b(c)" }));
check("calendar: bound to ctx.userId", has(chains[0], "eq", "user_id", "u1"));
check("calendar: search term stripped for or()", JSON.stringify(chains[0].calls.find(([m]) => m === "or")).includes("summary.ilike.%a b c%"));
check("calendar: compact rows, recurring flagged", events[0].title === "Call" && events[0].recurring === true && !("description" in events[0]));
check("calendar: limit capped at 100", !listCalendarEventsSchema.safeParse({ from: "2026-01-01", to: "2026-01-02", limit: 101 }).success);

// ── share_status ─────────────────────────────────────────────────────────
check("share: exactly one of contact_id / document_id", !!(await rejects(() => shareStatus(ctx, shareStatusSchema.parse({})))));
const contactId = "55555555-5555-4555-8555-555555555555";
reset((c) => c.target === "contacts" ? { data: { id: contactId, first_name: "Anna", last_name: "M" }, error: null }
  : c.target === "share_events" ? { data: [{ kind: "comment", occurred_at: "t", item_title: "Deck", document_id: null, author: "recipient", body: "x".repeat(400), thread_resolved: false }], error: null }
  : { data: [], error: null });
sent = [];
answer = (s) => s.body.action === "recipient.get"
  ? { status: 200, json: { ok: true, recipient: { status: "active", password_set: true, otp_pending: true, one_time_password: "SECRET", last_login_at: "t", access_expires_at: null, shares: [{ item_id: "i1", can_comment: true }] } } }
  : { status: 200, json: { ok: true, items: [{ id: "i1", title: "Deck", type: "file", archived: false, crm_document_id: "d1", direct_url: "https://share/p/abc" }] } };
const st = await shareStatus(ctx, shareStatusSchema.parse({ contact_id: contactId }));
const out = JSON.stringify(st);
check("share: only read actions are called", sent.every((s) => (SHARE_READ_ACTIONS as readonly string[]).includes(String(s.body.action))) && sent.every((s) => s.auth === "Bearer tok"));
check("share: contact params are only the contact id", JSON.stringify(sent.find((s) => s.body.action === "recipient.get")?.body.params) === JSON.stringify({ contact_id: contactId }));
check("share: no password, no link in the answer", !out.includes("SECRET") && !out.includes("https://share") && !out.includes("one_time_password\""));
check("share: shared items resolved by title", out.includes('"title":"Deck"') && out.includes('"document_id":"d1"'));
check("share: comment bodies are cut", out.includes("x".repeat(300) + "…") && !out.includes("x".repeat(301)));
check("share: events filtered by contact", has(chains.find((c) => c.target === "share_events"), "eq", "contact_id", contactId));
reset((c) => c.target === "documents" ? { data: { id: "d9", file_name: "Vertrag.pdf" }, error: null } : { data: [], error: null });
sent = [];
answer = (s) => s.body.action === "catalog.list"
  ? { status: 200, json: { ok: true, items: [{ id: "i9", title: "Vertrag", type: "file", archived: false, crm_document_id: "66666666-6666-4666-8666-666666666666" }] } }
  : { status: 200, json: { ok: true, item: { title: "Vertrag", type: "file", link_code: "abc", direct_url: "https://share/p/abc", version: 2 }, shares: [{ can_comment: false, recipient_id: "r", person: { name: "Anna", email: "a@x.de", crm_contact_id: contactId, status: "active", last_login_at: null } }] } };
const ds = await shareStatus(ctx, shareStatusSchema.parse({ document_id: "66666666-6666-4666-8666-666666666666" })) as Record<string, unknown>;
const dsOut = JSON.stringify(ds);
check("share: document → item.get of the matching catalog item", JSON.stringify(sent.find((s) => s.body.action === "item.get")?.body.params) === '{"item_id":"i9"}');
check("share: document answer lists who has it, without links", ds.shared === true && dsOut.includes('"name":"Anna"') && !dsOut.includes("abc"));
check("compactRecipient: null stays null", compactRecipient(null, []) === null);
answer = () => ({ status: 503, json: { ok: false, error: "share_not_configured" } });
reset((c) => c.target === "contacts" ? { data: { id: contactId, first_name: "A", last_name: "B" }, error: null } : { data: [], error: null });
check("share: not configured is a clear error", /not configured/.test((await rejects(() => shareStatus(ctx, shareStatusSchema.parse({ contact_id: contactId })))) ?? ""));

// ── changes_since ────────────────────────────────────────────────────────
const now = new Date("2026-10-20T12:00:00Z");
check("changes: date = Berlin midnight", changesSinceArg("2026-10-19", now) === "2026-10-18T22:00:00.000Z");
check("changes: future is rejected", !!throws(() => changesSinceArg("2026-10-21T00:00:00Z", now)));
check("changes: more than 90 days back is rejected", !!throws(() => changesSinceArg("2026-01-01", now)));
check("changes: junk is rejected", !!throws(() => changesSinceArg("yesterday", now)));
reset(() => ({ data: { since: "x", tasks: { new: 1 } }, error: null }));
const ch = await changesSince(ctx, changesSinceSchema.parse({ since: new Date(Date.now() - 3_600_000).toISOString(), top: 3 }));
const chRpc = chains.find((c) => c.target === "crm_changes_since");
check("changes: one RPC call with since and top", !!chRpc && (chRpc.args as Record<string, unknown>).p_top === 3 && typeof (chRpc.args as Record<string, unknown>).p_since === "string");
check("changes: digest passed through", JSON.stringify(ch) === '{"since":"x","tasks":{"new":1}}');

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
