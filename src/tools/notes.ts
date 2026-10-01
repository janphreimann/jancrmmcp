import { z } from "zod";
import { agentMeta } from "../supabase.js";
import type { Ctx } from "../context.js";
import { isNotFoundError } from "./dbErrors.js";

// Notes are the CRM's Notes library (three-pane, markdown in `content`):
// folders (note_folders), pinning, tags and links to contacts, companies and
// projects via the note_* join tables. Every join row gets its organization
// from the note (set_organization_id_from_note) and is rejected unless the
// target belongs to the same organization (validate_note_link) — a foreign or
// unknown id raises P0001, which isNotFoundError maps to "not found".

const LINKS = {
  tag: { table: "note_tags", col: "tag_id" },
  contact: { table: "note_contacts", col: "contact_id" },
  company: { table: "note_companies", col: "company_id" },
  project: { table: "note_projects", col: "project_id" },
} as const;
type LinkKind = keyof typeof LINKS;

const linkSetSchema = z.object({
  tag_ids: z.array(z.string().uuid()).optional().describe("Tag UUIDs (list_tags)"),
  contact_ids: z.array(z.string().uuid()).optional(),
  company_ids: z.array(z.string().uuid()).optional(),
  project_ids: z.array(z.string().uuid()).optional(),
}).strict();
type LinkSet = z.infer<typeof linkSetSchema>;

function linkPairs(set: LinkSet | undefined): { kind: LinkKind; id: string }[] {
  if (!set) return [];
  return [
    ...(set.tag_ids ?? []).map((id) => ({ kind: "tag" as const, id })),
    ...(set.contact_ids ?? []).map((id) => ({ kind: "contact" as const, id })),
    ...(set.company_ids ?? []).map((id) => ({ kind: "company" as const, id })),
    ...(set.project_ids ?? []).map((id) => ({ kind: "project" as const, id })),
  ];
}

async function addLinks(ctx: Ctx, noteId: string, set: LinkSet | undefined) {
  for (const { kind, id } of linkPairs(set)) {
    const { table, col } = LINKS[kind];
    const { error } = await ctx.db.from(table).insert({ note_id: noteId, [col]: id });
    // Already linked is the state we wanted.
    if (!error || error.code === "23505") continue;
    if (isNotFoundError(error)) throw new Error(`${kind} ${id} not found`);
    throw new Error(`Could not link ${kind} ${id}: ${error.message}`);
  }
}

async function removeLinks(ctx: Ctx, noteId: string, set: LinkSet | undefined) {
  for (const { kind, id } of linkPairs(set)) {
    const { table, col } = LINKS[kind];
    const { error } = await ctx.db.from(table).delete().eq("note_id", noteId).eq(col, id);
    if (error) throw new Error(`Could not unlink ${kind} ${id}: ${error.message}`);
  }
}

function folderError(err: { code?: string; message: string }, folderId: string | null | undefined): Error {
  // validate_note_folder raises P0001 for an unknown or foreign folder.
  if (folderId && isNotFoundError(err)) return new Error(`Note folder ${folderId} not found`);
  return new Error(err.message);
}

// ─── Folders ──────────────────────────────────────────────────────────────────

export const listNoteFoldersSchema = z.object({});

export async function listNoteFolders(ctx: Ctx) {
  const { data, error } = await ctx.db
    .from("note_folders")
    .select("id, name, parent_folder_id")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export const searchNotesSchema = z.object({
  query: z.string().optional().describe("Search in title and content"),
  folder_id: z.string().uuid().optional().nullable().describe(
    "Filter by note folder UUID. Pass null for notes outside any folder. Omit for all."
  ),
  tag_id: z.string().uuid().optional().describe("Only notes carrying this tag"),
  contact_id: z.string().uuid().optional().describe("Only notes linked to this contact"),
  company_id: z.string().uuid().optional().describe("Only notes linked to this company"),
  project_id: z.string().uuid().optional().describe("Only notes linked to this project"),
  pinned: z.boolean().optional().describe("Only pinned (true) or unpinned (false) notes"),
  limit: z.number().int().min(1).max(100).default(30),
});

export async function searchNotes(ctx: Ctx, args: z.infer<typeof searchNotesSchema>) {
  // Link filters intersect: a note has to carry every requested link.
  let ids: string[] | null = null;
  const filters: [LinkKind, string | undefined][] = [
    ["tag", args.tag_id], ["contact", args.contact_id], ["company", args.company_id], ["project", args.project_id],
  ];
  for (const [kind, target] of filters) {
    if (!target) continue;
    const { table, col } = LINKS[kind];
    const { data, error } = await ctx.db.from(table).select("note_id").eq(col, target);
    if (error) throw new Error(error.message);
    const found = new Set((data ?? []).map((r: { note_id: string }) => r.note_id));
    ids = ids === null ? [...found] : ids.filter((id) => found.has(id));
  }
  if (ids !== null && ids.length === 0) return [];

  let q = ctx.db
    .from("notes")
    .select("id, title, content, folder_id, pinned, created_at, updated_at, created_by_agent, agent_approved")
    .order("pinned", { ascending: false })
    .order("updated_at", { ascending: false })
    .limit(args.limit);
  if (ids !== null) q = q.in("id", ids);
  if (args.folder_id === null) q = q.is("folder_id", null);
  else if (args.folder_id) q = q.eq("folder_id", args.folder_id);
  if (args.pinned !== undefined) q = q.eq("pinned", args.pinned);
  if (args.query) {
    // PostgREST's or() splits on commas and parentheses; strip them from the term.
    const term = args.query.replace(/[,()%*]/g, " ").trim();
    if (term) q = q.or(`title.ilike.%${term}%,content.ilike.%${term}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return (data ?? []).map(({ content, ...n }: { content: string } & Record<string, unknown>) => ({
    ...n,
    preview: content.length > 200 ? `${content.slice(0, 200)}…` : content,
  }));
}

export const getNoteSchema = z.object({
  id: z.string().uuid().describe("Note UUID"),
});

export async function getNote(ctx: Ctx, args: z.infer<typeof getNoteSchema>) {
  const { data: note, error } = await ctx.db
    .from("notes")
    .select("id, title, content, folder_id, pinned, created_by, created_at, updated_at, created_by_agent, agent_approved, note_folders ( name )")
    .eq("id", args.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!note) return null;

  const [tags, contacts, companies, projects] = await Promise.all([
    ctx.db.from("note_tags").select("tags ( id, name )").eq("note_id", args.id),
    ctx.db.from("note_contacts").select("contacts ( id, first_name, last_name, deleted_at )").eq("note_id", args.id),
    ctx.db.from("note_companies").select("companies ( id, name, deleted_at )").eq("note_id", args.id),
    ctx.db.from("note_projects").select("projects ( id, name, deleted_at )").eq("note_id", args.id),
  ]);
  for (const r of [tags, contacts, companies, projects]) if (r.error) throw new Error(r.error.message);

  // The embedded target is one row (to-one FK); RLS-hidden or soft-deleted
  // targets are dropped.
  type Target = { id: string; name?: string; first_name?: string | null; last_name?: string | null; deleted_at?: string | null };
  const live = (rows: unknown[] | null, key: string) =>
    ((rows ?? []) as Record<string, Target | null>[])
      .map((r) => r[key])
      .filter((t): t is Target => !!t && !t.deleted_at);

  const { note_folders, ...rest } = note as unknown as typeof note & { note_folders: { name: string } | null };
  return {
    ...rest,
    folder_name: note_folders?.name ?? null,
    tags: live(tags.data, "tags").map((t) => ({ id: t.id, name: t.name })),
    contacts: live(contacts.data, "contacts")
      .map((c) => ({ id: c.id, name: `${c.first_name ?? ""} ${c.last_name ?? ""}`.trim() })),
    companies: live(companies.data, "companies").map((c) => ({ id: c.id, name: c.name })),
    projects: live(projects.data, "projects").map((p) => ({ id: p.id, name: p.name })),
  };
}

// ─── Writing ──────────────────────────────────────────────────────────────────

export const createNoteSchema = z.object({
  title: z.string().optional().nullable().describe("Note title. Omit for an untitled note."),
  content: z.string().min(1).describe("Note body in markdown"),
  folder_id: z.string().uuid().optional().nullable().describe("Note folder UUID (list_note_folders). Omit for no folder."),
  pinned: z.boolean().optional().describe("Pin the note to the top of the list. Only when the user asks for it."),
  tag_ids: linkSetSchema.shape.tag_ids,
  contact_ids: z.array(z.string().uuid()).optional().describe("Contacts the note is about"),
  company_ids: z.array(z.string().uuid()).optional().describe("Companies the note is about"),
  project_ids: z.array(z.string().uuid()).optional().describe("Projects the note belongs to"),
}).strict();

export async function createNote(ctx: Ctx, args: z.infer<typeof createNoteSchema>) {
  // organization_id comes from the column default + trigger, never from here.
  const { data, error } = await ctx.db
    .from("notes")
    .insert({
      title: args.title?.trim() || null,
      content: args.content,
      folder_id: args.folder_id ?? null,
      pinned: args.pinned ?? false,
      created_by: ctx.userId,
      ...agentMeta(),
    })
    .select("id")
    .single();
  if (error) throw folderError(error, args.folder_id);

  try {
    await addLinks(ctx, data.id, args);
  } catch (e) {
    // All or nothing: a note missing half the links it was asked for is worse
    // than an error the caller can correct and retry.
    await ctx.db.from("notes").delete().eq("id", data.id);
    throw e;
  }
  return { id: data.id, message: `Note "${args.title?.trim() || "Untitled"}" created` };
}

export const updateNoteSchema = z.object({
  id: z.string().uuid().describe("Note UUID"),
  title: z.string().optional().nullable(),
  content: z.string().min(1).optional().describe("Replaces the whole body (markdown). Read it with get_note first."),
  folder_id: z.string().uuid().optional().nullable().describe("Move to this note folder; null takes it out of its folder"),
  pinned: z.boolean().optional(),
  link: linkSetSchema.optional().describe("Links to add; existing links stay"),
  unlink: linkSetSchema.optional().describe("Links to remove"),
}).strict();

export async function updateNote(ctx: Ctx, args: z.infer<typeof updateNoteSchema>) {
  const { id, link, unlink, ...fields } = args;
  const patch: Record<string, unknown> = {};
  if (fields.title !== undefined) patch.title = fields.title?.trim() || null;
  if (fields.content !== undefined) patch.content = fields.content;
  // Filing and pinning organize a note; only editing the text counts as an
  // edit, so only that moves updated_at (same as the web app).
  if ("title" in patch || "content" in patch) patch.updated_at = new Date().toISOString();
  if (fields.folder_id !== undefined) patch.folder_id = fields.folder_id;
  if (fields.pinned !== undefined) patch.pinned = fields.pinned;

  if (Object.keys(patch).length) {
    const { data, error } = await ctx.db.from("notes").update(patch).eq("id", id).select("id");
    if (error) throw folderError(error, fields.folder_id);
    if (!data?.length) throw new Error(`Note ${id} not found`);
  } else {
    // Links only: make sure the note is visible before touching join rows, so
    // a foreign id answers "not found" like everywhere else.
    const { data } = await ctx.db.from("notes").select("id").eq("id", id).maybeSingle();
    if (!data) throw new Error(`Note ${id} not found`);
  }

  await removeLinks(ctx, id, unlink);
  await addLinks(ctx, id, link);
  return { id, message: "Note updated" };
}
