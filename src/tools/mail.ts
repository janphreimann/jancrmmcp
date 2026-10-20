import { z } from "zod";
import type { Ctx } from "../context.js";
import { callEdgeFunction } from "./edge.js";
import { orTerm } from "./queryHelpers.js";
import { berlinToIso, nextDay } from "../berlinTime.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The caller's own mail accounts. ms_email_accounts is bound to the user, not
 * the organization; RLS filters on auth.uid() as well, the explicit
 * `user_id = ctx.userId` keeps the query from depending on there being one
 * user. With `accountId`, only that one (and only if it is the caller's).
 */
async function ownAccountIds(ctx: Ctx, accountId?: string): Promise<string[]> {
  let q = ctx.db
    .from("ms_email_accounts")
    .select("id")
    .eq("user_id", ctx.userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true });
  if (accountId) q = q.eq("id", accountId);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const ids = (data ?? []).map((r: { id: string }) => r.id);
  if (accountId && !ids.length) throw new Error(`Email account ${accountId} not found.`);
  if (!ids.length) throw new Error("No email account configured. Add one in the CRM settings.");
  return ids;
}

export const createEmailDraftSchema = z.object({
  to: z.array(z.string()).optional().default([]).describe("Recipient email addresses"),
  cc: z.array(z.string()).optional().default([]).describe("CC email addresses"),
  subject: z.string().optional().default("").describe("Email subject (with reply_to: leave empty for \"Re: <original>\")"),
  body_html: z.string().optional().default("").describe("Email body — plain text or HTML"),
  account_id: z.string().uuid().optional().describe("Email account UUID — omit for the default account (with reply_to: the account the original arrived in)"),
  reply_to: z.string().uuid().optional().describe(
    "Email id (list_emails/get_email) to answer: threading headers, the \"Re:\" subject and the original's sender as recipient are set from it; to/cc you pass are added"
  ),
  reply_all: z.boolean().optional().default(false).describe("With reply_to: also address everyone else on the original (To → To, Cc → Cc)"),
  quote_original: z.boolean().optional().default(false).describe("With reply_to: quote the original's text below yours"),
});

/**
 * What goes to mail-create-draft. Only references the original by id — the
 * edge function loads it with the caller's token and builds In-Reply-To,
 * References, subject and recipients itself; no header comes from here.
 */
export function draftPayload(args: z.infer<typeof createEmailDraftSchema>, accountId: string | undefined) {
  const payload: Record<string, unknown> = {
    to: args.to ?? [],
    cc: args.cc ?? [],
    subject: args.subject ?? "",
    body_html: args.body_html ?? "",
  };
  if (accountId) payload.account_id = accountId;
  if (args.reply_to) {
    payload.reply_to = args.reply_to;
    payload.reply_all = args.reply_all ?? false;
    payload.quote_original = args.quote_original ?? false;
  } else if (args.reply_all || args.quote_original) {
    throw new Error("reply_all and quote_original need reply_to (the id of the mail you answer).");
  }
  return payload;
}

export async function createEmailDraft(ctx: Ctx, args: z.infer<typeof createEmailDraftSchema>) {
  // Own accounts only. A reply without account_id goes out of the account the
  // original arrived in — the edge function resolves that from the message.
  const accountId = args.account_id
    ? (await ownAccountIds(ctx, args.account_id))[0]
    : args.reply_to ? undefined : (await ownAccountIds(ctx))[0];

  const { ok, status, json: result } = await callEdgeFunction<{
    appended?: boolean; queued?: boolean; folder?: string; error?: string;
    account_id?: string; to?: string[]; cc?: string[]; subject?: string;
  }>(ctx, "mail-create-draft", draftPayload(args, accountId));
  // No retry on IMAP-level errors here: the edge function already retries
  // internally and falls back to a server-side draft queue. Extra retries
  // from this side only feed the mail provider's login rate limiting.
  if (!ok || result.error) throw new Error(result.error ?? `Edge function HTTP ${status}`);

  const usedAccount = result.account_id ?? accountId;
  const reply = args.reply_to ? { to: result.to, cc: result.cc, subject: result.subject } : {};
  if (result.queued) {
    return {
      success: true,
      queued: true,
      account_id: usedAccount,
      ...reply,
      message:
        `Draft accepted. The mail provider is currently rate-limiting connections, so the draft ` +
        `was queued server-side and will appear in "${result.folder}" automatically ` +
        `(usually within seconds, at most ~5 minutes). No action needed — do not retry.`,
    };
  }
  return { success: true, folder: result.folder, account_id: usedAccount, ...reply, message: `Draft saved to "${result.folder}"` };
}

/** Longest window list_emails accepts for a date range, in days. */
export const EMAIL_RANGE_MAX_DAYS = 366;

export const listEmailsSchema = z.object({
  search: z.string().max(200).optional().describe(
    "Full-text search in subject and body (every word must occur; word prefixes match: \"angeb\" finds \"Angebot\")"
  ),
  account_id: z.string().uuid().optional().describe("Only this account — omit to search all of your accounts"),
  folder: z.string().optional().describe("Folder name (e.g. 'INBOX', 'Sent') or folder UUID; needs account_id when given by name"),
  from: z.string().optional().describe("Received on/after this date (YYYY-MM-DD, Berlin) or ISO timestamp"),
  to: z.string().optional().describe("Received on/before this date (YYYY-MM-DD, whole day, Berlin) or ISO timestamp"),
  contact_id: z.string().uuid().optional().describe("Only mails from/to this contact's email addresses"),
  thread: z.string().optional().describe(
    "A thread_key from an earlier result, or an email id: returns that whole conversation, oldest first"
  ),
  unread_only: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(50).default(20),
});

/**
 * A date-only bound is a Berlin calendar day (`to` includes that whole day:
 * the bound is the next midnight, exclusive); anything else must parse as a
 * timestamp.
 */
export function emailRangeBound(value: string, edge: "from" | "to"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return berlinToIso(edge === "from" ? value : nextDay(value));
  const t = Date.parse(value);
  if (Number.isNaN(t)) throw new Error(`"${value}" is not a date (YYYY-MM-DD) or ISO timestamp.`);
  return new Date(t).toISOString();
}

/**
 * Arguments for search_emails() (CRM migration 20261107006400, SECURITY
 * INVOKER: the caller's RLS applies). Every filter runs in SQL, before the
 * limit; the account list is the caller's own (user_id = ctx.userId).
 */
export function searchEmailsArgs(args: z.infer<typeof listEmailsSchema>, accountIds: string[], folderId: string | null) {
  const from = args.from ? emailRangeBound(args.from, "from") : null;
  const to = args.to ? emailRangeBound(args.to, "to") : null;
  if (from && to && from > to) throw new Error("`from` is after `to`.");
  if (from && to && Date.parse(to) - Date.parse(from) > EMAIL_RANGE_MAX_DAYS * 86_400_000) {
    throw new Error(`Date range too long — at most ${EMAIL_RANGE_MAX_DAYS} days.`);
  }
  const thread = args.thread?.trim() || null;
  const search = args.search?.trim() || null;
  return {
    p_account_ids: accountIds,
    p_query: search,
    p_folder_id: folderId,
    p_from: from,
    p_to: to,
    p_contact_id: args.contact_id ?? null,
    p_thread: thread && !UUID_RE.test(thread) ? thread : null,
    p_thread_message_id: thread && UUID_RE.test(thread) ? thread : null,
    p_unread_only: args.unread_only ?? false,
    p_limit: args.limit ?? 20,
  };
}

type EmailRow = {
  id: string; account_id: string; subject: string | null; from_name: string | null; from_address: string | null;
  to_addresses: string[] | null; preview: string | null; received_at: string | null; is_read: boolean;
  has_attachments: boolean; direction: string | null; thread_key: string;
};

export async function listEmails(ctx: Ctx, args: z.infer<typeof listEmailsSchema>) {
  const accountIds = await ownAccountIds(ctx, args.account_id);

  let folderId: string | null = null;
  if (args.folder) {
    if (UUID_RE.test(args.folder)) {
      folderId = args.folder;
    } else {
      // By name only within one account: "INBOX" exists in each of them.
      if (!args.account_id) throw new Error("A folder by name needs account_id (or pass the folder UUID).");
      const term = orTerm(args.folder);
      const { data, error } = await ctx.db
        .from("email_folders")
        .select("id")
        .eq("account_id", accountIds[0])
        .or(`name.ilike.%${term}%,display_name.ilike.%${term}%`)
        .limit(1);
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`Folder "${args.folder}" not found in this account.`);
      folderId = data[0].id;
    }
  }

  const { data, error } = await ctx.db.rpc("search_emails", searchEmailsArgs(args, accountIds, folderId));
  if (error) throw new Error(error.message);

  return ((data ?? []) as EmailRow[]).map((m) => ({
    id: m.id,
    subject: m.subject,
    from_name: m.from_name,
    from_address: m.from_address,
    ...(m.direction === "outbound" ? { to: m.to_addresses ?? [] } : {}),
    preview: m.preview,
    received_at: m.received_at,
    is_read: m.is_read,
    has_attachments: m.has_attachments,
    thread_key: m.thread_key,
    ...(accountIds.length > 1 ? { account_id: m.account_id } : {}),
  }));
}

export const getEmailSchema = z.object({
  id: z.string().uuid(),
  include_html: z.boolean().optional().default(false).describe(
    "Also return body_html. Off by default: the plain text carries the content, and HTML mails are often many times larger."
  ),
});

// One mail must not crowd out the rest of the conversation: bodies beyond
// this are cut with a visible marker.
export const EMAIL_BODY_MAX_CHARS = 50_000;

export function capBody(text: string | null | undefined, max = EMAIL_BODY_MAX_CHARS): { text: string | null; truncated: boolean } {
  if (text == null) return { text: null, truncated: false };
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n…[truncated — ${text.length - max} more characters]`, truncated: true };
}

/** Rough text of an HTML-only mail, for when body_text is empty. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'").replace(/&amp;/gi, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function getEmail(ctx: Ctx, args: z.infer<typeof getEmailSchema>) {
  // email_messages ist nutzergebunden über account_id -> ms_email_accounts,
  // nicht organisationsgebunden. RLS filtert bereits auf das eigene Konto,
  // aber die Zugehörigkeit wird hier zusätzlich explizit geprüft, damit eine
  // fremde id dasselbe "not found" ergibt wie eine nicht existierende — statt
  // sich auf RLS allein zu verlassen und ein verwirrendes leeres Ergebnis zu
  // riskieren.
  const { data: message, error } = await ctx.db
    .from("email_messages")
    .select(
      "id, account_id, folder_id, subject, from_name, from_address, to_addresses, cc_addresses, bcc_addresses, body_text, body_html, body_preview, received_at, is_read, is_answered, is_flagged, has_attachments, thread_topic"
    )
    .eq("id", args.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!message) throw new Error(`Email ${args.id} not found.`);

  const { data: account, error: accountError } = await ctx.db
    .from("ms_email_accounts")
    .select("id")
    .eq("id", message.account_id)
    .eq("user_id", ctx.userId)
    .maybeSingle();
  if (accountError) throw new Error(accountError.message);
  if (!account) throw new Error(`Email ${args.id} not found.`);

  const { data: attachments, error: attachmentsError } = await ctx.db
    .from("email_attachments")
    .select("id, filename, content_type, size_bytes, is_inline")
    .eq("message_id", message.id);
  if (attachmentsError) throw new Error(attachmentsError.message);

  const plain = message.body_text?.trim() ? message.body_text : message.body_html ? htmlToText(message.body_html) : message.body_text;
  const text = capBody(plain);
  const html = args.include_html ? capBody(message.body_html) : null;

  return {
    id: message.id,
    subject: message.subject,
    from_name: message.from_name,
    from_address: message.from_address,
    to_addresses: message.to_addresses,
    cc_addresses: message.cc_addresses,
    bcc_addresses: message.bcc_addresses,
    body_text: text.text,
    ...(text.truncated ? { body_text_truncated: true } : {}),
    ...(html ? { body_html: html.text, ...(html.truncated ? { body_html_truncated: true } : {}) } : {}),
    body_preview: message.body_preview,
    received_at: message.received_at,
    is_read: message.is_read,
    is_answered: message.is_answered,
    is_flagged: message.is_flagged,
    thread_topic: message.thread_topic,
    attachments: attachments ?? [],
  };
}
