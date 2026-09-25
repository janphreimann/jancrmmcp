// Renders get_project_briefing()'s JSON into the markdown Claude reads
// (spec §4.2). Pure and dependency-free on purpose: Plan B copies this file
// byte-for-byte into ../janreimanncrm/src/modules/projects/briefingRender.ts
// for the "What Claude sees" sheet, and both repos snapshot-test it against
// the same fixtures in ../janreimanncrm/docs/superpowers/fixtures/.

export type TimelineRow = {
  kind: "journal" | "task_created" | "task_completed" | "interaction" | "email" | "audio_recording" | "calendar_event" | "document";
  item_id: string;
  occurred_at: string;
  title: string;
  preview: string;
  meta: Record<string, unknown>;
};

export type Briefing = {
  project: {
    id: string; name: string; stage: string;
    description: string; description_updated_at: string | null; description_updated_by_name: string | null;
    health: "green" | "amber" | "red"; last_activity_at: string | null;
    start_date: string | null; expected_close_date: string | null; budget_amount: number | null;
    created_at: string; updated_at: string;
    agent_status: string; agent_status_updated_at: string | null;
    initiative: { id: string; name: string; description: string; status: string } | null;
  };
  people: {
    contacts: { id: string; name: string; email: string | null; company_name: string | null; is_main: boolean }[];
    companies: { id: string; name: string }[];
  };
  tags: { id: string; name: string; color: string | null }[];
  since: string | null;
  delta: TimelineRow[];
  delta_counts: Record<string, number>;
  open: {
    tasks: { id: string; title: string; due_date: string | null; priority: string | null; status: string; assigned_to_name: string | null }[];
    tasks_total: number;
    next_steps: { id: string; title: string; rationale: string; created_by_agent: boolean; created_at: string }[];
    unanswered_emails: { id: string; subject: string; from_name: string | null; from_address: string | null; received_at: string }[];
    description_proposals: { id: string; reason: string; created_at: string }[];
    suggestion_counts: Partial<Record<"email" | "audio_recording" | "calendar_event", number>>;
  };
  index: {
    documents: { id: string; file_name: string; doc_type: string | null; uploaded_at: string; has_text: boolean }[];
    documents_total: number;
    interactions: { id: string; type: string; title: string; date: string; contact_names: { id: string; name: string }[]; has_next_steps: boolean }[];
    interactions_total: number;
    recordings: { id: string; title: string; created_at: string; duration_seconds: number | null; has_transcript: boolean; has_summary: boolean }[];
    recordings_total: number;
    events: { id: string; summary: string; start_at: string; end_at: string; all_day: boolean }[];
    events_total: number;
    emails_total: number;
    journal_total: number;
    pinned_journal: { id: string; entry_type: string; content: string; created_at: string; author_name: string | null }[];
  };
};

const DELTA_CAP = 30;
const DESCRIPTION_CAP = 6000;

const HEALTH_LABEL: Record<Briefing["project"]["health"], string> = {
  green: "on track", amber: "no recent activity", red: "overdue",
};

const KIND_LABEL: Record<TimelineRow["kind"], string> = {
  journal: "Journal", task_created: "Task added", task_completed: "Task done", interaction: "Interaction",
  email: "Mail", audio_recording: "Recording", calendar_event: "Event", document: "Document",
};

const REF_KIND: Record<TimelineRow["kind"], string> = {
  journal: "journal", task_created: "task", task_completed: "task", interaction: "interaction",
  email: "email", audio_recording: "recording", calendar_event: "event", document: "document",
};

function day(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : "";
}
function minute(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
function money(v: number | null): string {
  if (v == null) return "";
  if (v >= 1_000_000) return `€${(v / 1_000_000).toFixed(1)}M`;
  if (v >= 1_000) return `€${Math.round(v / 1_000)}K`;
  return `€${v}`;
}
function mmss(s: number | null): string {
  if (s == null) return "";
  const m = Math.floor(s / 60), r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}
function clip(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}
function ext(name: string): string {
  const m = name.match(/\.([a-z0-9]+)$/i);
  return m ? m[1].toLowerCase() : "file";
}

// Claude's own session log (log_project_activity). project_timeline already
// caps it at 1500 chars; clipping it again here would leave Claude unable to
// read back what it wrote last session — so it is shown in full.
export function isAgentSession(r: TimelineRow): boolean {
  return r.kind === "journal" && r.meta["entry_type"] === "agent_session";
}

function deltaLine(r: TimelineRow): string {
  let label = KIND_LABEL[r.kind];
  if (r.kind === "email") label = r.meta["direction"] === "outbound" ? "Mail out" : "Mail in";
  const who = r.kind === "email" && r.meta["from_name"] ? ` from ${r.meta["from_name"]}` : "";
  const body = r.preview && r.preview !== r.title
    ? isAgentSession(r) ? r.preview.replace(/\s+/g, " ").trim() : clip(r.preview, 120)
    : "";
  const preview = body ? ` — ${body}` : "";
  return `- ${day(r.occurred_at)} ${label}${who}: ${clip(r.title, 120)}${preview} [${REF_KIND[r.kind]}:${r.item_id}]`;
}

export function renderBriefing(b: Briefing, now: Date): string {
  const p = b.project;
  const out: string[] = [];

  // ── header ──
  out.push(`# ${p.name}`);
  const line2 = [p.stage, `Health: ${HEALTH_LABEL[p.health]}`];
  if (p.initiative) line2.push(`Part of: ${p.initiative.name} (${p.initiative.status})`);
  out.push(line2.join(" · "));
  const line3: string[] = [];
  if (p.start_date) line3.push(`Start ${p.start_date}`);
  if (p.expected_close_date) line3.push(`Target ${p.expected_close_date}`);
  if (p.budget_amount != null) line3.push(`Budget ${money(p.budget_amount)}`);
  if (line3.length) out.push(line3.join(" · "));
  const contacts = b.people.contacts.map((c) => {
    const bits = [c.company_name, c.is_main ? "main" : null].filter(Boolean).join(", ");
    return bits ? `${c.name} (${bits})` : c.name;
  });
  const line4: string[] = [];
  if (contacts.length) line4.push(`Contacts: ${contacts.join(", ")}`);
  if (b.people.companies.length) line4.push(`Companies: ${b.people.companies.map((c) => c.name).join(", ")}`);
  if (line4.length) out.push(line4.join(" · "));
  if (b.tags.length) out.push(`Tags: ${b.tags.map((t) => t.name).join(", ")}`);
  if (p.initiative?.description.trim()) out.push(`Initiative: ${clip(p.initiative.description, 300)}`);

  // ── status (Claude's zone) ──
  out.push("", `## Status (yours, ${p.agent_status_updated_at ? day(p.agent_status_updated_at) : "never written"})`);
  out.push(p.agent_status.trim()
    ? p.agent_status.trim()
    : "You have not written a status yet. Write one with update_agent_status before you leave.");

  // ── description (human zone) ──
  const descBy = p.description_updated_by_name ? ` by ${p.description_updated_by_name}` : "";
  out.push("", `## Description (human-owned, ${p.description_updated_at ? day(p.description_updated_at) + descBy : "never"})`);
  if (p.description.trim()) {
    const t = p.description.trim();
    out.push(t.length > DESCRIPTION_CAP ? t.slice(0, DESCRIPTION_CAP) + "\n…(description truncated — full text via get_project)" : t);
  } else {
    out.push("No description yet. If you learn durable facts, decisions or open questions, propose one with propose_description.");
  }
  if (b.open.description_proposals.length) {
    out.push(`You have ${b.open.description_proposals.length} open description proposal(s) awaiting the user — do not propose the same thing again.`);
  }

  // ── delta ──
  if (b.since) {
    out.push("", `## Since your last visit (${minute(b.since)} → ${minute(now.toISOString())})`);
    if (!b.delta.length) out.push("Nothing new.");
    const shown = b.delta.slice(0, DELTA_CAP);
    for (const r of shown) out.push(deltaLine(r));
    const total = Object.values(b.delta_counts).reduce((a, n) => a + n, 0);
    if (total > shown.length) {
      const rest = total - shown.length;
      const shownCounts: Record<string, number> = {};
      for (const r of shown) shownCounts[r.kind] = (shownCounts[r.kind] ?? 0) + 1;
      const parts = Object.entries(b.delta_counts)
        .map(([k, n]) => [k, n - (shownCounts[k] ?? 0)] as const)
        .filter(([, n]) => n > 0)
        .map(([k, n]) => `${k}: ${n}`)
        .join(", ");
      const oldest = shown[shown.length - 1]?.occurred_at ?? b.since;
      out.push(`+${rest} more (${parts}) → list_project_timeline(project_id, before="${oldest}")`);
    }
  } else {
    out.push("", "## First visit — everything below is new to you");
  }

  // ── open ──
  out.push("", "## Open");
  if (b.open.tasks.length) {
    out.push(`Tasks (${b.open.tasks_total}):`);
    for (const t of b.open.tasks) {
      const bits = [t.due_date ? `due ${day(t.due_date)}` : null, t.priority, t.assigned_to_name].filter(Boolean).join(" · ");
      out.push(`- ${t.title}${bits ? " · " + bits : ""} [task:${t.id}]`);
    }
    if (b.open.tasks_total > b.open.tasks.length) out.push(`+${b.open.tasks_total - b.open.tasks.length} more → search_tasks(project_id)`);
  }
  if (b.open.next_steps.length) {
    out.push(`Suggested next steps (${b.open.next_steps.length}, awaiting the user):`);
    for (const s of b.open.next_steps) out.push(`- ${s.title}${s.rationale ? " — " + clip(s.rationale, 160) : ""}`);
  }
  if (b.open.unanswered_emails.length) {
    out.push(`Unanswered inbound mail (${b.open.unanswered_emails.length}):`);
    for (const m of b.open.unanswered_emails) {
      const from = [m.from_name, m.from_address ? `<${m.from_address}>` : null].filter(Boolean).join(" ");
      out.push(`- ${day(m.received_at)} ${from}: ${m.subject} [email:${m.id}]`);
    }
  }
  const sc = b.open.suggestion_counts;
  const scParts = [
    sc.email ? `${sc.email} emails` : null,
    sc.audio_recording ? `${sc.audio_recording} recordings` : null,
    sc.calendar_event ? `${sc.calendar_event} events` : null,
  ].filter(Boolean);
  if (scParts.length) out.push(`Suggestion basket: ${scParts.join(", ")} waiting for the user to sort`);
  if (!b.open.tasks.length && !b.open.next_steps.length && !b.open.unanswered_emails.length && !scParts.length) {
    out.push("Nothing open.");
  }

  // ── index ──
  out.push("", "## Index");
  if (b.index.documents.length) {
    out.push(`Documents (${b.index.documents_total}):`);
    for (const d of b.index.documents) {
      out.push(`- ${d.file_name} · ${d.doc_type ?? ext(d.file_name)} · ${day(d.uploaded_at)} · ${d.has_text ? "text ✓" : "no text"} [document:${d.id}]`);
    }
    if (b.index.documents_total > b.index.documents.length) out.push(`+${b.index.documents_total - b.index.documents.length} more → list_documents(project_id)`);
  }
  if (b.index.interactions.length) {
    out.push(`Interactions (${b.index.interactions_total}):`);
    for (const i of b.index.interactions) {
      const names = i.contact_names.map((c) => c.name).join(", ");
      out.push(`- ${day(i.date)} ${i.title}${names ? " · " + names : ""} [interaction:${i.id}]`);
    }
    if (b.index.interactions_total > b.index.interactions.length) out.push(`+${b.index.interactions_total - b.index.interactions.length} more → list_interactions(project_id)`);
  }
  if (b.index.recordings.length) {
    out.push(`Recordings (${b.index.recordings_total}):`);
    for (const r of b.index.recordings) {
      out.push(`- ${day(r.created_at)} ${r.title} · ${mmss(r.duration_seconds)} · ${r.has_transcript ? "transcript ✓" : "pending"} [recording:${r.id}]`);
    }
    if (b.index.recordings_total > b.index.recordings.length) out.push(`+${b.index.recordings_total - b.index.recordings.length} more → list_project_timeline(project_id, kinds=["audio_recording"])`);
  }
  if (b.index.events.length) {
    out.push(`Events (${b.index.events_total}, upcoming first):`);
    for (const e of b.index.events) out.push(`- ${e.all_day ? day(e.start_at) : minute(e.start_at)} ${e.summary} [event:${e.id}]`);
    if (b.index.events_total > b.index.events.length) out.push(`+${b.index.events_total - b.index.events.length} more → list_project_timeline(project_id, kinds=["calendar_event"])`);
  }
  if (b.index.emails_total) out.push(`Emails linked: ${b.index.emails_total} → list_project_timeline(project_id, kinds=["email"])`);
  out.push(`Journal: ${b.index.journal_total} entries, ${b.index.pinned_journal.length} pinned`);
  if (b.index.pinned_journal.length) {
    out.push("Pinned:");
    for (const j of b.index.pinned_journal) {
      const by = [j.author_name, day(j.created_at)].filter(Boolean).join(", ");
      out.push(`> ${j.content.trim().replace(/\n/g, "\n> ")}${by ? `   (${by})` : ""}`);
    }
  }

  // ── tools ──
  out.push("", "## Tools");
  out.push("Drill down: get_document_content · get_interaction · get_audio_recording · get_email · list_project_timeline(project_id, before, kinds, limit)");
  out.push("Write back: update_agent_status · log_project_activity · suggest_next_step · propose_description · link_project_item · create_task · update_task · create_text_document");
  out.push(`project_id: ${p.id}`);

  return out.join("\n") + "\n";
}
