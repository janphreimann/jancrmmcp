import { z } from "zod";
import { supabaseUrl } from "../supabase.js";
import type { Ctx } from "../context.js";

/**
 * Löst account_id wie createEmailDraft auf: eigene Konten nur, ms_email_accounts
 * hängt am Nutzer und nicht an der Organisation. Ohne account_id gewinnt das
 * als "default" markierte Konto, sonst das älteste.
 */
async function resolveAccountId(ctx: Ctx, accountId: string | undefined): Promise<string> {
  if (accountId) {
    const { data, error } = await ctx.db
      .from("ms_email_accounts")
      .select("id")
      .eq("id", accountId)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error || !data) throw new Error(`Email account ${accountId} not found.`);
    return data.id;
  }

  const { data, error } = await ctx.db
    .from("ms_email_accounts")
    .select("id")
    .eq("user_id", ctx.userId)
    .order("is_default", { ascending: false })
    .order("created_at", { ascending: true })
    .limit(1);
  if (error || !data?.length) throw new Error("No email account configured. Add one in the CRM settings.");
  return data[0].id;
}

export const createEmailDraftSchema = z.object({
  to: z.array(z.string()).optional().default([]).describe("Recipient email addresses"),
  cc: z.array(z.string()).optional().default([]).describe("CC email addresses"),
  subject: z.string().optional().default("").describe("Email subject"),
  body_html: z.string().optional().default("").describe("Email body — plain text or HTML"),
  account_id: z.string().uuid().optional().describe("Email account UUID — omit to use the default account"),
});

export async function createEmailDraft(ctx: Ctx, args: z.infer<typeof createEmailDraftSchema>) {
  // Nur das eigene Postfach: ms_email_accounts hängt am Nutzer, nicht an der
  // Organisation, und filtert per RLS auf auth.uid(). Der Filter steht
  // trotzdem explizit da — auch innerhalb einer Organisation soll niemand aus
  // dem Postfach eines Kollegen schreiben.
  let accountId: string;
  if (args.account_id) {
    const { data, error } = await ctx.db
      .from("ms_email_accounts")
      .select("id")
      .eq("id", args.account_id)
      .eq("user_id", ctx.userId)
      .maybeSingle();
    if (error || !data) throw new Error(`Email account ${args.account_id} not found.`);
    accountId = data.id;
  } else {
    const { data, error } = await ctx.db
      .from("ms_email_accounts")
      .select("id")
      .eq("user_id", ctx.userId)
      .order("is_default", { ascending: false })
      .order("created_at", { ascending: true })
      .limit(1);
    if (error || !data?.length) throw new Error("No email account configured. Add one in the CRM settings.");
    accountId = data[0].id;
  }

  const payload = {
    account_id: accountId,
    to: args.to,
    cc: args.cc,
    subject: args.subject,
    body_html: args.body_html,
  };

  // Retry once on 503 — platform-level gateway errors (cold-start crash, transient
  // overload) return a fast 503 with HTML before the function code even runs.
  // A single retry after 2 s resolves these reliably without hiding real failures.
  for (let attempt = 1; attempt <= 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30_000);
    let resp: Response;
    try {
      // Mit dem JWT des Nutzers, nicht mit dem Service-Key: die Edge Function
      // löst das Konto dann selbst über auth.uid() auf und akzeptiert keine
      // fremde account_id mehr.
      resp = await fetch(`${supabaseUrl}/functions/v1/mail-create-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${ctx.accessToken}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (resp.status === 503) {
      if (attempt === 1) {
        await new Promise((r) => setTimeout(r, 2_000));
        continue;
      }
      // Both attempts got 503 — platform-level failure, empty body, no JSON to parse.
      const preview = (await resp.text()).slice(0, 200).trim();
      throw new Error(
        preview
          ? `Edge function returned non-JSON (HTTP 503): ${preview}`
          : "Edge function returned 503 on both attempts — Supabase platform may be degraded"
      );
    }

    const rawText = await resp.text();
    let result: { appended?: boolean; queued?: boolean; folder?: string; error?: string };
    try {
      result = JSON.parse(rawText);
    } catch {
      throw new Error(`Edge function returned non-JSON (HTTP ${resp.status}): ${rawText.slice(0, 200)}`);
    }
    // No retry on IMAP-level errors here: the edge function already retries
    // internally and falls back to a server-side draft queue. Extra retries
    // from this side only feed the mail provider's login rate limiting.
    if (!resp.ok || result.error) throw new Error(result.error ?? `Edge function HTTP ${resp.status}`);

    if (result.queued) {
      return {
        success: true,
        queued: true,
        account_id: accountId,
        message:
          `Draft accepted. The mail provider is currently rate-limiting connections, so the draft ` +
          `was queued server-side and will appear in "${result.folder}" automatically ` +
          `(usually within seconds, at most ~5 minutes). No action needed — do not retry.`,
      };
    }

    return {
      success: true,
      folder: result.folder,
      account_id: accountId,
      message: `Draft saved to "${result.folder}"`,
    };
  }

  throw new Error("Edge function returned 503 on both attempts — Supabase platform may be degraded");
}

export const listEmailsSchema = z.object({
  account_id: z.string().uuid().optional().describe("Email account UUID — omit to use the default account"),
  folder: z.string().optional().describe("Folder name (e.g. 'INBOX', 'Sent') or folder UUID — omit to search all folders of the account"),
  search: z.string().optional().describe("Matches subject, sender name or sender address (case-insensitive substring)"),
  unread_only: z.boolean().optional().default(false),
  limit: z.number().int().min(1).max(50).default(20),
});

export async function listEmails(ctx: Ctx, args: z.infer<typeof listEmailsSchema>) {
  const accountId = await resolveAccountId(ctx, args.account_id);

  let folderId: string | undefined;
  if (args.folder) {
    // UUID durchreichen, sonst per Name innerhalb des Kontos auflösen — nie
    // kontoübergreifend, sonst könnte ein Name aus dem Konto eines anderen
    // Nutzers eine fremde folder_id liefern (die RLS unten fängt das zwar
    // ohnehin ab, aber so bleibt "unbekannter Ordner" eine klare Meldung).
    const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(args.folder);
    if (isUuid) {
      folderId = args.folder;
    } else {
      const { data, error } = await ctx.db
        .from("email_folders")
        .select("id")
        .eq("account_id", accountId)
        .or(`name.ilike.%${args.folder}%,display_name.ilike.%${args.folder}%`)
        .limit(1);
      if (error) throw new Error(error.message);
      if (!data?.length) throw new Error(`Folder "${args.folder}" not found in this account.`);
      folderId = data[0].id;
    }
  }

  let q = ctx.db
    .from("email_messages")
    .select("id, subject, from_name, from_address, body_preview, received_at, is_read, has_attachments, folder_id")
    .eq("account_id", accountId)
    .order("received_at", { ascending: false, nullsFirst: false })
    .limit(args.limit);

  if (folderId) q = q.eq("folder_id", folderId);
  if (args.unread_only) q = q.eq("is_read", false);
  if (args.search) {
    const term = `%${args.search}%`;
    q = q.or(`subject.ilike.${term},from_name.ilike.${term},from_address.ilike.${term}`);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  return (data ?? []).map((m) => ({
    id: m.id,
    subject: m.subject,
    from_name: m.from_name,
    from_address: m.from_address,
    preview: m.body_preview,
    received_at: m.received_at,
    is_read: m.is_read,
    has_attachments: m.has_attachments,
  }));
}

export const getEmailSchema = z.object({
  id: z.string().uuid(),
});

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

  return {
    id: message.id,
    subject: message.subject,
    from_name: message.from_name,
    from_address: message.from_address,
    to_addresses: message.to_addresses,
    cc_addresses: message.cc_addresses,
    bcc_addresses: message.bcc_addresses,
    body_text: message.body_text,
    body_html: message.body_html,
    body_preview: message.body_preview,
    received_at: message.received_at,
    is_read: message.is_read,
    is_answered: message.is_answered,
    is_flagged: message.is_flagged,
    thread_topic: message.thread_topic,
    attachments: attachments ?? [],
  };
}
