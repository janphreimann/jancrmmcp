// Feste API-Keys (`jcrm_…`, src/apiKeys.ts) gegen einen gefälschten
// service_role-Client: unbekannter Key, gespeicherte Sitzung samt Cache,
// Lease-Gewinner (Refresh / neue Sitzung), Lease-Verlierer (Warten /
// Timeout), fail closed bei gescheiterter Registrierung, 401 vs. 5xx über
// requireBearerAuth — und dass Key, Hash und Tokens nie in Meldungen landen.
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { InvalidTokenError, ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { createApiKeyVerifier, isApiKey, ApiKeyUnavailableError } from "../src/apiKeys.js";
import { open, seal, sha256Hex } from "../src/seal.js";

process.env.MCP_API_KEY = "test-sealing-key";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${ok || !detail ? "" : "\n       " + detail}`);
  if (!ok) failed++;
}
async function caught(fn: () => Promise<unknown>): Promise<unknown> {
  try { await fn(); return null; } catch (e) { return e; }
}

// ── Kennzeichen, die nie in einer Meldung auftauchen dürfen ──────────────
const KEY = "jcrm_" + "A".repeat(43);
const HASH = sha256Hex(KEY);
const OTHER_KEY = "jcrm_" + "B".repeat(43);
const secrets: string[] = [KEY, HASH, OTHER_KEY, sha256Hex(OTHER_KEY)];
const logged: string[] = [];
const origError = console.error;
console.error = (...a: unknown[]) => { logged.push(a.map(String).join(" ")); };

// ── Uhr ──────────────────────────────────────────────────────────────────
let clock = 1_800_000_000_000;
const nowS = () => Math.floor(clock / 1000);

let jwtSeq = 0;
function jwt(exp: number, sessionId: string): string {
  const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const t = `${b({ alg: "HS256" })}.${b({ exp, session_id: sessionId, n: ++jwtSeq })}.sig${jwtSeq}`;
  secrets.push(t);
  return t;
}
function rt(): string {
  const t = `rt-${++jwtSeq}-secret`;
  secrets.push(t);
  return t;
}

// ── gefälschte Datenbank ─────────────────────────────────────────────────
const USER = "11111111-1111-1111-1111-111111111111";
const KEY_ID = "22222222-2222-2222-2222-222222222222";
interface Row {
  id: string; user_id: string; label: string; key_hash: string;
  session_id: string | null; sealed_session: string | null; access_expires_at: string | null;
  lease: boolean;
}
let row: Row | null;
let calls: { name: string; args?: unknown }[] = [];
const count = (n: string) => calls.filter((c) => c.name === n).length;
const callOf = (n: string) => calls.find((c) => c.name === n);

let leaseFree = true;
let resolveFails = false;
let storeFails = false;
let registerFails = false;
let refreshOk = true;
let onSleep: (i: number) => void = () => {};

function sealFor(at: string, r: string): string {
  return seal({ t: "apikey", k: KEY_ID, sub: USER, at, rt: r });
}
function freshRow(opts: { expIn: number; sessionId?: string }): Row {
  const sid = opts.sessionId ?? "sess-old";
  const at = jwt(nowS() + opts.expIn, sid);
  return {
    id: KEY_ID, user_id: USER, label: "Jan CRM desktop agents (mac)", key_hash: HASH,
    session_id: sid, sealed_session: sealFor(at, rt()),
    access_expires_at: new Date((nowS() + opts.expIn) * 1000).toISOString(), lease: false,
  };
}

function reset(r: Row | null) {
  row = r;
  calls = [];
  leaseFree = true; resolveFails = false; storeFails = false; registerFails = false; refreshOk = true;
  onSleep = () => {};
}

const rpcHandlers: Record<string, (a: Record<string, unknown>) => { data: unknown; error: unknown }> = {
  mcp_api_key_resolve: (a) => {
    if (resolveFails) return { data: null, error: { code: "57P01", message: "terminating connection" } };
    if (!row || a.p_key_hash !== row.key_hash) return { data: [], error: null };
    const { key_hash: _h, lease: _l, ...out } = row;
    return { data: [out], error: null };
  },
  mcp_api_key_take_lease: (a) => {
    if (!row || a.p_id !== row.id || !leaseFree || row.lease) return { data: false, error: null };
    row.lease = true;
    return { data: true, error: null };
  },
  mcp_api_key_store_session: (a) => {
    if (storeFails) return { data: null, error: { code: "XX000", message: "boom" } };
    if (row && a.p_id === row.id) {
      row.session_id = a.p_session_id as string;
      row.sealed_session = a.p_sealed as string;
      row.access_expires_at = a.p_access_expires_at as string;
      row.lease = false;
    }
    return { data: null, error: null };
  },
  mcp_api_key_release_lease: (a) => {
    if (row && a.p_id === row.id) row.lease = false;
    return { data: null, error: null };
  },
  register_mcp_session: () =>
    registerFails ? { data: null, error: { code: "42501", message: "nope" } } : { data: null, error: null },
};

const fakeAdmin = {
  rpc: (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return Promise.resolve(rpcHandlers[name](args));
  },
  auth: {
    admin: {
      getUserById: async (id: string) => {
        calls.push({ name: "getUserById", args: id });
        return { data: { user: { id, email: "owner@example.com" } }, error: null };
      },
      generateLink: async () => {
        calls.push({ name: "generateLink" });
        return { data: { properties: { hashed_token: "hashed-link" } }, error: null };
      },
      signOut: async (token: string, scope: string) => {
        calls.push({ name: "signOut", args: { token, scope } });
        return { error: null };
      },
    },
  },
} as unknown as SupabaseClient;

let lastIssued: { at: string; rt: string } | null = null;
const fakeAnon = () => ({
  auth: {
    refreshSession: async ({ refresh_token }: { refresh_token: string }) => {
      calls.push({ name: "refreshSession", args: refresh_token });
      if (!refreshOk) return { data: { session: null, user: null }, error: { message: "Invalid Refresh Token: Already Used" } };
      const sid = row?.session_id ?? "sess-old";
      lastIssued = { at: jwt(nowS() + 3600, sid), rt: rt() };
      return { data: { session: { access_token: lastIssued.at, refresh_token: lastIssued.rt }, user: { id: USER } }, error: null };
    },
    verifyOtp: async () => {
      calls.push({ name: "verifyOtp" });
      lastIssued = { at: jwt(nowS() + 3600, "sess-minted"), rt: rt() };
      return { data: { session: { access_token: lastIssued.at, refresh_token: lastIssued.rt } }, error: null };
    },
  },
}) as unknown as SupabaseClient;

function verifier() {
  return createApiKeyVerifier({
    admin: fakeAdmin,
    anon: fakeAnon,
    now: () => clock,
    sleep: async (ms) => { clock += ms; onSleep(count("sleep")); calls.push({ name: "sleep" }); },
  });
}

const errors: unknown[] = [];
async function expectError(fn: () => Promise<unknown>) {
  const e = await caught(fn);
  errors.push(e);
  return e;
}

// ── Präfix ───────────────────────────────────────────────────────────────
console.log("prefix");
check("jcrm_ is an API key", isApiKey(KEY));
check("a sealed OAuth token is not", !isApiKey(seal({ t: "token" })));

// ── unbekannter Key ──────────────────────────────────────────────────────
console.log("unknown key");
reset(freshRow({ expIn: 3600 }));
{
  const e = await expectError(() => verifier().verify(OTHER_KEY));
  check("unknown key → InvalidTokenError", e instanceof InvalidTokenError);
  check("no lease taken", count("mcp_api_key_take_lease") === 0);
}

// ── gespeicherte, gültige Sitzung ────────────────────────────────────────
console.log("stored session + cache");
reset(freshRow({ expIn: 3600 }));
{
  const v = verifier();
  const stored = open<{ at: string }>(row!.sealed_session!)!;
  const info = await v.verify(KEY);
  const extra = info.extra as { sub: string; supabaseAccessToken: string };
  check("uses the stored access token", extra.supabaseAccessToken === stored.at);
  check("sub = key owner", extra.sub === USER);
  check("clientId api-key:<id>", info.clientId === `api-key:${KEY_ID}`);
  check("expiresAt = access token exp", info.expiresAt === nowS() + 3600);
  check("no lease, no refresh", count("mcp_api_key_take_lease") === 0 && count("refreshSession") === 0);
  check("resolve called with the hash", (callOf("mcp_api_key_resolve")?.args as { p_key_hash: string }).p_key_hash === HASH);
  await v.verify(KEY);
  check("second request served from cache", count("mcp_api_key_resolve") === 1);
  clock += 5 * 60 * 1000 + 1;
  await v.verify(KEY);
  check("cache holds at most 5 min", count("mcp_api_key_resolve") === 2);
  row = null; // widerrufen
  clock += 5 * 60 * 1000 + 1;
  const e = await expectError(() => v.verify(KEY));
  check("revoked key → 401 once the cache entry is gone", e instanceof InvalidTokenError);
}

// ── concurrent requests share one resolution ─────────────────────────────
console.log("in-flight dedupe");
reset(freshRow({ expIn: 3600 }));
{
  const v = verifier();
  await Promise.all([v.verify(KEY), v.verify(KEY), v.verify(KEY)]);
  check("three parallel requests → one resolve", count("mcp_api_key_resolve") === 1);
}

// ── Lease-Gewinner: Refresh ──────────────────────────────────────────────
console.log("lease winner: refresh");
reset(freshRow({ expIn: 60 })); // < 120 s Rest
{
  const oldRt = open<{ rt: string }>(row!.sealed_session!)!.rt;
  const info = await verifier().verify(KEY);
  const extra = info.extra as { supabaseAccessToken: string };
  check("lease taken (20 s)", (callOf("mcp_api_key_take_lease")?.args as { p_seconds: number }).p_seconds === 20);
  check("refreshed with the stored refresh token", callOf("refreshSession")?.args === oldRt);
  check("no mint", count("generateLink") === 0 && count("register_mcp_session") === 0);
  check("returns the refreshed access token", extra.supabaseAccessToken === lastIssued!.at);
  const store = callOf("mcp_api_key_store_session")?.args as Record<string, string>;
  check("stored with the same session id", store?.p_session_id === "sess-old");
  const sealed = open<{ t: string; k: string; at: string; rt: string }>(store.p_sealed);
  check("stored blob is sealed and bound to the key", sealed?.t === "apikey" && sealed.k === KEY_ID && sealed.rt === lastIssued!.rt);
  check("stored blob holds no plaintext token", !store.p_sealed.includes(lastIssued!.at) && !store.p_sealed.includes(lastIssued!.rt));
  check("access_expires_at from the token", store.p_access_expires_at === new Date((nowS() + 3600) * 1000).toISOString());
  check("lease not released separately after store", count("mcp_api_key_release_lease") === 0);
}

// ── Lease-Gewinner: jemand war schneller ─────────────────────────────────
console.log("lease winner: re-read after lease");
reset(freshRow({ expIn: 60 }));
{
  const fresh = freshRow({ expIn: 3600 });
  let reads = 0;
  const orig = rpcHandlers.mcp_api_key_resolve;
  rpcHandlers.mcp_api_key_resolve = (a) => {
    if (++reads === 2) { row!.sealed_session = fresh.sealed_session; }
    return orig(a);
  };
  const info = await verifier().verify(KEY);
  rpcHandlers.mcp_api_key_resolve = orig;
  check("uses the session another instance stored", (info.extra as { supabaseAccessToken: string }).supabaseAccessToken === open<{ at: string }>(fresh.sealed_session!)!.at);
  check("no refresh, no mint, no store", count("refreshSession") === 0 && count("generateLink") === 0 && count("mcp_api_key_store_session") === 0);
  check("lease released", count("mcp_api_key_release_lease") === 1 && row!.lease === false);
}

// ── Lease-Gewinner: Refresh scheitert → neue Sitzung ─────────────────────
console.log("lease winner: refresh fails → mint");
reset(freshRow({ expIn: -10 }));
refreshOk = false;
{
  const info = await verifier().verify(KEY);
  check("refresh attempted first", count("refreshSession") === 1);
  check("minted via generateLink + verifyOtp", count("generateLink") === 1 && count("verifyOtp") === 1);
  const reg = callOf("register_mcp_session")?.args as Record<string, string>;
  check("registered as MCP session with client name 'API key: <label>'",
    reg?.p_client_name === "API key: Jan CRM desktop agents (mac)" && reg.p_session_id === "sess-minted" && reg.p_user_id === USER);
  const store = callOf("mcp_api_key_store_session")?.args as Record<string, string>;
  check("stored the new session id", store?.p_session_id === "sess-minted");
  check("returns the minted access token", (info.extra as { supabaseAccessToken: string }).supabaseAccessToken === lastIssued!.at);
}

// ── sealing key changed → unreadable blob → mint ─────────────────────────
console.log("unreadable sealed session → mint");
reset(freshRow({ expIn: 3600 }));
row!.sealed_session = "garbage";
{
  await verifier().verify(KEY);
  check("no refresh possible, minted directly", count("refreshSession") === 0 && count("generateLink") === 1);
}

// ── neue Sitzung: Registrierung scheitert → fail closed ──────────────────
console.log("mint: registration fails");
reset(freshRow({ expIn: -10 }));
refreshOk = false;
registerFails = true;
{
  const e = await expectError(() => verifier().verify(KEY));
  check("→ ApiKeyUnavailableError (ServerError, not 401)", e instanceof ApiKeyUnavailableError && e instanceof ServerError && !(e instanceof InvalidTokenError));
  const so = callOf("signOut")?.args as { token: string; scope: string };
  check("fresh session signed out", so?.token === lastIssued!.at && so.scope === "local");
  check("nothing stored", count("mcp_api_key_store_session") === 0);
  check("lease released", count("mcp_api_key_release_lease") === 1 && row!.lease === false);
}

// ── store scheitert nach Mint → Sitzung abgemeldet ───────────────────────
console.log("mint: store fails");
reset(freshRow({ expIn: -10 }));
refreshOk = false;
storeFails = true;
{
  const e = await expectError(() => verifier().verify(KEY));
  check("→ ApiKeyUnavailableError", e instanceof ApiKeyUnavailableError);
  check("minted session signed out", (callOf("signOut")?.args as { token: string })?.token === lastIssued!.at);
  check("lease released", row!.lease === false);
}

// ── Lease-Verlierer wartet ───────────────────────────────────────────────
console.log("lease loser waits");
reset(freshRow({ expIn: 30 }));
leaseFree = false;
{
  const fresh = freshRow({ expIn: 3600, sessionId: "sess-old" });
  onSleep = (i) => { if (i === 2) row!.sealed_session = fresh.sealed_session; };
  const info = await verifier().verify(KEY);
  check("picks up the session the winner stored", (info.extra as { supabaseAccessToken: string }).supabaseAccessToken === open<{ at: string }>(fresh.sealed_session!)!.at);
  check("polled every 500 ms (3 waits)", count("sleep") === 3);
  check("never refreshed or minted itself", count("refreshSession") === 0 && count("generateLink") === 0);
}

console.log("lease loser: key revoked while waiting");
reset(freshRow({ expIn: 30 }));
leaseFree = false;
onSleep = () => { row = null; };
{
  const e = await expectError(() => verifier().verify(KEY));
  check("→ InvalidTokenError", e instanceof InvalidTokenError);
}

console.log("lease loser times out");
reset(freshRow({ expIn: 30 }));
leaseFree = false;
{
  const start = clock;
  const e = await expectError(() => verifier().verify(KEY));
  check("→ ApiKeyUnavailableError after 10 s", e instanceof ApiKeyUnavailableError && clock - start === 10_000);
  check("20 polls", count("mcp_api_key_resolve") === 21);
}

// ── Datenbank weg → 5xx, nicht 401 ───────────────────────────────────────
console.log("database down");
reset(freshRow({ expIn: 3600 }));
resolveFails = true;
{
  const e = await expectError(() => verifier().verify(KEY));
  check("→ ApiKeyUnavailableError", e instanceof ApiKeyUnavailableError);
}

// ── HTTP-Status über requireBearerAuth ───────────────────────────────────
console.log("status codes via requireBearerAuth");
async function statusFor(token: string, v = verifier()): Promise<number> {
  const mw = requireBearerAuth({ verifier: { verifyAccessToken: (t: string) => v.verify(t) } });
  let status = 200;
  const res = {
    set() { return res; },
    status(s: number) { status = s; return res; },
    json() { return res; },
  };
  await mw({ headers: { authorization: `Bearer ${token}` } } as never, res as never, () => {});
  return status;
}
reset(freshRow({ expIn: 3600 }));
check("valid key → passes", (await statusFor(KEY)) === 200);
check("unknown key → 401", (await statusFor(OTHER_KEY)) === 401);
reset(freshRow({ expIn: 30 }));
leaseFree = false;
{
  const s = await statusFor(KEY);
  check("lease timeout → 5xx, not 401", s >= 500, `got ${s}`);
}
reset(freshRow({ expIn: 3600 }));
resolveFails = true;
{
  const s = await statusFor(KEY);
  check("database down → 5xx, not 401", s >= 500, `got ${s}`);
}

// ── keine Geheimnisse in Meldungen ───────────────────────────────────────
console.log("no secrets in messages");
{
  const texts = [
    ...errors.map((e) => (e instanceof Error ? `${e.message} ${e.stack ?? ""}` : String(e))),
    ...logged,
  ];
  const leaks = texts.filter((t) => secrets.some((s) => t.includes(s)));
  check(`no key, hash or token in ${texts.length} error/log messages`, leaks.length === 0, leaks[0]);
}

console.error = origError;
if (failed > 0) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log("\nall API key checks passed");
