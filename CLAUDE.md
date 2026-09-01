# crm-mcp-server

MCP server exposing CRM tools (contacts, companies, projects, tasks, calendar
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
(`contacts`, `companies`, `projects`, `tasks`, `interactions`, `documents`,
`document_folders`, `calendar_events`):

- `created_by_agent boolean not null default false`
- `agent_approved boolean not null default false`

**Any new create-tool you add must spread `agentMeta()` (from `src/supabase.ts`)
into its insert payload:**

```ts
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";

const { data, error } = await ctx.db
  .from("some_table")
  .insert({ ...fields, ...agentMeta() })
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

Dieser Server bedient **alle** Nutzer aus einem Deployment. Wer fragt, steht
ausschließlich im Bearer-Token; eine `ORGANIZATION_ID` aus der Umgebung gibt es
nicht mehr.

Die Kette:

```
OAuth-Login (E-Mail + CRM-Passwort, src/oauth.ts)
  → Supabase-Sitzung, verschlüsselt im MCP-Token
  → buildContext() (src/context.ts) → Ctx { userId, orgId, db, admin }
  → jedes Tool bekommt ctx als erstes Argument
```

`ctx.db` trägt das Access-Token des Nutzers, **RLS greift also genau wie im
Browser** — die Trennung liegt in der Datenbank, nicht im Tool-Code. Daraus
folgen drei Regeln:

- Kein `.eq("organization_id", …)` mehr in Queries und kein `organization_id`
  im Insert: Spalten-Default und `BEFORE INSERT`-Trigger setzen ihn aus
  `auth.uid()`. Ein von Hand gesetzter Wert würde die Zuordnung wieder an den
  Aufrufer hängen.
- Schreibende Tools prüfen `select("id")` auf ein leeres Ergebnis. Eine fremde
  UUID trifft durch die Policy auf null Zeilen — ohne die Prüfung meldet das
  Tool trotzdem Erfolg.
- Nutzergebundene Tabellen (`calendar_events`, `caldav_accounts`,
  `ms_email_accounts`) filtern zusätzlich explizit auf `ctx.userId`. Innerhalb
  einer Organisation lässt RLS sie zwar zu, aber aus dem Postfach eines
  Kollegen zu schreiben wäre trotzdem falsch.

`ctx.admin` (service_role, umgeht RLS) hat genau **eine** berechtigte
Verwendung: `get_caldav_accounts(p_user_id)` liefert das entschlüsselte
CalDAV-Passwort und ist für `authenticated` gesperrt. Der Parameter ist dort
fest `ctx.userId` und darf nie aus den Tool-Argumenten stammen. Wer `ctx.admin`
an einer weiteren Stelle braucht, begründet das hier — sonst ist `ctx.db`
richtig.

## Leitplanken am Anmeldeprozess

Der Login (`src/oauth.ts`) steht offen im Netz und stellt am Ende eine
vollwertige CRM-Sitzung aus. Er läuft als **Device-Code-Flow** (RFC 8628),
nicht per Magic-Link-Mail — letzterer scheiterte in der Praxis daran, dass
Mail-Clients (Outlook, iOS Mail, Gmail-App) Links routinemäßig in einem
anderen Browser-Kontext öffnen als dem, in dem die Anmeldung begann. Zwei
Schranken sichern den Flow ab — keine davon ohne Ersatz entfernen:

- **Redirect-URI-Allowlist** (`redirectUriAllowed`). Die Dynamic Client
  Registration ist offen, also darf `redirect_uri` nicht frei wählbar sein.
  Geprüft wird dreifach — bei `registerClient`, bei `getClient` (damit früher
  ausgestellte `client_id`s nicht weitergelten) und noch einmal in
  `handleDevicePoll`, bevor der Code ausgestellt wird. Ein weiterer Client
  kommt über `MCP_ALLOWED_REDIRECT_HOSTS` dazu, nicht über eine Ausnahme im
  Code.
- **Keine vom Aufrufer wählbare Identität.** `oauthProvider.authorize()` ruft
  `create_mcp_device_grant` (Migration
  `../janreimanncrm/supabase/migrations/20261104000400_mcp_device_grants.sql`)
  ohne jede Nutzer-Angabe auf — nur die OAuth-Parameter des anfragenden
  Clients. Wessen Account verbunden wird, entscheidet ausschließlich, wer den
  angezeigten Code in der bereits eingeloggten CRM-Web-App einträgt
  (`claim_mcp_device_grant`): die Identität kommt dort einzig aus
  `auth.uid()`, nie aus einem Parameter. Ein erratener Code kann damit
  höchstens die eigene Session eines Angreifers in die fremde Zeile
  schreiben, nie umgekehrt fremde Tokens abgreifen. Bleibt strukturell
  ungelöst (Standardgrenze von Device-Code-Flows): wer jemanden dazu bringt,
  den Code *seines eigenen* Geräts einzutippen, bekommt dessen Session —
  dagegen hilft nur die deutliche Anzeige von Client-Name/Ziel auf der
  Pairing-Seite (`devicePendingPage`) und der Bestätigungskarte in der
  Web-App.

Der Pairing-Code ist 8-stellig (Crockford-Base32, `create_mcp_device_grant`),
10 Minuten gültig und einmal verwendbar; `poll_mcp_device_grant` löscht die
Zeile beim Abholen. Das Poll-Geheimnis (nicht der angezeigte Code) verlässt
den Server nie — nur sein SHA-256 liegt in `mcp_device_grants.secret_hash`.
Einlöse-Versuche sind pro Nutzer rate-limitiert
(`mcp_device_claim_attempts`).

Edge Functions ruft der Server mit `ctx.accessToken` auf, nicht mit dem
Service-Key: `mail-create-draft` löst das Postfach dann selbst über
`auth.uid()` auf.

The CRM frontend renders an "Agent" badge with an Approve button
(`src/components/shared/AgentBadge.tsx` in `../janreimanncrm`) for any row where
`created_by_agent = true` and `agent_approved = false`. Once a human clicks
Approve, `agent_approved` flips to `true` and the badge disappears
permanently — approval is a one-way switch, there's no "unapprove".

Update-tools (`update_contact`, `update_project`, etc.) do not touch these
columns — they only matter at creation time.
