// get_email returns plain text by default (HTML on request), both capped;
// get_document_content pages long texts like get_audio_recording.
import "dotenv/config";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Ctx } from "../src/context.js";
import { getEmail, getEmailSchema, capBody, htmlToText, EMAIL_BODY_MAX_CHARS } from "../src/tools/mail.js";
import { getDocumentContent, getDocumentContentSchema } from "../src/tools/documents.js";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${ok || !detail ? "" : "\n       " + detail}`);
  if (!ok) failed++;
}

let rows: Record<string, unknown> = {};
function builder(table: string) {
  const b: Record<string, unknown> = {};
  for (const m of ["select", "eq", "is", "order", "limit"]) b[m] = () => b;
  const res = () => Promise.resolve({ data: rows[table] ?? null, error: null });
  b.maybeSingle = res;
  b.single = res;
  b.then = (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => res().then(ok, ko);
  return b;
}
const fakeDb = {
  from: builder,
  storage: { from: () => ({ createSignedUrl: async () => ({ data: { signedUrl: "https://signed" }, error: null }) }) },
} as unknown as SupabaseClient;
const ctx: Ctx = { userId: "u1", orgId: "o1", db: fakeDb, admin: fakeDb, accessToken: "t" };
const ID = "11111111-1111-4111-8111-111111111111";

// ── get_email ────────────────────────────────────────────────────────────
const bigText = "word ".repeat(20_000); // 100,000 chars
rows = {
  email_messages: { id: ID, account_id: "a1", subject: "S", body_text: bigText, body_html: `<p>${bigText}</p>`, body_preview: "p" },
  ms_email_accounts: { id: "a1" },
  email_attachments: [],
};
let mail = (await getEmail(ctx, getEmailSchema.parse({ id: ID }))) as Record<string, unknown>;
check("get_email: no HTML by default", !("body_html" in mail));
check("get_email: text capped with a marker",
  typeof mail.body_text === "string" && (mail.body_text as string).length < EMAIL_BODY_MAX_CHARS + 100
  && /…\[truncated — 50000 more characters\]$/.test(mail.body_text as string) && mail.body_text_truncated === true);
mail = (await getEmail(ctx, getEmailSchema.parse({ id: ID, include_html: true }))) as Record<string, unknown>;
check("get_email: HTML on request, capped too", typeof mail.body_html === "string" && mail.body_html_truncated === true);

rows.email_messages = { id: ID, account_id: "a1", subject: "S", body_text: null, body_html: "<html><head><style>x{}</style></head><body><p>Hallo&nbsp;Anna,</p><p>Termin &amp; Agenda</p></body></html>" };
mail = (await getEmail(ctx, getEmailSchema.parse({ id: ID }))) as Record<string, unknown>;
check("get_email: HTML-only mail gets a text body", mail.body_text === "Hallo Anna,\nTermin & Agenda", JSON.stringify(mail.body_text));
check("get_email: short body untouched", capBody("abc").text === "abc" && !capBody("abc").truncated);
check("htmlToText decodes &amp; last", htmlToText("&amp;lt;") === "&lt;");

// ── get_document_content ─────────────────────────────────────────────────
const longDoc = Array.from({ length: 3000 }, (_, i) => `Paragraph ${i} ${"x".repeat(40)}`).join("\n\n");
rows = { documents: { id: ID, file_name: "a.pdf", file_url: "o1/x/a.pdf", extracted_text: longDoc } };
const p1 = (await getDocumentContent(ctx, getDocumentContentSchema.parse({ id: ID }))) as Record<string, unknown>;
check("document: first page", p1.offset === 0 && p1.has_more === true && (p1.content as string).length <= 40_000 && p1.total_chars === longDoc.length);
const p2 = (await getDocumentContent(ctx, getDocumentContentSchema.parse({ id: ID, offset: p1.next_offset as number, max_chars: 60_000 }))) as Record<string, unknown>;
check("document: next page continues where the first ended", p2.offset === p1.next_offset && (p2.content as string).startsWith("Paragraph"));
let pages = 1, cur = p1;
while (cur.has_more) { cur = (await getDocumentContent(ctx, getDocumentContentSchema.parse({ id: ID, offset: cur.next_offset as number }))) as Record<string, unknown>; pages++; }
check("document: last page has no next_offset", cur.next_offset === null && pages >= 3, String(pages));

rows = { documents: { id: ID, file_name: "a.pdf", file_url: "o1/x/a.pdf", extracted_text: "short" } };
const short = (await getDocumentContent(ctx, getDocumentContentSchema.parse({ id: ID }))) as Record<string, unknown>;
check("document: short text in one page", short.content === "short" && short.has_more === false);

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
console.log("\nall passed");
