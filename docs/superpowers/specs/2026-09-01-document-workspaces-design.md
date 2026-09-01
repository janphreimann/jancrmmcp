# Initiative-Workspaces & Agenten-Inhaltsverzeichnis für Documents

Status: genehmigt (Chat, 2026-09-01). Betrifft zwei Repos: `jancrmmcp`
(MCP-Server) und `../janreimanncrm` (Webapp + DB-Migrationen). Umsetzung läuft
mit expliziter Erlaubnis, gegen die Produktions-DB zu migrieren.

## Ziel

Jede Initiative bekommt automatisch einen eigenen Dokumenten-Workspace; jedes
Projekt einer Initiative bekommt automatisch einen Unterordner darin. Ein
neuer Hintergrund-Agent hält pro Workspace ein maschinenlesbares
Inhaltsverzeichnis aktuell, damit ein Agent, der in einer Initiative
arbeitet, nicht jedes Dokument einzeln lesen muss. Für Menschen bleibt das
Verzeichnis unsichtbar; eine kurze, für Menschen lesbare Zusammenfassung
landet stattdessen sichtbar im Projekt.

## A — Datenmodell: Workspaces & Projektordner

`document_folders` bekommt zwei neue nullable Spalten:

```sql
ALTER TABLE public.document_folders
  ADD COLUMN initiative_id uuid REFERENCES public.initiatives(id) ON DELETE SET NULL,
  ADD COLUMN project_id    uuid REFERENCES public.projects(id)    ON DELETE SET NULL;
```

Zwei Trigger, nach dem Muster von `trg_validate_project_initiative`:

- `AFTER INSERT ON initiatives` → legt einen Root-Ordner an
  (`name = NEW.name`, `initiative_id = NEW.id`, `parent_folder_id = NULL`,
  `created_by_agent = true` — Ordner kommt aus der Automatik, nicht von
  einem Menschen).
- `AFTER INSERT OR UPDATE OF initiative_id ON projects` (nur wenn
  `NEW.initiative_id IS NOT NULL`) → legt einen Unterordner im
  Workspace-Root der Initiative an (`parent_folder_id` = deren Root-Ordner,
  `project_id = NEW.id`, `name = NEW.name`, `created_by_agent = true`).
  Wechselt ein Projekt die Initiative, entsteht ein neuer Ordner in der
  neuen Initiative; der alte Ordner bleibt stehen (Dokumente werden nicht
  automatisch verschoben — das wäre Datenverlust-Risiko ohne Nutzer-Bestätigung).

Migration backfillt bestehende Initiatives/Projekte in derselben Datei.

`ON DELETE SET NULL` statt CASCADE: löscht jemand eine Initiative oder ein
Projekt, bleiben Ordner und Dokumente erhalten, verlieren nur die
Verknüpfung — konsistent mit `projects.initiative_id` (vgl. `CLAUDE.md`
Migration `20261103000000_initiatives.sql`).

## B — Sidebar (Webapp)

Keine neue Komponente. Workspace-/Projektordner sind normale
`document_folders`-Zeilen mit `parent_folder_id` und erscheinen automatisch
im bestehenden `FolderTree`. Anpassungen in `FolderTree`/`DocumentsPage.tsx`:

- Ordner mit gesetztem `initiative_id` oder `project_id` bekommen ein
  eigenes Icon (z. B. Briefcase für Workspace, ein anderes für Projekt)
  statt des generischen Folder-Icons.
- Löschen ist für diese Ordner im Kontextmenü deaktiviert (sie hängen an
  der Initiative/dem Projekt; Dokumente drin blieben sonst ohne Ziel für
  neue Auto-Uploads). Umbenennen bleibt erlaubt und ist rein kosmetisch —
  wirkt sich nicht auf `initiatives.name`/`projects.name` zurück.

## C — Inhaltsverzeichnis (TOC) + sichtbare Zusammenfassung

Zwei getrennte Artefakte, ein Agent pflegt beide:

**1. Workspace-TOC (agentenintern, für Menschen unsichtbar)**

Eine normale `documents`-Zeile im Workspace-Root-Ordner mit
`doc_type = 'agent_index'`. Markdown, nach Projekt-Unterordnern
gegliedert, pro Dokument eine Zeile: Dateiname, Ein-Satz-Zusammenfassung,
Dokument-ID, Datum. `list_documents` (MCP) und `fetchDocuments` (Webapp)
filtern `doc_type = 'agent_index'` künftig standardmäßig heraus.

Zwei neue MCP-Tools, ausschließlich für den Indexer-Agenten gedacht:

- `get_workspace_index(initiative_id)` — liest die TOC-Zeile (legt keine an).
- `upsert_workspace_index(initiative_id, content)` — erstellt oder
  überschreibt sie (`doc_type = 'agent_index'`, `agentMeta()`).

**2. Projekt-Dokumentzusammenfassung (für Menschen sichtbar)**

Neue Spalten auf `projects`, exakt nach dem Muster von
`ai_summary`/`ai_summary_updated_at` (Project Curator), aber inhaltlich
getrennt — eine fasst allgemeine Aktivität zusammen, die andere nur die
Dokumente:

```sql
ALTER TABLE public.projects
  ADD COLUMN document_summary text NOT NULL DEFAULT '',
  ADD COLUMN document_summary_updated_at timestamptz;
```

Aktualisiert wird das über das bestehende `update_project`-Tool (Feld
ergänzen) — kein neues Tool nötig, der Indexer bekommt nur Zugriff auf
`update_project` mit auf dieses Feld beschränkter Beschreibung im
System-Prompt (analog zur Curator-Konvention "never touches brief or
description").

Anzeige: `ProjectDocumentsTab.tsx` (Webapp) bekommt am Ende eine Karte
im Stil der bestehenden `ai_summary`-Karte auf `ProjectDetailPage.tsx`
(Sparkles-Icon, `document_summary` + "Indexer update {timeAgo(...)}"),
sichtbar sobald `document_summary` nicht leer ist.

## D — Der Indexer-Agent

Neuer Systemagent **"Document Indexer"**, geseedet wie der Project Curator
(`seed_project_curator_agent` als Vorlage), aber zusätzlich:

- **Systemagent, nicht löschbar.** `agents` bekommt eine neue Spalte
  `is_system boolean NOT NULL DEFAULT false`; Document Indexer und Project
  Curator werden nachträglich auf `true` gesetzt (kleine Zusatzmigration).
  Das Lösch-Tool/die Lösch-Route für Agenten in der Webapp prüft
  `is_system` und blockt mit einer klaren Fehlermeldung.
- **Gruppierung "System Agents".** Die Agenten-Übersicht in der Webapp
  gruppiert nach `is_system` (neue Gruppe "System Agents" für
  `is_system = true`, bestehende Liste für den Rest). Project Curator
  wandert dabei sichtbar mit in diese neue Gruppe — vorher lief er einfach
  in der normalen Liste mit.
- **Trigger:** `kind = 'event'`, `event_table = 'documents'`.

System-Prompt-Kernauftrag: Dokument lesen (`get_document_content`), Ordner
darüber auflösen (`list_folders`), prüfen ob der Ordner zu einem Workspace
gehört (`initiative_id` oder `project_id` gesetzt) — falls nicht (freier,
nicht verknüpfter Ordner), nichts tun. Sonst: bestehendes Workspace-TOC
lesen (`get_workspace_index`), den Eintrag für dieses Dokument ergänzen
oder aktualisieren, zurückschreiben (`upsert_workspace_index`); gehört der
Ordner zusätzlich zu einem Projekt (`project_id` gesetzt), zusätzlich
`document_summary` dieses Projekts über `update_project` aktualisieren
(kurze, faktenorientierte 1-2 Sätze über den aktuellen Dokumentenstand).

Tools: `get_document_content`, `list_folders`, `get_workspace_index`,
`upsert_workspace_index`, `update_project`.

## E — Event-Trigger auf INSERT *und* UPDATE

Die bestehende Fanout-Funktion (`20260829_agent_event_triggers.sql`) ist
hart auf `event_op = 'INSERT'` verdrahtet, und es existieren nur
`AFTER INSERT`-Trigger. "Hochlädt, ändert oder aktualisiert" erfordert auch
UPDATE:

- `agent_event_fanout()` wechselt von `tr.event_op = 'INSERT'` (Literal)
  auf `tr.event_op = TG_OP` (dynamisch) — rückwärtskompatibel, weil aktuell
  ausschließlich INSERT-Trigger hängen und alle bestehenden
  `agent_triggers`-Zeilen `event_op = 'INSERT'` haben.
- Neuer `AFTER UPDATE OF file_url, file_size, file_name, folder_id ON
  documents`-Trigger (nur bei inhaltlich relevanten Spaltenänderungen, kein
  Feuern bei z. B. reiner `description`-Änderung).
- `agent_tasks.source_row_id` + der bestehende Open-Task-Check entprellen
  wie gehabt; `NEW.created_by_agent` verhindert, dass der Indexer sich
  durch sein eigenes `update_project`/`upsert_workspace_index` selbst
  erneut auslöst.

## Rollout-Reihenfolge

1. Migrationen in `../janreimanncrm/supabase/migrations/` schreiben:
   Ordner-Spalten + Trigger (A), `projects.document_summary` (C),
   `agents.is_system` (D), Fanout-Erweiterung auf UPDATE (E), Seed-Migration
   für den Document-Indexer-Agenten (D), Backfill bestehender
   Initiatives/Projekte (A) und `is_system` für den Project Curator (D).
2. Migrationen über den Management-Query-Endpunkt einspielen (nicht
   Dashboard-SQL-Editor), danach `supabase gen types typescript` und
   `supabase/gen_schema_export.py` neu ziehen (`CLAUDE.md`-Vorgabe).
3. MCP-Server (`jancrmmcp`): `list_documents`-Filter auf `agent_index`,
   zwei neue Tools (`get_workspace_index`, `upsert_workspace_index`),
   Registrierung in `src/tools/index.ts`.
4. Webapp: `fetchDocuments`-Filter, `FolderTree`-Icons + Lösch-Sperre,
   `ProjectDocumentsTab`-Summary-Karte, Agenten-Übersicht gruppiert nach
   `is_system`, Lösch-Route blockt `is_system`-Agenten.
5. Manueller Smoke-Test: Initiative anlegen → Workspace-Ordner erscheint;
   Projekt mit Initiative anlegen → Unterordner erscheint; Dokument
   hochladen → `agent_tasks`-Zeile entsteht → nach Agentenlauf TOC-Dokument
   und ggf. `document_summary` aktualisiert und in der UI sichtbar.

## Offen / bewusst nicht im Scope

- Freistehende, nicht mit Initiative/Projekt verknüpfte Ordner bekommen
  kein TOC (nur Workspaces).
- Verschieben von Dokumenten beim Initiative-Wechsel eines Projekts ist
  manuell (siehe A).
- Kein LLM-Aufruf bei reinem Metadaten-Update (`description`, `folder_id`
  manuell verschoben) — nur bei inhaltlicher Änderung der Datei selbst.
