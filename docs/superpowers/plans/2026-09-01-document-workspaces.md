# Initiative-Workspaces & Dokumenten-Indexer-Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every initiative gets an auto-provisioned document workspace (root folder), every project inside it an auto-provisioned subfolder, and a new background agent ("Document Indexer") keeps a per-workspace, user-invisible content index current plus a per-project, user-visible document summary — reusing the CRM's existing event-driven agent-task infrastructure.

**Architecture:** DB triggers auto-create/link `document_folders` rows to `initiatives`/`projects`. The existing `agent_event_fanout()` trigger (currently INSERT-only) is generalized to also fire on relevant `documents` UPDATEs, so both webapp and MCP-server document changes queue a task for the new Document Indexer agent without any duplicated app-side logic. Two new MCP tools give that agent read/write access to a hidden per-workspace TOC document; it writes the human-visible summary through the existing `update_project` tool.

**Tech Stack:** Postgres/Supabase (SQL migrations via Management API), TypeScript MCP server (`@modelcontextprotocol/sdk`, zod, `@supabase/supabase-js`), React/TypeScript webapp (Vite, Tailwind, shadcn/ui).

**Spec:** `docs/superpowers/specs/2026-09-01-document-workspaces-design.md`

## Global Constraints

- DDL only via migration files in `../janreimanncrm/supabase/migrations/`, applied through the Management Query Endpoint (`https://api.supabase.com/v1/projects/{REF}/database/query`) — never the Supabase dashboard SQL editor (`CLAUDE.md`).
- After any schema change: regenerate `supabase gen types typescript --project-id <ref>` and re-run `supabase/gen_schema_export.py` (`CLAUDE.md`).
- Every insert into a user-facing CRM table (jancrmmcp tools) must spread `agentMeta()` (`created_by_agent: true, agent_approved: false`) — auto-created `document_folders` rows via DB trigger get `created_by_agent = true` set directly in SQL, same rule.
- `ctx.db` (user access token, RLS applies) is the default in MCP tools; never `ctx.admin` here (`CLAUDE.md` Mandantentrennung).
- No `.eq("organization_id", …)` in any new query/insert — the DB sets it from `auth.uid()`.
- Write-tools must check `select("id")` for an empty result and throw — a foreign UUID matches zero rows through RLS but would otherwise report success.

---

## Task 1: Migration — `document_folders` workspace/project columns + auto-provisioning

**Files:**
- Create: `../janreimanncrm/supabase/migrations/20260901000000_document_workspaces.sql`

**Interfaces:**
- Produces: `document_folders.initiative_id uuid`, `document_folders.project_id uuid` — consumed by Task 6 (MCP filter/tools), Task 8 (webapp FolderTree), Task 9 (indexer system prompt logic).

- [ ] **Step 1: Write the migration**

```sql
-- Workspaces: every initiative gets a root document folder; every project
-- inside an initiative gets a subfolder in that workspace. Auto-provisioned
-- via trigger so it applies identically whether the initiative/project was
-- created from the webapp or the MCP server — no app-side duplication.

ALTER TABLE public.document_folders
  ADD COLUMN initiative_id uuid REFERENCES public.initiatives(id) ON DELETE SET NULL,
  ADD COLUMN project_id    uuid REFERENCES public.projects(id)    ON DELETE SET NULL;

CREATE INDEX document_folders_initiative_idx ON public.document_folders (initiative_id);
CREATE INDEX document_folders_project_idx    ON public.document_folders (project_id);

CREATE OR REPLACE FUNCTION public.provision_initiative_workspace()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
BEGIN
  INSERT INTO public.document_folders (name, initiative_id, created_by, created_by_agent)
  VALUES (NEW.name, NEW.id, NEW.created_by, true);
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.provision_initiative_workspace() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_provision_initiative_workspace
  AFTER INSERT ON public.initiatives
  FOR EACH ROW EXECUTE FUNCTION public.provision_initiative_workspace();

CREATE OR REPLACE FUNCTION public.provision_project_folder()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_workspace_folder uuid;
BEGIN
  IF NEW.initiative_id IS NULL THEN
    RETURN NEW;
  END IF;
  -- Skip if a folder for this project already exists (e.g. UPDATE fires
  -- again without a real initiative change).
  IF EXISTS (SELECT 1 FROM public.document_folders WHERE project_id = NEW.id) THEN
    RETURN NEW;
  END IF;

  SELECT id INTO v_workspace_folder
    FROM public.document_folders WHERE initiative_id = NEW.initiative_id;
  IF v_workspace_folder IS NULL THEN
    RETURN NEW; -- defensive: should always exist via the trigger above
  END IF;

  INSERT INTO public.document_folders (name, parent_folder_id, project_id, created_by, created_by_agent)
  VALUES (NEW.name, v_workspace_folder, NEW.id, NEW.created_by, true);
  RETURN NEW;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.provision_project_folder() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER trg_provision_project_folder
  AFTER INSERT OR UPDATE OF initiative_id ON public.projects
  FOR EACH ROW EXECUTE FUNCTION public.provision_project_folder();

-- Backfill: existing initiatives/projects that predate this migration.
DO $$
DECLARE
  r record;
  v_workspace uuid;
BEGIN
  FOR r IN SELECT id, name, created_by FROM public.initiatives LOOP
    IF NOT EXISTS (SELECT 1 FROM public.document_folders WHERE initiative_id = r.id) THEN
      INSERT INTO public.document_folders (name, initiative_id, created_by, created_by_agent)
      VALUES (r.name, r.id, r.created_by, true);
    END IF;
  END LOOP;

  FOR r IN SELECT id, name, created_by, initiative_id FROM public.projects
            WHERE initiative_id IS NOT NULL AND deleted_at IS NULL LOOP
    IF NOT EXISTS (SELECT 1 FROM public.document_folders WHERE project_id = r.id) THEN
      SELECT id INTO v_workspace FROM public.document_folders WHERE initiative_id = r.initiative_id;
      IF v_workspace IS NOT NULL THEN
        INSERT INTO public.document_folders (name, parent_folder_id, project_id, created_by, created_by_agent)
        VALUES (r.name, v_workspace, r.id, r.created_by, true);
      END IF;
    END IF;
  END LOOP;
END $$;
```

- [ ] **Step 2: Self-check the migration is idempotent**

Re-reading the `IF NOT EXISTS` guards in `provision_project_folder()` and the backfill block: both skip rows that already have a folder, so running this migration twice (or the backfill after the trigger already provisioned everything) creates no duplicates. No test framework runs SQL automatically in this repo (confirmed: `supabase/tests/*.sql` are hand-run verification scripts, not CI) — verification happens after apply in Task 5.

- [ ] **Step 3: Commit**

```bash
cd ../janreimanncrm
git add supabase/migrations/20260901000000_document_workspaces.sql
git commit -m "feat: Workspace-Ordner für Initiatives, Projektordner darin"
```

---

## Task 2: Migration — `projects.document_summary` + `agents.is_system`

**Files:**
- Create: `../janreimanncrm/supabase/migrations/20260901000100_document_summary_and_system_agents.sql`

**Interfaces:**
- Produces: `projects.document_summary text`, `projects.document_summary_updated_at timestamptz`, `agents.is_system boolean` — consumed by Task 3 (MCP `update_project`), Task 4 (seed migration), Task 10 (webapp summary card), Task 11 (webapp System Agents group).

- [ ] **Step 1: Write the migration**

```sql
ALTER TABLE public.projects
  ADD COLUMN document_summary text NOT NULL DEFAULT '',
  ADD COLUMN document_summary_updated_at timestamptz;

ALTER TABLE public.agents
  ADD COLUMN is_system boolean NOT NULL DEFAULT false;

-- Defense in depth: a system agent must never be soft-deletable, even if
-- some future UI path calls the same update the normal delete flow uses.
CREATE OR REPLACE FUNCTION public.prevent_system_agent_delete()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.is_system AND NEW.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'System-Agent % kann nicht gelöscht werden', OLD.name;
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER trg_prevent_system_agent_delete
  BEFORE UPDATE OF deleted_at ON public.agents
  FOR EACH ROW EXECUTE FUNCTION public.prevent_system_agent_delete();

-- The existing Project Curator becomes a system agent too — it was already
-- conceptually one, just never had the flag to render it as such.
UPDATE public.agents SET is_system = true WHERE name = 'Project Curator';
```

- [ ] **Step 2: Commit**

```bash
cd ../janreimanncrm
git add supabase/migrations/20260901000100_document_summary_and_system_agents.sql
git commit -m "feat: document_summary auf Projekten, is_system-Flag für Agenten"
```

---

## Task 3: Migration — generalize `agent_event_fanout()` to fire on UPDATE too

**Files:**
- Create: `../janreimanncrm/supabase/migrations/20260901000200_agent_event_fanout_update.sql`

**Interfaces:**
- Consumes: `public.agent_event_fanout()`, `public.agent_triggers.event_op`, `public.agent_tasks` (all from `20260829_agent_event_triggers.sql`).
- Produces: `agent_event_fanout()` now matches `tr.event_op = TG_OP` instead of the hardcoded `'INSERT'` literal, and a new `AFTER UPDATE OF file_url, file_size, file_name, folder_id ON public.documents` trigger — consumed by Task 4 (Document Indexer's `agent_triggers` row uses `event_op = 'INSERT'`, but the generalization means a future `event_op = 'UPDATE'` row on any table works without further migrations).

- [ ] **Step 1: Write the migration**

```sql
-- Bisher fest auf 'INSERT' verdrahtet, weil ausschliesslich AFTER-INSERT-
-- Trigger existierten. Für "Dokument geändert" (updateDocumentContent, oder
-- ein Umbenennen/Verschieben in der Webapp) braucht es auch UPDATE — die
-- Funktion liest den Operationstyp jetzt aus TG_OP statt ihn anzunehmen.
-- Rückwärtskompatibel: alle bisherigen agent_triggers-Zeilen haben
-- event_op = 'INSERT', und es hingen bislang nur INSERT-Trigger.
CREATE OR REPLACE FUNCTION public.agent_event_fanout()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  t record;
  v_open int;
BEGIN
  IF NEW.created_by_agent THEN
    RETURN NULL;
  END IF;

  FOR t IN
    SELECT tr.id, tr.agent_id, tr.goal_template
      FROM public.agent_triggers tr
      JOIN public.agents a ON a.id = tr.agent_id
      LEFT JOIN public.agent_org_settings s ON s.organization_id = a.organization_id
     WHERE tr.kind = 'event'
       AND tr.enabled
       AND tr.event_table = TG_TABLE_NAME
       AND tr.event_op = TG_OP
       AND a.organization_id = NEW.organization_id
       AND a.status = 'active'
       AND coalesce(s.agents_paused, false) = false
  LOOP
    SELECT count(*) INTO v_open
      FROM public.agent_tasks
     WHERE agent_id = t.agent_id
       AND source_table = TG_TABLE_NAME
       AND source_row_id = NEW.id
       AND status IN ('pending', 'running', 'waiting_approval');
    IF v_open > 0 THEN
      CONTINUE;
    END IF;

    INSERT INTO public.agent_tasks (
      agent_id, organization_id, origin, goal, source_table, source_row_id
    ) VALUES (
      t.agent_id, NEW.organization_id, 'event',
      coalesce(nullif(btrim(t.goal_template), ''), 'Sieh dir den geänderten Datensatz an.')
        || E'\n\nAusgelöst durch: ' || TG_TABLE_NAME || ' (' || TG_OP || ') mit der id ' || NEW.id || '.',
      TG_TABLE_NAME, NEW.id
    );
  END LOOP;

  RETURN NULL;

EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'agent_event_fanout auf % (%) fehlgeschlagen: %', TG_TABLE_NAME, TG_OP, SQLERRM;
  RETURN NULL;
END;
$function$;

-- Nur bei inhaltlich relevanten Spaltenänderungen feuern, nicht bei jedem
-- description-Edit — sonst löst jede Metadaten-Korrektur einen Agentenlauf aus.
CREATE TRIGGER documents_agent_event_fanout_update
  AFTER UPDATE OF file_url, file_size, file_name, folder_id ON public.documents
  FOR EACH ROW EXECUTE FUNCTION public.agent_event_fanout();
```

- [ ] **Step 2: Commit**

```bash
cd ../janreimanncrm
git add supabase/migrations/20260901000200_agent_event_fanout_update.sql
git commit -m "feat: agent_event_fanout auf UPDATE erweitern (dynamischer TG_OP)"
```

---

## Task 4: Migration — seed the Document Indexer agent

**Files:**
- Create: `../janreimanncrm/supabase/migrations/20260901000300_seed_document_indexer_agent.sql`

**Interfaces:**
- Consumes: `public.agents`, `public.agent_triggers`, `public.create_organization()`, `public.create_personal_workspace()` (all from prior migrations — same wiring pattern as `seed_project_curator_agent` in `20261104000200_seed_project_curator_agent.sql`).
- Produces: an `agents` row named `'Document Indexer'` with `is_system = true`, and an `agent_triggers` row with `kind = 'event'`, `event_table = 'documents'`, `event_op = 'INSERT'` — this is the row the fanout from Task 3 matches against for new documents. (Content-change coverage comes from the `AFTER UPDATE` trigger in Task 3 firing the same fanout with `TG_OP = 'UPDATE'`; a second `agent_triggers` row with `event_op = 'UPDATE'` is added here too so both are covered.)

- [ ] **Step 1: Write the migration**

```sql
-- Document Indexer: hält pro Initiative-Workspace ein für Menschen
-- unsichtbares Inhaltsverzeichnis aktuell (eine documents-Zeile mit
-- doc_type = 'agent_index') und, wo ein Dokument zu einem Projektordner
-- gehört, projects.document_summary — sichtbar im "Documents"-Tab des
-- Projekts. Läuft über dieselbe agent_triggers-Infrastruktur wie jeder
-- andere Agent (20261028001300, erweitert um Events in 20260829 und um
-- UPDATE in 20260901000200).

CREATE OR REPLACE FUNCTION public.seed_document_indexer_agent(p_org uuid, p_user uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_agent uuid;
BEGIN
  IF EXISTS (SELECT 1 FROM public.agents
              WHERE organization_id = p_org AND name = 'Document Indexer') THEN
    RETURN;
  END IF;

  INSERT INTO public.agents (
    organization_id, created_by, name, description, system_prompt, tools, is_system
  )
  VALUES (
    p_org, p_user, 'Document Indexer',
    'Runs on document changes and keeps each initiative workspace''s content index current, plus a short document summary per project.',
    'You are the Document Indexer, a background agent with one job: keep documents navigable without anyone having to scan every file by hand. You are triggered by a document being created or changed; the goal text tells you the document''s id via "documents (INSERT|UPDATE) mit der id <uuid>". Call get_document_content on that id, then list_folders to find its folder and walk parent_folder_id up to the root. If neither that folder nor any ancestor has initiative_id or project_id set, this document is not inside a workspace — do nothing and stop. Otherwise: find the workspace root (the ancestor folder with initiative_id set), call get_workspace_index with that initiative_id to read the current index (empty string if none exists yet), add or update the one-line entry for this document (file name, a single concise sentence describing its content, the document id, today''s date) grouped under its project''s heading (or an "Unsorted" heading if the folder itself is the workspace root), then call upsert_workspace_index to save it back. If the document''s folder has project_id set, also call update_project on that project with a fresh 1-2 sentence document_summary describing the current state of that project''s documents as a whole — not just the one that changed. Never touch brief, description or ai_summary on a project — those belong to the human or to the Project Curator. Be factual and terse.',
    ARRAY[
      'mcp__jan-crm__get_document_content', 'mcp__jan-crm__list_folders',
      'mcp__jan-crm__get_workspace_index', 'mcp__jan-crm__upsert_workspace_index',
      'mcp__jan-crm__update_project'
    ],
    true
  )
  RETURNING id INTO v_agent;

  INSERT INTO public.agent_triggers (
    agent_id, created_by, kind, event_table, event_op, prompt_template, enabled, max_runs_per_day
  ) VALUES
    (v_agent, p_user, 'event', 'documents', 'INSERT',
     'A document was created. Update the workspace index and, if applicable, the project''s document_summary, per your system prompt.',
     true, 100),
    (v_agent, p_user, 'event', 'documents', 'UPDATE',
     'A document''s file content or placement changed. Update the workspace index and, if applicable, the project''s document_summary, per your system prompt.',
     true, 100);
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.seed_document_indexer_agent(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.create_organization(p_name text)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid    uuid := auth.uid();
  v_name   text := trim(coalesce(p_name, ''));
  v_slug   text;
  v_base   text;
  v_org    uuid;
  v_suffix int := 1;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet' USING ERRCODE = 'JC006';
  END IF;
  IF NOT public.current_user_email_confirmed() THEN
    RAISE EXCEPTION 'E-Mail-Adresse ist noch nicht bestätigt' USING ERRCODE = 'JC001';
  END IF;
  IF (SELECT organization_id FROM public.users WHERE id = v_uid) IS NOT NULL THEN
    RAISE EXCEPTION 'Dieses Konto gehört bereits zu einer Organisation'
      USING ERRCODE = 'JC002';
  END IF;
  IF char_length(v_name) < 2 OR char_length(v_name) > 80 THEN
    RAISE EXCEPTION 'Der Name muss zwischen 2 und 80 Zeichen lang sein'
      USING ERRCODE = 'JC008';
  END IF;
  IF EXISTS (SELECT 1 FROM public.organizations WHERE lower(name) = lower(v_name)) THEN
    RAISE EXCEPTION 'Diesen Namen gibt es bereits' USING ERRCODE = 'JC008';
  END IF;

  v_base := trim(both '-' from regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g'));
  IF v_base = '' THEN v_base := 'org'; END IF;
  v_slug := v_base;
  WHILE EXISTS (SELECT 1 FROM public.organizations WHERE slug = v_slug) LOOP
    v_suffix := v_suffix + 1;
    v_slug := v_base || '-' || v_suffix;
  END LOOP;

  INSERT INTO public.organizations (name, slug) VALUES (v_name, v_slug)
  RETURNING id INTO v_org;

  PERFORM set_config('app.membership_change', 'on', true);
  UPDATE public.users SET organization_id = v_org WHERE id = v_uid;

  DELETE FROM public.user_roles WHERE user_id = v_uid;
  INSERT INTO public.user_roles (user_id, role, organization_id)
  VALUES (v_uid, 'admin', v_org);

  PERFORM public.seed_default_pipeline(v_org, v_uid);
  PERFORM public.seed_default_agent(v_org, v_uid);
  PERFORM public.seed_project_curator_agent(v_org, v_uid);
  PERFORM public.seed_document_indexer_agent(v_org, v_uid);

  RETURN v_org;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_personal_workspace()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_uid  uuid := auth.uid();
  v_user public.users%ROWTYPE;
  v_base text;
  v_name text;
  v_org  uuid;
BEGIN
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'Nicht angemeldet' USING ERRCODE = 'JC006';
  END IF;
  IF NOT public.current_user_email_confirmed() THEN
    RAISE EXCEPTION 'E-Mail-Adresse ist noch nicht bestaetigt' USING ERRCODE = 'JC001';
  END IF;

  SELECT * INTO v_user FROM public.users WHERE id = v_uid;
  IF v_user.organization_id IS NOT NULL THEN
    RAISE EXCEPTION 'Dieses Konto gehoert bereits zu einer Organisation'
      USING ERRCODE = 'JC002';
  END IF;

  v_base := coalesce(nullif(trim(v_user.full_name), ''), split_part(coalesce(v_user.email, ''), '@', 1));
  v_name := public.unique_organization_name(nullif(v_base, '') || '''s workspace');

  INSERT INTO public.organizations (name, slug, is_personal)
  VALUES (v_name, public.unique_organization_slug(v_name), true)
  RETURNING id INTO v_org;

  PERFORM set_config('app.membership_change', 'on', true);
  UPDATE public.users SET organization_id = v_org WHERE id = v_uid;

  DELETE FROM public.user_roles WHERE user_id = v_uid;
  INSERT INTO public.user_roles (user_id, role, organization_id)
  VALUES (v_uid, 'admin', v_org);

  PERFORM public.seed_default_pipeline(v_org, v_uid);
  PERFORM public.seed_default_agent(v_org, v_uid);
  PERFORM public.seed_project_curator_agent(v_org, v_uid);
  PERFORM public.seed_document_indexer_agent(v_org, v_uid);

  RETURN v_org;
END;
$function$;

-- Backfill für Organisationen, die es schon gibt.
DO $$ DECLARE r record; BEGIN
  FOR r IN SELECT o.id,
                  (SELECT u.id FROM public.users u
                    WHERE u.organization_id = o.id ORDER BY u.created_at LIMIT 1) AS uid
             FROM public.organizations o LOOP
    PERFORM public.seed_document_indexer_agent(r.id, r.uid);
  END LOOP;
END $$;
```

- [ ] **Step 2: Commit**

```bash
cd ../janreimanncrm
git add supabase/migrations/20260901000300_seed_document_indexer_agent.sql
git commit -m "feat: Document-Indexer-Systemagent seeden (Workspace-TOC + document_summary)"
```

---

## Task 5: Apply all four migrations to production, regenerate types + schema export

**Files:**
- Modify: `../janreimanncrm/src/integrations/supabase/types.ts` (regenerated, not hand-edited)
- Modify: `../janreimanncrm/supabase/schema_export.sql` (regenerated, not hand-edited)

**Interfaces:**
- Consumes: Tasks 1–4's migration files.
- Produces: live production schema matching Task 1–4; regenerated types consumed by every webapp task below (7, 8, 10, 11).

- [ ] **Step 1: Apply the four migrations in order via the Management Query Endpoint**

```bash
cd ../janreimanncrm
set -a; source .env; set +a
for f in supabase/migrations/20260901000000_document_workspaces.sql \
         supabase/migrations/20260901000100_document_summary_and_system_agents.sql \
         supabase/migrations/20260901000200_agent_event_fanout_update.sql \
         supabase/migrations/20260901000300_seed_document_indexer_agent.sql; do
  echo "applying $f"
  python3 - "$f" <<'PY'
import json, os, sys, urllib.request
path = sys.argv[1]
sql = open(path).read()
req = urllib.request.Request(
    f"https://api.supabase.com/v1/projects/{os.environ['SUPABASE_PROJECT_REF']}/database/query",
    data=json.dumps({"query": sql}).encode(),
    headers={
        "Authorization": f"Bearer {os.environ['SUPABASE_ACCESS_TOKEN']}",
        "Content-Type": "application/json",
        "User-Agent": "jancrm-schema-export/1.0",
    },
    method="POST",
)
with urllib.request.urlopen(req) as r:
    body = json.load(r)
if isinstance(body, dict) and "message" in body:
    sys.exit(f"Query failed: {body['message']}")
print("ok")
PY
done
```

Expected: `ok` printed four times, no exceptions. If any migration fails partway (e.g. Task 4's `create_organization`/`create_personal_workspace` `CREATE OR REPLACE` fails because a referenced function signature changed), stop and fix the SQL file before re-running — do not paper over with `IF NOT EXISTS` skips that would hide a real DDL error.

- [ ] **Step 2: Verify with a manual check query, following the `supabase/tests/*.sql` convention**

Run via the same Management Query Endpoint:

```sql
SELECT
  (SELECT count(*) FROM public.document_folders WHERE initiative_id IS NOT NULL) AS workspace_folders,
  (SELECT count(*) FROM public.initiatives) AS initiatives,
  (SELECT count(*) FROM public.agents WHERE name = 'Document Indexer') AS indexer_agents,
  (SELECT count(*) FROM public.agent_triggers tr JOIN public.agents a ON a.id = tr.agent_id
     WHERE a.name = 'Document Indexer') AS indexer_triggers;
```

Expected: `workspace_folders` equals `initiatives` (one workspace folder per initiative, backfill worked); `indexer_agents` = number of organizations with at least one user; `indexer_triggers` = 2 × `indexer_agents`.

- [ ] **Step 3: Regenerate types and schema export**

```bash
cd ../janreimanncrm
supabase gen types typescript --project-id "$SUPABASE_PROJECT_REF" > src/integrations/supabase/types.ts
python3 supabase/gen_schema_export.py > supabase/schema_export.sql
```

- [ ] **Step 4: Commit**

```bash
cd ../janreimanncrm
git add src/integrations/supabase/types.ts supabase/schema_export.sql
git commit -m "chore: Typen und Schema-Export nach Workspace/Indexer-Migrationen neu ziehen"
```

---

## Task 6: MCP server — hide `agent_index` documents from `list_documents`

**Files:**
- Modify: `src/tools/documents.ts:62-84` (`listDocuments`)

**Interfaces:**
- Consumes: `documents.doc_type` (already exists per `CLAUDE.md` schema, confirmed in `schema_export.sql`).
- Produces: no change to `listDocuments`'s exported signature — filtering is internal.

- [ ] **Step 1: Add the filter**

`doc_type` is nullable, and Postgres evaluates `NULL != 'agent_index'` as `NULL` (not `true`) — a plain `.neq()` would silently drop every document that has no `doc_type` set at all. Use `.or()` instead, which is unambiguous, in `src/tools/documents.ts`, `listDocuments`:

```ts
export async function listDocuments(ctx: Ctx, args: z.infer<typeof listDocumentsSchema>) {
  let q = ctx.db
    .from("documents")
    .select("id, file_name, file_size, description, folder_id, uploaded_at, contact_id, company_id, project_id")
    .is("deleted_at", null)
    .or("doc_type.is.null,doc_type.neq.agent_index")
    .order("uploaded_at", { ascending: false })
    .limit(args.limit);
```

- [ ] **Step 2: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add src/tools/documents.ts
git commit -m "fix: list_documents blendet agent_index-TOC-Dokumente aus"
```

---

## Task 7: MCP server — `get_workspace_index` / `upsert_workspace_index` tools

**Files:**
- Modify: `src/tools/documents.ts` (add two exported functions + schemas)
- Modify: `src/tools/index.ts` (register the two tools)

**Interfaces:**
- Consumes: `ctx.db` (`Ctx` from `../context.js`), `agentMeta()` from `../supabase.js`, `document_folders.initiative_id` (Task 1), `documents.doc_type`.
- Produces: `getWorkspaceIndexSchema`/`getWorkspaceIndex`, `upsertWorkspaceIndexSchema`/`upsertWorkspaceIndex`, both exported from `src/tools/documents.ts` — consumed by Task 8's registration and by the seeded agent's `tools` array (already written into Task 4's migration as `mcp__jan-crm__get_workspace_index` / `mcp__jan-crm__upsert_workspace_index`).

- [ ] **Step 1: Add the two functions to `src/tools/documents.ts`**

Append after `deleteDocument` (end of file):

```ts
// ─── Workspace index (agent-only TOC) ────────────────────────────────────────

export const getWorkspaceIndexSchema = z.object({
  initiative_id: z.string().uuid().describe("Initiative UUID whose workspace index to read"),
});

export async function getWorkspaceIndex(ctx: Ctx, args: z.infer<typeof getWorkspaceIndexSchema>) {
  const { data: folder, error: folderErr } = await ctx.db
    .from("document_folders")
    .select("id")
    .eq("initiative_id", args.initiative_id)
    .maybeSingle();
  if (folderErr) throw new Error(folderErr.message);
  if (!folder) return { content: "", exists: false };

  const { data: doc, error } = await ctx.db
    .from("documents")
    .select("id, file_url")
    .eq("folder_id", folder.id)
    .eq("doc_type", "agent_index")
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!doc) return { content: "", exists: false };

  const { data: urlData, error: urlErr } = await ctx.db.storage
    .from("documents")
    .createSignedUrl(doc.file_url, 3600);
  if (urlErr) throw new Error(urlErr.message);
  const res = await fetch(urlData.signedUrl);
  if (!res.ok) throw new Error(`Failed to download workspace index: ${res.statusText}`);
  return { content: await res.text(), exists: true };
}

export const upsertWorkspaceIndexSchema = z.object({
  initiative_id: z.string().uuid().describe("Initiative UUID whose workspace index to write"),
  content: z.string().describe("Full replacement content of the workspace index (markdown)"),
});

export async function upsertWorkspaceIndex(ctx: Ctx, args: z.infer<typeof upsertWorkspaceIndexSchema>) {
  const { data: folder, error: folderErr } = await ctx.db
    .from("document_folders")
    .select("id")
    .eq("initiative_id", args.initiative_id)
    .maybeSingle();
  if (folderErr) throw new Error(folderErr.message);
  if (!folder) throw new Error(`No workspace folder for initiative ${args.initiative_id}`);

  const { data: existing, error: findErr } = await ctx.db
    .from("documents")
    .select("id, file_url")
    .eq("folder_id", folder.id)
    .eq("doc_type", "agent_index")
    .is("deleted_at", null)
    .maybeSingle();
  if (findErr) throw new Error(findErr.message);

  const buffer = Buffer.from(args.content, "utf-8");

  if (existing) {
    const { error: upErr } = await ctx.db.storage
      .from("documents")
      .update(existing.file_url, buffer, { upsert: true });
    if (upErr) throw new Error(upErr.message);

    const { data, error } = await ctx.db
      .from("documents")
      .update({ file_size: buffer.byteLength })
      .eq("id", existing.id)
      .select("id");
    if (error) throw new Error(error.message);
    if (!data?.length) throw new Error(`Workspace index document ${existing.id} not found`);
    return { id: existing.id, message: "Workspace index updated" };
  }

  const storagePath = `${ctx.orgId}/agent_index/${folder.id}/${randomUUID()}_index.md`;
  const { error: upErr } = await ctx.db.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType: "text/markdown", upsert: false });
  if (upErr) throw new Error(upErr.message);

  const { data, error } = await ctx.db
    .from("documents")
    .insert({
      file_name: "_index.md",
      file_url: storagePath,
      file_size: buffer.byteLength,
      folder_id: folder.id,
      doc_type: "agent_index",
      uploaded_by: ctx.userId,
      ...agentMeta(),
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: "Workspace index created" };
}
```

- [ ] **Step 2: Register both tools in `src/tools/index.ts`**

Add to the documents import block (around line 41-52):

```ts
import {
  listFoldersSchema, listFolders,
  createFolderSchema, createFolder,
  renameFolderSchema, renameFolder,
  listDocumentsSchema, listDocuments,
  getDocumentContentSchema, getDocumentContent,
  createTextDocumentSchema, createTextDocument,
  uploadBinaryDocumentSchema, uploadBinaryDocument,
  updateDocumentContentSchema, updateDocumentContent,
  updateDocumentSchema, updateDocument,
  deleteDocumentSchema, deleteDocument,
  getWorkspaceIndexSchema, getWorkspaceIndex,
  upsertWorkspaceIndexSchema, upsertWorkspaceIndex,
} from "./documents.js";
```

Add after the `delete_document` tool registration (end of the function, before the closing `}` at line 318):

```ts
  server.tool(
    "get_workspace_index",
    "Read the agent-maintained content index for an initiative's document workspace — a markdown table of contents listing every document across the workspace with a one-line summary each, grouped by project. Returns { content: '', exists: false } if none has been written yet. For internal use by the Document Indexer agent.",
    getWorkspaceIndexSchema.shape,
    async (args) => ok(await getWorkspaceIndex(ctx, args as Parameters<typeof getWorkspaceIndex>[1]))
  );

  server.tool(
    "upsert_workspace_index",
    "Create or fully overwrite the agent-maintained content index for an initiative's document workspace. Pass the complete new content — this replaces the whole index, it does not append. For internal use by the Document Indexer agent.",
    upsertWorkspaceIndexSchema.shape,
    async (args) => ok(await upsertWorkspaceIndex(ctx, args as Parameters<typeof upsertWorkspaceIndex>[1]))
  );
```

- [ ] **Step 3: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/tools/documents.ts src/tools/index.ts
git commit -m "feat: get_workspace_index / upsert_workspace_index Tools für den Document Indexer"
```

---

## Task 8: MCP server — `update_project` accepts `document_summary`

**Files:**
- Modify: `src/tools/projects.ts:187-221` (`updateProjectSchema`, `updateProject`)
- Modify: `src/tools/index.ts:142-147` (`update_project` tool description)

**Interfaces:**
- Consumes: `projects.document_summary`, `projects.document_summary_updated_at` (Task 2).
- Produces: `updateProjectSchema` now accepts optional `document_summary`; `updateProject` stamps `document_summary_updated_at` when it's set — same pattern as the existing `ai_summary` handling two lines above it.

- [ ] **Step 1: Extend the schema**

In `src/tools/projects.ts`, add to `updateProjectSchema` right after the `ai_summary` field:

```ts
  ai_summary: z.string().optional().describe(
    "Short 2-4 sentence agent-maintained status summary shown at the top of the project. Reserved for the Project Curator agent's periodic refresh — other agents should prefer `brief` for anything they learn. Setting this stamps `ai_summary_updated_at` automatically."
  ),
  document_summary: z.string().optional().describe(
    "Short 1-2 sentence agent-maintained summary of this project's documents (what's there, what's missing). Reserved for the Document Indexer agent. Setting this stamps `document_summary_updated_at` automatically."
  ),
```

- [ ] **Step 2: Stamp the timestamp**

In `updateProject`, right after the existing `ai_summary_updated_at` line:

```ts
  if (updates.ai_summary !== undefined) updates.ai_summary_updated_at = new Date().toISOString();
  if (updates.document_summary !== undefined) updates.document_summary_updated_at = new Date().toISOString();
```

- [ ] **Step 3: Update the tool description in `src/tools/index.ts`**

Replace the `update_project` registration's description string:

```ts
  server.tool(
    "update_project",
    "Update a project — stage, description, volumes, dates, and `brief`, its living orientation note. Keep the brief current with anything durable you learn while working on the project; every change is logged to the project's journal automatically. `ai_summary` is reserved for the Project Curator agent's periodic status refresh; `document_summary` is reserved for the Document Indexer agent — other agents should write learnings to `brief` instead.",
    updateProjectSchema.shape,
    async (args) => ok(await updateProject(ctx, args as Parameters<typeof updateProject>[1]))
  );
```

- [ ] **Step 4: Build**

```bash
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
git add src/tools/projects.ts src/tools/index.ts
git commit -m "feat: update_project akzeptiert document_summary für den Document Indexer"
```

---

## Task 9: Webapp — hide `agent_index` documents from the Documents page and project tab

**Files:**
- Modify: `../janreimanncrm/src/modules/documents/api.ts` (`fetchDocuments`, `fetchDocumentsForProject`, `DocRow` type)

**Interfaces:**
- Consumes: `documents.doc_type` (regenerated types from Task 5).
- Produces: no exported signature changes — filtering is internal to both fetch functions.

- [ ] **Step 1: Add `doc_type` to `DocRow` and filter it in `fetchDocuments`**

In `DocRow` (around line 82-98), add:

```ts
  doc_type?: string | null;
```

In `fetchDocuments`, add `.or("doc_type.is.null,doc_type.neq.agent_index")` right after `.is("deleted_at", null)`:

```ts
export async function fetchDocuments(): Promise<DocRow[]> {
  const { data, error } = await supabase
    .from("documents")
    .select(`
      *,
      uploader:uploaded_by(full_name, email),
      contact:contact_id(id, first_name, last_name),
      company:company_id(id, name),
      project:project_id(id, name),
      interaction:interaction_id(id, title),
      task:task_id(id, title)
    `)
    .is("deleted_at", null)
    .or("doc_type.is.null,doc_type.neq.agent_index")
    .order("uploaded_at", { ascending: false });
  if (error) throw error;
```

- [ ] **Step 2: Apply the same filter to `fetchDocumentsForProject`**

Find `fetchDocumentsForProject` in the same file (used by `ProjectDocumentsTab.tsx`) and add the identical `.or("doc_type.is.null,doc_type.neq.agent_index")` filter after its `.is("deleted_at", null)` (or equivalent) clause.

- [ ] **Step 3: Manual verification**

```bash
cd ../janreimanncrm
npm run build
```

Expected: no TypeScript errors. (No document exists yet to manually check against in the browser — this becomes verifiable once Task 12 has run for real; note it in the task-12 checkpoint instead of here.)

- [ ] **Step 4: Commit**

```bash
cd ../janreimanncrm
git add src/modules/documents/api.ts
git commit -m "fix: agent_index-TOC-Dokumente in Documents-Ansicht und Projekt-Tab ausblenden"
```

---

## Task 10: Webapp — FolderTree: workspace/project icons, delete disabled for auto-folders

**Files:**
- Modify: `../janreimanncrm/src/modules/documents/api.ts` (`FolderRow` type)
- Modify: `../janreimanncrm/src/modules/documents/components/FolderTree.tsx`

**Interfaces:**
- Consumes: `document_folders.initiative_id`, `document_folders.project_id` (Task 1, regenerated types from Task 5).
- Produces: `FolderRow` gains `initiative_id`/`project_id`; `FolderTree`'s delete menu item is conditionally omitted — no prop signature change (component still takes the same `onDelete` callback, just doesn't render the entry point to it for auto-folders).

- [ ] **Step 1: Extend `FolderRow`**

In `../janreimanncrm/src/modules/documents/api.ts`, `FolderRow` type:

```ts
export type FolderRow = {
  id: string;
  name: string;
  parent_folder_id: string | null;
  initiative_id: string | null;
  project_id: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  children?: FolderRow[];
  doc_count?: number;
};
```

`fetchFolders` already does `.select("*")`, so no query change is needed — the new columns arrive automatically.

- [ ] **Step 2: Distinguish icons and disable delete in `FolderTree.tsx`**

Add imports for two more icons:

```ts
import { ChevronRight, Folder, FolderOpen, MoreHorizontal, Plus, Pencil, Trash2, FolderPlus, Briefcase, FolderKanban } from "lucide-react";
```

In `FolderNode`, replace the icon block:

```tsx
        {folder.initiative_id
          ? <Briefcase className="w-4 h-4 shrink-0 text-primary/70" />
          : folder.project_id
          ? <FolderKanban className="w-4 h-4 shrink-0 text-primary/70" />
          : isSelected || isOver
          ? <FolderOpen className="w-4 h-4 shrink-0 text-primary" />
          : <Folder className="w-4 h-4 shrink-0 text-muted-foreground" />}
```

And make the Delete menu item conditional:

```tsx
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onCreateChild(folder.id); }} className="text-[12px]">
            <FolderPlus className="w-3.5 h-3.5 mr-1.5" /> New subfolder
          </DropdownMenuItem>
          <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onRename(folder); }} className="text-[12px]">
            <Pencil className="w-3.5 h-3.5 mr-1.5" /> Rename
          </DropdownMenuItem>
          {!folder.initiative_id && !folder.project_id && (
            <DropdownMenuItem onClick={(e) => { e.stopPropagation(); onDelete(folder); }} className="text-[12px] text-destructive">
              <Trash2 className="w-3.5 h-3.5 mr-1.5" /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
```

- [ ] **Step 3: Build**

```bash
cd ../janreimanncrm
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 4: Commit**

```bash
cd ../janreimanncrm
git add src/modules/documents/api.ts src/modules/documents/components/FolderTree.tsx
git commit -m "feat: Workspace-/Projektordner in FolderTree kenntlich machen, Löschen sperren"
```

---

## Task 11: Webapp — document summary card on the project's Documents tab

**Files:**
- Modify: `../janreimanncrm/src/modules/projects/components/ProjectDocumentsTab.tsx`
- Modify: `../janreimanncrm/src/modules/projects/pages/ProjectDetailPage.tsx` (pass the two new fields down)

**Interfaces:**
- Consumes: `projects.document_summary`, `projects.document_summary_updated_at` (Task 2); `timeAgo` helper (already imported in `ProjectDetailPage.tsx` for the `ai_summary` card — reuse, don't reimplement).
- Produces: `ProjectDocumentsTab` gains two new optional props `documentSummary?: string` and `documentSummaryUpdatedAt?: string | null` — caller (`ProjectDetailPage.tsx`) passes `project.document_summary` / `project.document_summary_updated_at`.

- [ ] **Step 1: Check how `timeAgo` is imported in `ProjectDetailPage.tsx`**

```bash
cd ../janreimanncrm
grep -n "timeAgo" src/modules/projects/pages/ProjectDetailPage.tsx | head -3
```

Use the exact same import path in `ProjectDocumentsTab.tsx`.

- [ ] **Step 2: Add the props and the summary card**

In `ProjectDocumentsTab.tsx`, add `Sparkles` to the lucide-react import, add the `timeAgo` import found in Step 1, and extend the component:

```tsx
import { Upload, Download, Sparkles } from "lucide-react";
```

```tsx
export function ProjectDocumentsTab({
  projectId,
  documentSummary,
  documentSummaryUpdatedAt,
}: {
  projectId: string;
  documentSummary?: string;
  documentSummaryUpdatedAt?: string | null;
}) {
```

At the end of the returned JSX, after the closing `</div>` of the `vara-card` and before `<UploadDocumentPanel`, add:

```tsx
      {documentSummary && (
        <div className="vara-card p-3.5 mt-3.5 flex items-start gap-2.5 bg-primary/[0.03] border-primary/10">
          <Sparkles className="w-3.5 h-3.5 text-primary shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[13px] leading-snug">{documentSummary}</p>
            {documentSummaryUpdatedAt && (
              <p className="text-[11px] text-muted-foreground mt-1">
                Document Indexer update {timeAgo(documentSummaryUpdatedAt)}
              </p>
            )}
          </div>
        </div>
      )}
```

- [ ] **Step 3: Wire it up in `ProjectDetailPage.tsx`**

Change the `documents` tab render (line 351):

```tsx
        {tab === "documents" && (
          <ProjectDocumentsTab
            projectId={id!}
            documentSummary={project.document_summary}
            documentSummaryUpdatedAt={project.document_summary_updated_at}
          />
        )}
```

- [ ] **Step 4: Build**

```bash
cd ../janreimanncrm
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd ../janreimanncrm
git add src/modules/projects/components/ProjectDocumentsTab.tsx src/modules/projects/pages/ProjectDetailPage.tsx
git commit -m "feat: sichtbare document_summary-Karte im Documents-Tab eines Projekts"
```

---

## Task 12: Webapp — "System Agents" group, delete blocked for `is_system`

**Files:**
- Modify: `../janreimanncrm/src/modules/agents/api.ts` (`AgentRow` type)
- Modify: `../janreimanncrm/src/modules/agents/pages/AgentsPage.tsx` (`AgentCard`, `AgentsOverview`)

**Interfaces:**
- Consumes: `agents.is_system` (Task 2, regenerated types from Task 5).
- Produces: `AgentRow.is_system: boolean`; `AgentsOverview` renders two sections instead of one — no change to `onDeleteAgent`/`onEditAgent` callback signatures.

- [ ] **Step 1: Extend `AgentRow`**

In `../janreimanncrm/src/modules/agents/api.ts`:

```ts
export type AgentRow = {
  id: string;
  organization_id: string;
  created_by: string | null;
  name: string;
  description: string;
  color: AgentColor;
  system_prompt: string;
  append_system_prompt: string;
  tools: string[];
  model: string | null;
  is_default: boolean;
  is_system: boolean;
  skill_ids: string[];
  paused: boolean;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
};
```

`fetchAgents` already does `.select("*")`, no query change needed.

- [ ] **Step 2: Don't render Delete for system agents in `AgentCard`**

In `AgentsPage.tsx`, `AgentCard`'s dropdown content:

```tsx
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onEdit}>
            <Pencil className="w-3.5 h-3.5 mr-2" /> Edit
          </DropdownMenuItem>
          {!agent.is_system && (
            <DropdownMenuItem onClick={onDelete} className="text-destructive focus:text-destructive">
              <Trash2 className="w-3.5 h-3.5 mr-2" /> Delete
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
```

- [ ] **Step 3: Split "Your Agents" into two sections in `AgentsOverview`**

Replace the single `<section>` block (lines 241-260) with two:

```tsx
      <section className="space-y-3">
        <h2 className="text-[14px] font-semibold">Your Agents</h2>
        {loading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">Loading…</div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
            <NewTile label="New Agent" onClick={onNewAgent} />
            {agents.filter((a) => !a.is_system).map((agent) => (
              <AgentCard
                key={agent.id}
                agent={agent}
                hasTrigger={triggeredAgentIds.has(agent.id)}
                onOpen={() => onOpenAgent(agent.id)}
                onEdit={() => onEditAgent(agent.id)}
                onDelete={() => onDeleteAgent(agent.id)}
              />
            ))}
          </div>
        )}
      </section>

      {!loading && agents.some((a) => a.is_system) && (
        <>
          <div className="border-t border-border" />
          <section className="space-y-3">
            <h2 className="text-[14px] font-semibold">System Agents</h2>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
              {agents.filter((a) => a.is_system).map((agent) => (
                <AgentCard
                  key={agent.id}
                  agent={agent}
                  hasTrigger={triggeredAgentIds.has(agent.id)}
                  onOpen={() => onOpenAgent(agent.id)}
                  onEdit={() => onEditAgent(agent.id)}
                  onDelete={() => onDeleteAgent(agent.id)}
                />
              ))}
            </div>
          </section>
        </>
      )}
```

- [ ] **Step 4: Build**

```bash
cd ../janreimanncrm
npm run build
```

Expected: no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd ../janreimanncrm
git add src/modules/agents/api.ts src/modules/agents/pages/AgentsPage.tsx
git commit -m "feat: System-Agents-Gruppe in der Agenten-Übersicht, Löschen gesperrt"
```

---

## Task 13: End-to-end smoke test against production

**Files:** none (manual verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–12.

- [ ] **Step 1: Create a test initiative via the webapp and confirm the workspace folder appears**

In the running webapp (`npm run dev` in `../janreimanncrm`), create a new initiative named e.g. "Smoke Test Initiative". Open Documents — a folder named "Smoke Test Initiative" with the Briefcase icon should appear, with no Delete option in its context menu.

- [ ] **Step 2: Create a project inside that initiative and confirm the subfolder appears**

Create a project, set its initiative to "Smoke Test Initiative". In Documents, expand the workspace folder — a subfolder with the project's name and the FolderKanban icon should appear, also without Delete.

- [ ] **Step 3: Upload a document into the project subfolder and confirm a task is queued**

Upload any small text file into that subfolder. Then, via the Management Query Endpoint (same pattern as Task 5 Step 1), run:

```sql
SELECT id, agent_id, status, source_table, source_row_id, created_at
  FROM public.agent_tasks
 WHERE source_table = 'documents'
 ORDER BY created_at DESC LIMIT 5;
```

Expected: a row for the Document Indexer agent with `status = 'pending'` (or already `running`/`done` if the app-side agent runner picked it up quickly) and `source_row_id` matching the uploaded document.

- [ ] **Step 4: After the agent run completes, confirm the workspace index and project summary**

Once `agent_tasks.status` for that row reaches `done`, check:

```sql
SELECT d.file_name, d.doc_type FROM public.documents d
  JOIN public.document_folders f ON f.id = d.folder_id
 WHERE f.initiative_id IS NOT NULL AND d.doc_type = 'agent_index'
 ORDER BY d.uploaded_at DESC LIMIT 1;
```

Expected: one `_index.md` row. Then in the webapp, open the test project's Documents tab — the Document Indexer summary card should now show a sentence about the uploaded file, and the `_index.md` file itself must **not** appear in the file list (Task 9's filter).

- [ ] **Step 5: Confirm the Document Indexer cannot be deleted**

In the webapp, go to Agents — "Document Indexer" and "Project Curator" should both appear under a "System Agents" section, and neither should show a "Delete" option in their card menu.

- [ ] **Step 6: Clean up the smoke-test data**

Soft-delete the test project and delete the test initiative and its workspace folder/documents via the webapp UI (or note them for the user to remove) so production doesn't carry test debris.
