# crm-mcp-server

MCP server exposing CRM tools (contacts, companies, projects, tasks, calendar
events, documents, folders, notes) to AI agents (Claude, claude.ai connector) backed
by the same Supabase project as the main CRM webapp (`../private-janreimanncrm`).

Calendar events are special: they live on an external CalDAV server, and the
`calendar_events` table is only a sync mirror. `create_calendar_event`
(`src/tools/calendar.ts`) therefore does a CalDAV PUT first and then upserts
the mirror row (with `agentMeta()`). Deleting only the mirror row never works
— the next `sync-calendar` run resurrects the event — which is why the
AgentBadge reject path for calendar events in the webapp goes through the
`write-calendar` edge function instead of a plain DB delete.

## Deployment

The default branch is **`master`** — Vercel deploys jancrmmcp.vercel.app from
there (the CRM repo uses `main`). Push with `git push origin master`, never
`HEAD:main`: that once created a stray `main` branch instead of deploying.
Check `git status -sb` first.

This server and the CRM webapp (`../private-janreimanncrm`) are two **separate Vercel
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

`/mcp` and `/mcp/agent` accept **only POST** — GET and DELETE get 405 (after bearer auth, so
an expired token still yields 401 and triggers re-auth). The server is
stateless and never pushes to the client, but the SDK transport would hold a
GET SSE stream open with 15 s keepalives until Vercel's 300 s timeout; clients
(Claude Code) then reconnect immediately. Every open client session thus kept
a 2 GB instance alive around the clock and burned through the Hobby quota
(362 GB-h Fluid Provisioned Memory against 3 h of actual CPU in Sep 2026).
Don't route GET back to the transport.

## Tool profiles (two endpoints)

One server, one OAuth/device-grant token, two tool lists (`src/tools/index.ts`
→ `ToolProfile`, routed by path in `src/index.ts`):

- **`POST /mcp` — Jan's profile** (claude.ai, Claude Code): every tool except
  `AGENT_ONLY_TOOLS`.
- **`POST /mcp/agent` — desktop-agent profile**: Jan's tools plus
  `AGENT_ONLY_TOOLS`. The CRM desktop app points its agents here
  (`CRM_MCP_URL` in `../private-janreimanncrm/src-tauri/src/claude_cli.rs`).

`AGENT_ONLY_TOOLS` = every tool that takes the agent's own `agent_id` from
its desktop system prompt (self-management, `remember`, `read_chat_history`,
routines, the Chief's tools) plus the tools Jan's profile dropped but the
desktop app can still grant (`get_pipeline_stats`,
`suggest_next_step`, `create_initiative`, `update_initiative`). Rules:

- A tool outside a profile is **not registered** (no hidden/disabled tools —
  each listed tool costs tokens in every conversation).
- A new tool that needs an `agent_id` goes into `AGENT_ONLY_TOOLS`. A tool the
  desktop agents may use must also be offered in the CRM's
  `src/modules/agents/tools.ts` (that list decides `--allowedTools`), and the
  agent profile must keep every tool listed there
  (`test/test-profiles-and-extensions.ts` checks both lists).
- Tokens are not bound to a path: the protected-resource metadata names the
  server root as the resource, which covers `/mcp` and `/mcp/agent`.
- A desktop build from before the split still calls `/mcp`; its agents simply
  don't see the agent-only tools until the app is rebuilt. The rebuilt app
  re-registers `jan-crm` with the new URL, which needs one
  `claude mcp login jan-crm` (Claude Code stores tokens per server config).
- Descriptions say what a tool does, not the memory protocol: that lives once
  in `src/instructions.ts`. The test keeps Jan's profile under a description
  budget (54 tools, < 9,000 description characters).

Interactions are intentionally **not** creatable via this server — logging a
call/meeting/email as an interaction is a user-only action in the CRM UI.
Do not add a `create_interaction` tool back without explicit sign-off.

## Briefing renderer

`src/briefing.ts` renders `get_project_briefing()` for `open_project` and is
byte-identical to `../private-janreimanncrm/src/modules/projects/briefingRender.ts`
(the CRM's Agent tab); both repos test it against the fixtures in
`../private-janreimanncrm/docs/superpowers/fixtures/` — change both and the
fixtures together. The "Share portal" section comes from the briefing's
`share_activity` (CRM migration `20261107006300`); the renderer treats the
key as optional, so this server and that migration deploy in either order.
Share activity is never a `project_timeline()` kind.

`get_project` stays in Jan's profile (Jan, 2026-10-20): `open_project`'s
briefing renders name, stage, health, initiative, dates, budget, people,
companies, tags, Memory, status and a capped description, but not
`target_volume`, `invested_volume`, `actual_close_date`, `project_type`,
`custom_fields` or the full description — the briefing points to `get_project`
for those.

## Query rules

- Wall-clock dates and times from tool arguments are Europe/Berlin
  (`src/berlinTime.ts`), like the web app — the server itself runs in UTC.
- Filters run in the query (PostgREST, also on `search_*_smart` results),
  never in JS after `.limit()`; a filtered fuzzy search asks the RPC for its
  whole ranked pool. User text in `.ilike()` goes through `escapeLike`, in
  `.or()` through a stripping helper (`orTerm`).
- A create tool whose link/tag insert fails rolls the new row back and
  returns the error — never "created successfully" with half the links.
- Search that PostgREST can't express runs in a SECURITY INVOKER RPC from the
  CRM migrations (`search_emails`, `document_text_snippets`,
  `crm_changes_since`, migration `20261107006400`), never as a JS filter. The
  tool still passes the caller's own account ids (`user_id = ctx.userId`).
- Read tools return compact rows (previews, snippets, ids), never mail bodies
  or document text in lists; the full text comes from the `get_*` tools.

## Edge functions from tools

`callEdgeFunction` (`src/tools/edge.ts`) calls CRM edge functions with
`ctx.accessToken`; they resolve the user via `getUser()` and accept the
registered MCP session in `ownerSessionOk()`.

- `mail-create-draft`: drafts only, never send. A reply passes only
  `reply_to` (a message id) plus flags; the edge function loads the original
  with the caller's token and builds In-Reply-To/References, the "Re:"
  subject and the recipients itself — no header comes from the tool.
- `share-admin` (`share_status`): **read actions only** (`SHARE_READ_ACTIONS`:
  `recipient.get`, `catalog.list`, `item.get`). Results are whitelisted field
  by field: never a one-time password, a signed/preview URL or an item link.

## Agent-provenance rule (always apply, no exceptions)

Every row this server inserts into a user-facing CRM table must be
distinguishable from a human-created row in the CRM UI, and requires human
approval before it's treated as fully trusted data.

This is implemented with two columns, present on every entity table
(`contacts`, `companies`, `projects`, `tasks`, `interactions`, `documents`,
`document_folders`, `calendar_events`, `notes`):

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
`../private-janreimanncrm/supabase/migrations/`, die anschliessend über den
Management-Query-Endpunkt eingespielt werden — nicht über den
Dashboard-SQL-Editor, sonst fehlt die Änderung im Repo. Danach die generierten
Typen neu erzeugen (`supabase gen types typescript --project-id <ref>`) und
`../private-janreimanncrm/supabase/schema_export.sql` über
`supabase/gen_schema_export.py` neu ziehen.

## Einzelnutzer-Betrieb

Das CRM ist eine **Einzelnutzer-Anwendung**: ein Owner, eine Organisation.
Rollen, Einladungen, Join-Codes und Onboarding gibt es nicht mehr
(`user_roles`, `user_directory`, `organization_invitations`,
`organization_join_codes` sind entfernt), die Datenbank lässt jeden Zugriff
nur für die User-ID des Owners durch. Dieser Server bedient damit genau diesen
einen Nutzer. Wer fragt, steht trotzdem ausschließlich im Bearer-Token; eine
`ORGANIZATION_ID` oder User-ID aus der Umgebung gibt es nicht.

Die Kette:

```
Device-Code-Login (src/oauth.ts)
  → Supabase-Sitzung, verschlüsselt im MCP-Token
  → buildContext() (src/context.ts) → Ctx { userId, orgId, db, admin }
  → jedes Tool bekommt ctx als erstes Argument
```

Ein Konto ohne Zeile in `users` (also jedes außer dem Owner) bricht schon in
`buildContext()` mit "no access to the CRM" ab. Die Organisation bleibt als
Datenmodell bestehen — `ctx.orgId` speist `p_org_id` der `search_*_smart`-RPCs,
Routinen, Chief, Self-Management und das erste Segment der Storage-Pfade von
Dokumenten.

`ctx.db` trägt das Access-Token des Nutzers, **RLS greift also genau wie im
Browser** — die Zugriffskontrolle liegt in der Datenbank, nicht im Tool-Code.
Daraus folgen drei Regeln:

- Kein `.eq("organization_id", …)` in Queries und kein `organization_id` im
  Insert: Spalten-Default und `BEFORE INSERT`-Trigger setzen ihn aus
  `auth.uid()`. Ein von Hand gesetzter Wert würde die Zuordnung wieder an den
  Aufrufer hängen.
- Schreibende Tools prüfen `select("id")` auf ein leeres Ergebnis. Eine
  unbekannte UUID trifft durch die Policy auf null Zeilen — ohne die Prüfung
  meldet das Tool trotzdem Erfolg.
- Nutzergebundene Tabellen (`calendar_events`, `caldav_accounts`,
  `ms_email_accounts`) filtern weiterhin explizit auf `ctx.userId`. Einen
  Kollegen gibt es nicht mehr, aber die Abfrage soll nicht davon abhängen, dass
  die Datenbank nur einen Nutzer kennt.

`ctx.admin` (service_role, umgeht RLS und damit auch die Bindung an den Owner)
hat genau **eine** berechtigte Verwendung in Tools: `get_caldav_accounts(p_user_id)`
liefert das entschlüsselte CalDAV-Passwort und ist für `authenticated`
gesperrt. Der Parameter ist dort fest `ctx.userId` und darf nie aus den
Tool-Argumenten stammen. Wer `ctx.admin` an einer weiteren Stelle braucht,
begründet das hier — sonst ist `ctx.db` richtig.

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
  `../private-janreimanncrm/supabase/migrations_archive/20261104000400_mcp_device_grants.sql`)
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

**Zweiter Faktor (MFA).** Seit `20261107005700_owner_mfa.sql` sieht eine
aal1-Sitzung im CRM nichts mehr, sobald der Owner einen TOTP-Faktor hat — und
die Sitzung, die `handleDevicePoll` per `generateLink` + `verifyOtp` erzeugt,
ist für immer aal1. Deshalb registriert `handleDevicePoll` sie direkt danach
über `admin.rpc("register_mcp_session", …)` (session_id aus dem Access-Token,
Client-Name aus der signierten `client_id`; gemeinsamer Helfer
`mintRegisteredSession` in `src/mcpSession.ts`). Die Datenbank lässt registrierte
MCP-Sitzungen durch; den zweiten Faktor hat der Owner schon beim Freigeben in
der Web-App eingegeben (`claim_mcp_device_grant` verlangt aal2). **Fail
closed:** scheitert die Registrierung, wird die frische Sitzung abgemeldet und
kein Code ausgestellt. Das ist die zweite begründete `service_role`-Verwendung
(dritte: API-Keys, siehe unten). Ein Refresh behält die session_id, die Registrierung gilt also
so lange wie die Sitzung; der Owner widerruft sie in Settings → Security →
Connected apps (`revoke_mcp_session` löscht die Auth-Sitzung, der nächste
Refresh scheitert, der Client muss neu verbinden). Verbindungen von vor dem
Deploy sind nicht registriert und müssen nach der Einrichtung des Faktors neu
verbunden werden. `seal`/`open` (AES-256-GCM mit `MCP_API_KEY`) liegen in
`src/seal.ts`.

### API-Keys (`jcrm_…`)

Für Clients, die OAuth-Tokens nicht erneuern (Claude Code, die
Desktop-Agenten), gibt es feste Keys: `jcrm_` + 43 Zeichen base64url,
angelegt und widerrufen in der CRM-Web-App (Settings → Security, Migration
`20261107007700_mcp_api_keys.sql`). `verifyAccessToken` schickt alles mit
diesem Präfix nach `src/apiKeys.ts`; der Key gilt auf `/mcp` und
`/mcp/agent`, `clientId` ist `api-key:<id>`, `extra` wie beim OAuth-Pfad.

- **Nur der Hash.** Die Datenbank kennt `sha256(key)` (hex); dahinter hält
  der Server eine eigene Supabase-Sitzung, versiegelt in
  `private.mcp_api_keys.sealed_session` (an die Key-Zeile gebunden). Key,
  Hash und Tokens stehen nie in Logs oder Fehlermeldungen.
- **Lease.** Hat das Access-Token < 120 s Rest, erneuert genau eine Instanz
  (`mcp_api_key_take_lease`, 20 s): nach dem Lease neu lesen (vielleicht war
  eine andere schneller), dann `refreshSession`, und scheitert der (Token
  wegrotiert, Sitzung widerrufen, `MCP_API_KEY` gewechselt), eine neue
  Sitzung per `mintRegisteredSession` mit Client-Name `API key: <label>` —
  **selbstheilend**, fail closed wie beim Device-Code (Registrierung
  gescheitert → Sitzung abgemeldet, nichts gespeichert).
  `mcp_api_key_store_session` legt sie ab und löscht eine ersetzte alte
  Auth-Sitzung. Verlierer fragen alle 500 ms nach, höchstens 10 s.
- **Cache.** Pro Instanz bis Ablauf − 120 s, höchstens 1 Minute — ein
  Widerruf greift im Server also spätestens nach einer Minute (die Datenbank
  sperrt die gelöschte Sitzung bei MFA sofort). Ein Token, dessen
  `session_id` nicht (mehr) die der Zeile ist (Sitzung per globalem Abmelden
  gelöscht → `session_id` NULL), gilt als unbrauchbar und wird sofort
  erneuert. Unbekannte Keys stehen 30 s in einem Negativ-Cache (kein
  DB-Aufruf pro Müll-Token).
- **Zeitgrenzen.** Refresh 6 s, neue Sitzung 9 s — zusammen unter dem
  20-s-Lease, damit keine zweite Instanz parallel erneuert.
- **401 nur für unbekannte/widerrufene Keys.** Störungen (Datenbank, Lease-
  Timeout, Mint gescheitert) sind `ApiKeyUnavailableError` (`ServerError` →
  500): ein 401 ließe Clients ihre Zugangsdaten verwerfen oder einen
  OAuth-Login starten.
- Tests: `test/test-api-keys.ts` mit gefälschtem service_role-Client und
  injizierter Uhr.

Edge Functions ruft der Server mit `ctx.accessToken` auf, nicht mit dem
Service-Key: `mail-create-draft` löst das Postfach dann selbst über
`auth.uid()` auf.

The CRM frontend renders an "Agent" badge with an Approve button
(`src/components/shared/AgentBadge.tsx` in `../private-janreimanncrm`) for any row where
`created_by_agent = true` and `agent_approved = false`. Once a human clicks
Approve, `agent_approved` flips to `true` and the badge disappears
permanently — approval is a one-way switch, there's no "unapprove".

Update-tools (`update_contact`, `update_project`, etc.) do not touch these
columns — they only matter at creation time.

## Working with Jan

- Talk to Jan in German.
- Carry a planned build through to the end on your own, with subagents in
  parallel for independent tasks (one worktree each). Decide open design
  questions yourself and list the decisions at the end. Stop only for outward
  or irreversible steps: creating accounts, pushing, deploying, anything that
  needs Jan's credentials.
- Ask before any computer use (Claude in Chrome, desktop control) and wait for
  an explicit yes.
- No GitHub Actions, CI workflows or GitHub secrets. Checks run locally before
  a push.
- The CRM database (`lgmdjkjwiimyqkmyfnlt`) is changed via the Supabase
  Management API from `../private-janreimanncrm` (see its CLAUDE.md;
  `../janreimanncrm` is the archived public variant). The Supabase MCP
  connector is scoped to another organization and cannot reach it.
- Durable knowledge belongs in this repo: when Jan states a rule, decides
  something or corrects you, write it into this file in the same turn. Don't
  rely on Claude's auto memory — in a sandbox it is gone after the session.
