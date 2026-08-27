import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabaseUrl = SUPABASE_URL;
export const supabaseAnonKey = SUPABASE_ANON_KEY;

/**
 * service_role — RLS greift hier *nicht*.
 *
 * Nur für die eine Stelle, an der ein Nutzer-JWT nicht reicht: die
 * entschlüsselten CalDAV-Zugangsdaten aus dem Vault (`get_caldav_accounts`).
 * Jede Abfrage darüber muss selbst auf `ctx.userId` filtern — sonst greift sie
 * auf die Postfächer und Kalender *aller* Organisationen zu.
 */
export const admin: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/**
 * Anonymer Client für den Login auf der OAuth-Seite. Bewusst eine Fabrik und
 * kein Singleton: `signInWithOtp` und `refreshSession` legen die Sitzung im
 * Client ab, ein geteilter Client würde parallele Anmeldungen vermischen.
 *
 * `flowType: "implicit"` ist Absicht, nicht der Default: der Server ist
 * zustandslos (Vercel), ein PKCE-`code_verifier` aus `signInWithOtp` wäre bis
 * zum Klick auf den Magic-Link (nächster, komplett neuer Aufruf) schon
 * verloren. Der klassische implizite Fluss legt die Session stattdessen als
 * URL-Fragment auf die Rückkehrseite — siehe oauth.ts `magicCallbackPage()`.
 */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false, flowType: "implicit" },
  });
}

/** Supabase-Client, der als der Nutzer des übergebenen Access-Tokens spricht. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(SUPABASE_URL!, SUPABASE_ANON_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Every row this MCP server inserts into a user-facing CRM table must go
 * through this helper so it carries provenance: `created_by_agent: true`
 * flags it as AI-created, `agent_approved: false` means the CRM UI shows an
 * "Agent" badge with an Approve action until a human confirms it. Any new
 * create-tool added later must spread this into its insert payload — do not
 * insert into contacts/companies/deals/tasks/interactions/documents/
 * document_folders without it.
 */
export function agentMeta() {
  return { created_by_agent: true, agent_approved: false };
}
