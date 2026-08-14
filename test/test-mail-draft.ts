/**
 * Integration tests for the create_email_draft MCP tool.
 *
 * Run with: npm test
 * Requires: .env file with SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY
 *
 * ⚠️ VERALTET seit der Mandantentrennung (siehe CLAUDE.md, "Mandantentrennung").
 * Zwei Annahmen dieser Datei gelten nicht mehr:
 *   1. `createEmailDraft` nimmt jetzt einen `Ctx` als erstes Argument — die
 *      Aufrufe unten kompilieren nicht mehr.
 *   2. Die Aufrufe von `mail-create-draft` mit dem Service-Key laufen ins Leere:
 *      die Edge Function löst das Postfach ausschließlich über `auth.uid()` auf,
 *      der service_role-Zweig ist entfernt.
 * Wer sie wiederbeleben will, braucht eine echte Nutzersitzung
 * (`signInWithPassword`) und baut daraus einen Ctx. Bis dahin ist das hier eine
 * Diagnose-Datei aus einem 503-Vorfall, kein laufender Test.
 */

// Must be the first import — loads .env before supabase.ts reads process.env
import "dotenv/config";

import { createClient } from "@supabase/supabase-js";
import { createEmailDraft } from "../src/tools/mail.js";

// ─── Minimal test harness ──────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
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

// ─── Setup ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SRK = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const admin = createClient(SUPABASE_URL, SRK, { auth: { persistSession: false } });

// ─── Tests ────────────────────────────────────────────────────────────────

console.log("\n=== 1. Environment & configuration ===");

await test("SUPABASE_URL is set and looks valid", async () => {
  assert(!!SUPABASE_URL, "SUPABASE_URL is not set");
  assert(
    /^https:\/\/.+\.supabase\.co$/.test(SUPABASE_URL),
    `SUPABASE_URL does not look like a Supabase URL: ${SUPABASE_URL}`
  );
});

await test("SUPABASE_SERVICE_ROLE_KEY is set", async () => {
  assert(!!SRK, "SUPABASE_SERVICE_ROLE_KEY is not set");
  // Decode JWT role claim without verifying signature
  const payload = JSON.parse(
    Buffer.from(SRK.split(".")[1], "base64url").toString()
  );
  assert(
    payload.role === "service_role",
    `Key has role "${payload.role}", expected "service_role"`
  );
});

console.log("\n=== 2. Database: email account prerequisites ===");

await test("ms_email_accounts table is accessible", async () => {
  const { error } = await admin.from("ms_email_accounts").select("id").limit(1);
  assert(!error, `DB query failed: ${error?.message}`);
});

await test("at least one email account exists (default account)", async () => {
  const { data, error } = await admin
    .from("ms_email_accounts")
    .select("id, imap_username, imap_host, imap_port, is_default")
    .order("is_default", { ascending: false })
    .limit(1);
  assert(!error, `DB query failed: ${error?.message}`);
  assert(Array.isArray(data) && data.length > 0, "No email accounts found");
  assert(!!data[0].imap_host, "Account has no imap_host");
  assert(!!data[0].imap_username, "Account has no imap_username");
  assert(data[0].imap_port > 0, "Account has invalid imap_port");
});

await test("drafts folder is cached in email_folders", async () => {
  const { data: accounts } = await admin
    .from("ms_email_accounts")
    .select("id")
    .order("is_default", { ascending: false })
    .limit(1);
  if (!accounts?.length) throw new Error("No email account — covered by previous test");

  const { data: folders, error } = await admin
    .from("email_folders")
    .select("name, role")
    .eq("account_id", accounts[0].id)
    .eq("role", "drafts")
    .maybeSingle();

  assert(!error, `Folder query failed: ${error?.message}`);
  assert(!!folders, "No drafts folder cached — run imap-discover-folders first");
  assert(typeof folders.name === "string" && folders.name.length > 0, "Folder name is empty");
});

console.log("\n=== 3. Edge function: error handling (no IMAP needed) ===");

await test("returns 400 JSON when account_id is missing (service-role caller)", async () => {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: [], subject: "", body_html: "" }),
  });
  assert(resp.status === 400, `Expected 400, got ${resp.status}`);
  const body = await resp.json() as any;
  assert(body.error === "account_id required", `Unexpected error: ${body.error}`);
});

await test("returns 404 JSON for non-existent account_id", async () => {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: "00000000-0000-0000-0000-000000000000",
      to: [],
      subject: "",
      body_html: "",
    }),
  });
  assert(resp.status === 404, `Expected 404, got ${resp.status}`);
  const body = await resp.json() as any;
  assert(body.error === "no email account found", `Unexpected error: ${body.error}`);
});

await test("returns proper JSON (not 503) — confirms function is deployed & not in bad state", async () => {
  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: [], subject: "", body_html: "" }),
  });
  const contentType = resp.headers.get("content-type") ?? "";
  const body = await resp.text();
  assert(resp.status !== 503, `Got 503 — function is not running or crashed on cold start. Body: ${body.slice(0, 200)}`);
  assert(contentType.includes("application/json"), `Expected JSON response, got: ${contentType}. Body: ${body.slice(0, 200)}`);
});

console.log("\n=== 4. Edge function: IMAP draft creation (full round-trip) ===");

await test("appends a draft to the IMAP Drafts folder via edge function directly", async () => {
  const { data: accounts } = await admin
    .from("ms_email_accounts")
    .select("id")
    .order("is_default", { ascending: false })
    .limit(1);
  assert(!!accounts?.length, "No email account — covered earlier");

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: accounts[0].id,
      to: ["schiller@staedelmuseum.de"],
      cc: [],
      subject: "Test draft (integration)",
      body_html: "<p>This is an automated test draft. You can delete it.</p>",
    }),
  });
  const body = await resp.json() as any;
  assert(resp.status === 200, `Expected 200, got ${resp.status}. Error: ${body?.error}`);
  // queued=true is the legitimate fallback while the provider rate-limits
  // connections: the draft is appended by imap-sync-account within minutes.
  assert(
    body.appended === true || body.queued === true,
    `Expected appended or queued, got ${JSON.stringify(body)}`
  );
  assert(typeof body.folder === "string", `Expected folder string, got ${JSON.stringify(body.folder)}`);
  if (body.queued) console.log("     → (provider rate-limited; draft went through the queue)");
});

console.log("\n=== 5. MCP tool: end-to-end (exact parameters from the reported 503 failure) ===");

await test("createEmailDraft — same params as the failing request (no account_id, uses default)", async () => {
  const result = await createEmailDraft({
    to: ["schiller@staedelmuseum.de"],
    cc: [],
    subject: "Hallo",
    body_html: "Hallo Herr Schiller,\n\nich hoffe, es geht Ihnen gut.\n\nBeste Grüße",
  });

  assert(result.success === true, `Expected success=true, got ${JSON.stringify(result)}`);
  assert(typeof result.account_id === "string", "Expected account_id string");
  if ((result as any).queued) {
    assert(/queued server-side/.test(result.message), `Unexpected queued message: ${result.message}`);
    console.log("     → (provider rate-limited; draft was queued server-side)");
  } else {
    assert(typeof result.folder === "string" && result.folder.length > 0, `Expected folder string`);
    assert(result.message.startsWith("Draft saved to"), `Unexpected message: ${result.message}`);
    console.log(`     → Draft saved to folder: "${result.folder}"`);
  }
});

console.log("\n=== 6. Queue fallback: simulated provider block (no IMAP login used) ===");

await test("simulate_transient=true queues the draft; sync appends it", async () => {
  const { data: accounts } = await admin
    .from("ms_email_accounts")
    .select("id")
    .order("is_default", { ascending: false })
    .limit(1);
  assert(!!accounts?.length, "No email account — covered earlier");

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${SRK}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      account_id: accounts[0].id,
      to: ["test@example.com"],
      subject: "Queue fallback test (integration)",
      body_html: "Automated test draft via queue. You can delete it.",
      simulate_transient: true,
    }),
  });
  const body = await resp.json() as any;
  assert(resp.status === 200, `Expected 200, got ${resp.status}. Error: ${body?.error}`);
  assert(body.queued === true, `Expected queued=true, got ${JSON.stringify(body)}`);
  assert(typeof body.message_id === "string", "Expected message_id in queued response");

  // The edge function fire-and-forgets an imap-sync-account run; poll the
  // queue row. If another sync holds the lock the append can wait for the
  // next 5-min tick, so a still-pending row is not a failure here.
  let status = "pending";
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    const { data: row } = await admin
      .from("email_draft_queue")
      .select("status, last_error")
      .eq("message_id_header", body.message_id)
      .single();
    status = row?.status ?? "missing";
    if (status === "appended" || status === "failed") break;
  }
  assert(status !== "failed" && status !== "missing", `Queue row ended up ${status}`);
  console.log(
    status === "appended"
      ? "     → queued draft was appended by imap-sync-account"
      : "     → still pending (sync lock busy) — will be appended on the next tick"
  );

  // Tidy up processed test rows so they don't accumulate.
  await admin.from("email_draft_queue").delete()
    .eq("message_id_header", body.message_id).eq("status", "appended");
});

// ─── Summary ──────────────────────────────────────────────────────────────

console.log(`\n${"─".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(`\n${failed} test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nAll tests passed ✓");
}
