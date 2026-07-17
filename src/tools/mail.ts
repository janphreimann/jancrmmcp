import { z } from "zod";
import { supabase } from "../supabase.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export const createEmailDraftSchema = z.object({
  to: z.array(z.string()).optional().default([]).describe("Recipient email addresses"),
  cc: z.array(z.string()).optional().default([]).describe("CC email addresses"),
  subject: z.string().optional().default("").describe("Email subject"),
  body_html: z.string().optional().default("").describe("Email body — plain text or HTML"),
  account_id: z.string().uuid().optional().describe("Email account UUID — omit to use the default account"),
});

export async function createEmailDraft(args: z.infer<typeof createEmailDraftSchema>) {
  // Resolve the email account to use
  let accountId: string;
  if (args.account_id) {
    const { data, error } = await supabase
      .from("ms_email_accounts")
      .select("id")
      .eq("id", args.account_id)
      .maybeSingle();
    if (error || !data) throw new Error(`Email account ${args.account_id} not found.`);
    accountId = data.id;
  } else {
    const { data, error } = await supabase
      .from("ms_email_accounts")
      .select("id")
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
      resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
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
