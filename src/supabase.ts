import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}

export const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const ORG_ID = process.env.ORGANIZATION_ID;

if (!ORG_ID) {
  throw new Error("ORGANIZATION_ID env variable must be set");
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
