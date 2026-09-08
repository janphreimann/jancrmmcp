# Zugriff auf Anruf-/Meeting-Transkripte und Summaries über den MCP-Server

Status: genehmigt (Chat, 2026-09-08). Betrifft nur `jancrmmcp` (MCP-Server) —
keine DB-Migration, keine Änderung in `../janreimanncrm`. Alle benötigten
Spalten und Verknüpfungstabellen existieren bereits.

## Ziel

Fragen wie "Worum ging es im letzten Telefonat mit Frau Bubmann" sollen sich
über den MCP-Server beantworten lassen, indem ein Agent den bereits im CRM
verknüpften Anruf-/Meeting-Mitschnitt einer Kontaktperson findet und dessen
Transkript bzw. Zusammenfassung liest — ohne dass der Agent Zugriff auf die
Original-Audiodatei selbst bekommt.

## Bestandsaufnahme (CRM-Datenmodell)

Es gibt zwei unabhängige Transkript-Quellen im CRM:

1. **`audio_recordings`** — die primäre Quelle für "Telefonat mit Kontakt X".
   Nutzergebundene Tabelle (wie `calendar_events`, RLS auf `user_id =
   auth.uid()`). Eine Aufnahme-Session (`recording_group_id`) kann mehrere
   Spuren haben (`microphone`/`system_audio`/`combined`/`import`); die
   `combined`-Spur trägt i.d.R. das finale, diarisiertes Transkript
   (`transcript` text, `segments` jsonb `{speaker, text}[]`,
   `speaker_labels` jsonb `{[speakerIndex]: {name, contact_id}}`, `summary`
   text). Verknüpfung zu Kontakten/Firmen läuft **nicht** über eine Spalte
   auf `audio_recordings`, sondern über die Join-Tabellen
   `audio_recording_contacts` / `audio_recording_companies`, beide keyed auf
   `recording_group_id` (kein FK dorthin — lose Gruppierung, siehe
   Migrationskommentare). Der MCP-Server exportiert dafür bisher nur ein
   Schreib-Tool (`update_audio_recording_transcript`, ausschließlich für den
   Transcript-Cleanup-Agent) — kein Lese-/Such-Tool.

2. **`documents` mit `doc_type = 'transcript'`** — projektgebundene
   Meeting-Transkripte (manueller Upload in ein Projekt), mit automatisch
   generierter `Summary - <name>.md` als zweitem Dokument (`entity_type
   'project'`). `documents` hat zwar eine `contact_id`-Spalte und
   `create_text_document`/`upload_binary_document` unterstützen
   `entity_type: "contact"`, aber `list_documents` filtert bisher weder nach
   `doc_type` noch nach verknüpfter Entität — nur `folder_id` und
   Freitext-`query` auf `file_name`/`description`.

## A — Neue Tools in `src/tools/audioRecordings.ts`

### `search_audio_recordings`

```ts
{
  contact_id?: string (uuid),   // Filter: Session ist mit diesem Kontakt verknüpft
  company_id?: string (uuid),   // Filter: Session ist mit dieser Firma verknüpft
  query?: string,               // Substring auf title/transcript/summary
  since?: string,                // ISO-Datum, inklusive
  until?: string,                // ISO-Datum, inklusive
  limit?: number,                // default 25, max 100
}
```

Ablauf:

1. Ist `contact_id` gesetzt: `recording_group_id`s aus
   `audio_recording_contacts` laden (RLS greift bereits über die
   Parent-Row). Analog für `company_id` aus `audio_recording_companies`.
   Sind beide gesetzt, Schnittmenge bilden. Kein Treffer → leeres Ergebnis
   zurückgeben, keine weitere Query.
2. `audio_recordings` laden mit `.eq("user_id", ctx.userId)` (explizit,
   zusätzlich zu RLS — Konvention für nutzergebundene Tabellen laut
   CLAUDE.md/bestehendem Code), `.in("recording_group_id", ids)` falls aus
   Schritt 1 vorhanden, `.or(...)` für `query` auf `title`/`transcript`/
   `summary`, `created_at`-Range für `since`/`until`, absteigend sortiert.
3. Zeilen zu Sessions gruppieren (wie `groupAudioRecordings` im Frontend:
   pro `recording_group_id` die `combined`-Spur bevorzugen, sonst die
   erste), **danach erst** auf `limit` kürzen (eine Session kann mehrere
   Zeilen liefern).
4. Kontakt-/Firmennamen für die getroffenen `recording_group_id`s in einer
   zweiten Query nachladen (`audio_recording_contacts`/`_companies` mit
   Embed auf `contacts`/`companies`).

Rückgabe pro Session: `recording_group_id`, `title`, `created_at`,
`duration_seconds`, `transcription_status`, `summary`, `transcript_snippet`
(erste ~300 Zeichen von `transcript`, `null` wenn kein Transkript),
`contacts: {id, first_name, last_name}[]`, `companies: {id, name}[]`.
**Keine** `storage_path`, **keine** signed URL, **kein** `mime_type`.

### `get_audio_recording`

```ts
{ recording_group_id: string (uuid) }
```

Lädt alle Zeilen der Session mit `.eq("recording_group_id", ...)` +
`.eq("user_id", ctx.userId)`. Leeres Ergebnis → `throw new Error("Audio
recording session <id> not found")`. Gruppiert wie oben auf die
`combined`/primäre Spur. Löst `segments[].speaker` über `speaker_labels`
zu einem lesbaren Namen auf (`speaker_name: string | null`, `contact_id:
string | null`), ohne die rohen Indizes zu verlieren.

Rückgabe: `recording_group_id`, `title`, `created_at`, `duration_seconds`,
`transcription_status`, `transcript` (voll), `summary` (voll), `segments`
(mit aufgelösten Namen), `contacts`, `companies`. Auch hier keine
Audiodatei-Referenz.

Beide Tools werden in `src/tools/index.ts` neben
`update_audio_recording_transcript` registriert, mit Beschreibungen, die
explizit sagen: liefert nur Text (Transkript/Summary), keinen Zugriff auf
die Audiodatei.

## B — `list_documents` erweitern (`src/tools/documents.ts`)

Neue optionale Filter-Parameter:

```ts
doc_type?: string,        // z.B. "transcript"
contact_id?: string (uuid),
company_id?: string (uuid),
project_id?: string (uuid),
```

Jeweils als `.eq(...)` auf die entsprechende Spalte der `documents`-Tabelle
angewendet, wenn gesetzt (keine Join-Logik nötig — die Spalten liegen
direkt auf `documents`). `doc_type` zusätzlich ins `select(...)` aufnehmen,
damit die Ergebnisliste erkennen lässt, ob ein Treffer ein Transkript oder
eine generierte Summary ist. `getDocumentContent` bleibt unverändert — liest
bereits den vollen Text für `.md`/`.txt`-Dateien.

## Fehlerbehandlung

- `get_audio_recording` bei leerem Ergebnis: klarer "not found"-Fehler
  (falsche ID oder fremder User — RLS liefert in beiden Fällen null Zeilen),
  analog zu bestehenden `get_x`-Tools.
- `search_audio_recordings` bei keinem Treffer: leeres Array, kein Fehler
  (Konvention der bestehenden `search_x`-Tools).

## Testing

Kein bestehendes automatisiertes Test-Setup für `src/tools` im Server
sichtbar. Verifikation über `npm run build` (TypeScript-Compile) plus
manuellen Smoke-Test gegen eine echte MCP-Session: `search_audio_recordings`
mit einem echten `contact_id`, danach `get_audio_recording` auf die
gefundene Session, sowie `list_documents` mit `doc_type: "transcript"`.

## Out of Scope

- Kein Zugriff auf Original-Audiodateien (`storage_path`, signed URLs) über
  den MCP-Server — explizite Anforderung.
- Keine Volltextsuche über alle Transkripte hinweg mit Ranking (nur
  `ilike`-Substring, wie bei den übrigen `search_x`-Tools).
- Keine Änderung an `create_calendar_event`/Interactions — Anruf-Historie
  bleibt wie bisher getrennt von Transkripten.
