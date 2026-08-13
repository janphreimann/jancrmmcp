# crm-mcp-server

MCP server exposing CRM tools (contacts, companies, deals, tasks, calendar
events, documents, folders) to AI agents (Claude, claude.ai connector) backed
by the same Supabase project as the main CRM webapp (`../janreimanncrm`).

Calendar events are special: they live on an external CalDAV server, and the
`calendar_events` table is only a sync mirror. `create_calendar_event`
(`src/tools/calendar.ts`) therefore does a CalDAV PUT first and then upserts
the mirror row (with `agentMeta()`). Deleting only the mirror row never works
— the next `sync-calendar` run resurrects the event — which is why the
AgentBadge reject path for calendar events in the webapp goes through the
`write-calendar` edge function instead of a plain DB delete.

## Deployment

This server and the CRM webapp (`../janreimanncrm`) are two **separate Vercel
projects**. Each has its own env vars configured in its own Vercel project
dashboard — there is no shared config and no repo-level `vercel.json` env
wiring for secrets.

Local `.env` files are gitignored and never deployed. Editing a local `.env`
(in either repo) has zero effect on production — changing a secret requires
updating it directly in the corresponding Vercel project's Environment
Variables, then triggering a fresh deploy (not a cached rebuild) for it to
take effect. This bit us once: rotating the Supabase key locally and
"redeploying" left the CRM webapp shipping a stale, now-dead legacy anon key
until the Vercel-side env var was updated directly.

Interactions are intentionally **not** creatable via this server — logging a
call/meeting/email as an interaction is a user-only action in the CRM UI.
Do not add a `create_interaction` tool back without explicit sign-off.

## Agent-provenance rule (always apply, no exceptions)

Every row this server inserts into a user-facing CRM table must be
distinguishable from a human-created row in the CRM UI, and requires human
approval before it's treated as fully trusted data.

This is implemented with two columns, present on every entity table
(`contacts`, `companies`, `deals`, `tasks`, `interactions`, `documents`,
`document_folders`, `calendar_events`):

- `created_by_agent boolean not null default false`
- `agent_approved boolean not null default false`

**Any new create-tool you add must spread `agentMeta()` (from `src/supabase.ts`)
into its insert payload:**

```ts
import { supabase, ORG_ID, agentMeta } from "../supabase.js";

const { data, error } = await supabase
  .from("some_table")
  .insert({ ...fields, organization_id: ORG_ID, ...agentMeta() })
  .select("id")
  .single();
```

If the new tool targets a table that doesn't have these two columns yet, add
them **before** wiring up the tool — do not skip the flag because a table is
new. DDL läuft wieder über Migrationsdateien in
`../janreimanncrm/supabase/migrations/`, die anschliessend über den
Management-Query-Endpunkt eingespielt werden — nicht über den
Dashboard-SQL-Editor, sonst fehlt die Änderung im Repo. Danach die generierten
Typen neu erzeugen (`supabase gen types typescript --project-id <ref>`) und
`../janreimanncrm/supabase/schema_export.sql` über
`supabase/gen_schema_export.py` neu ziehen.

## Mandantentrennung

Dieser Server läuft mit `service_role` — **RLS greift hier nicht**. Die
Trennung muss deshalb in jeder Query von Hand passieren:

- Tabellen mit `organization_id` → `.eq("organization_id", ORG_ID)`.
- Nutzergebundene Tabellen ohne diese Spalte (`calendar_events`,
  `caldav_accounts`, `ms_email_accounts`) → `.in("user_id", await orgUserIds())`
  (aus `src/supabase.ts`). Ohne diesen Filter greifen die Tools auf Kalender
  und Postfächer *aller* Organisationen zu; genau das war in `calendar.ts` und
  `mail.ts` der Fall.

CalDAV-Zugangsdaten stehen verschlüsselt in der DB. Die Klartextspalte
`caldav_accounts.password` ist leer — gelesen wird über die RPC
`get_caldav_accounts(p_user_id)`, niemals direkt aus der Tabelle.

The CRM frontend renders an "Agent" badge with an Approve button
(`src/components/shared/AgentBadge.tsx` in `../janreimanncrm`) for any row where
`created_by_agent = true` and `agent_approved = false`. Once a human clicks
Approve, `agent_approved` flips to `true` and the badge disappears
permanently — approval is a one-way switch, there's no "unapprove".

Update-tools (`update_contact`, `update_deal`, etc.) do not touch these
columns — they only matter at creation time.
