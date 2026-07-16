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

  const resp = await fetch(`${SUPABASE_URL}/functions/v1/mail-create-draft`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      account_id: accountId,
      to: args.to,
      cc: args.cc,
      subject: args.subject,
      body_html: args.body_html,
    }),
  });

  const rawText = await resp.text();
  let result: { appended?: boolean; folder?: string; error?: string };
  try {
    result = JSON.parse(rawText);
  } catch {
    throw new Error(`Edge function returned non-JSON (HTTP ${resp.status}): ${rawText.slice(0, 200)}`);
  }
  if (!resp.ok || result.error) throw new Error(result.error ?? `Edge function HTTP ${resp.status}`);

  return {
    success: true,
    folder: result.folder,
    account_id: accountId,
    message: `Draft saved to "${result.folder}"`,
  };
}
