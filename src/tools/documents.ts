import { z } from "zod";
import { randomUUID } from "crypto";
import { supabase, agentMeta, ORG_ID } from "../supabase.js";

// ─── Folder tools ─────────────────────────────────────────────────────────────

export const listFoldersSchema = z.object({});

export async function listFolders() {
  const { data, error } = await supabase
    .from("document_folders")
    .select("id, name, parent_folder_id, created_at")
    .order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const createFolderSchema = z.object({
  name: z.string().min(1).describe("Folder name"),
  parent_folder_id: z.string().uuid().optional().nullable().describe(
    "UUID of the parent folder. Omit or set null to create at root level."
  ),
});

export async function createFolder(args: z.infer<typeof createFolderSchema>) {
  const { data, error } = await supabase
    .from("document_folders")
    .insert({ name: args.name, parent_folder_id: args.parent_folder_id ?? null, ...agentMeta() })
    .select("id, name, parent_folder_id")
    .single();
  if (error) throw new Error(error.message);
  return { id: data.id, name: data.name, message: `Folder "${args.name}" created` };
}

export const renameFolderSchema = z.object({
  id: z.string().uuid().describe("Folder UUID"),
  name: z.string().min(1).describe("New folder name"),
});

export async function renameFolder(args: z.infer<typeof renameFolderSchema>) {
  const { error } = await supabase
    .from("document_folders")
    .update({ name: args.name, updated_at: new Date().toISOString() })
    .eq("id", args.id);
  if (error) throw new Error(error.message);
  return { id: args.id, message: `Folder renamed to "${args.name}"` };
}

// ─── Document listing & reading ───────────────────────────────────────────────

export const listDocumentsSchema = z.object({
  folder_id: z.string().uuid().optional().nullable().describe(
    "Filter by folder UUID. Pass null to list only root-level documents (no folder). Omit entirely to list all documents."
  ),
  query: z.string().optional().describe("Search in file name or description"),
  limit: z.number().int().min(1).max(100).default(50),
});

export async function listDocuments(args: z.infer<typeof listDocumentsSchema>) {
  let q = supabase
    .from("documents")
    .select("id, file_name, file_size, description, folder_id, uploaded_at, contact_id, company_id, deal_id")
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .order("uploaded_at", { ascending: false })
    .limit(args.limit);

  if ("folder_id" in args && args.folder_id !== undefined) {
    if (args.folder_id === null) {
      q = q.is("folder_id", null);
    } else {
      q = q.eq("folder_id", args.folder_id);
    }
  }
  if (args.query) {
    q = q.or(`file_name.ilike.%${args.query}%,description.ilike.%${args.query}%`);
  }

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data ?? [];
}

export const getDocumentContentSchema = z.object({
  id: z.string().uuid().describe("Document UUID"),
});

export async function getDocumentContent(args: z.infer<typeof getDocumentContentSchema>) {
  const { data: doc, error } = await supabase
    .from("documents")
    .select("id, file_name, file_url, file_size, description, folder_id, uploaded_at")
    .eq("id", args.id)
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!doc) return null;

  const { data: urlData, error: urlErr } = await supabase.storage
    .from("documents")
    .createSignedUrl(doc.file_url, 3600);
  if (urlErr) throw new Error(urlErr.message);

  const ext = (doc.file_name.split(".").pop() || "").toLowerCase();
  const textTypes = ["txt", "md", "csv", "json", "xml", "html", "htm", "log", "yaml", "yml", "ts", "js", "tsx", "jsx", "py", "sql"];

  if (textTypes.includes(ext)) {
    const res = await fetch(urlData.signedUrl);
    if (!res.ok) throw new Error(`Failed to download document: ${res.statusText}`);
    const content = await res.text();
    return {
      id: doc.id,
      file_name: doc.file_name,
      description: doc.description,
      folder_id: doc.folder_id,
      uploaded_at: doc.uploaded_at,
      content,
      signed_url: urlData.signedUrl,
    };
  }

  return {
    id: doc.id,
    file_name: doc.file_name,
    description: doc.description,
    folder_id: doc.folder_id,
    uploaded_at: doc.uploaded_at,
    content: null,
    signed_url: urlData.signedUrl,
    note: "Binary file — use signed_url to download",
  };
}

// ─── Document creation & editing ─────────────────────────────────────────────

const entityTypeEnum = z.enum(["contact", "company", "deal", "interaction", "calendar_event", "task", "none"]);

export const createTextDocumentSchema = z.object({
  file_name: z.string().min(1).describe(
    "File name including extension, e.g. 'research-notes.md' or 'report.txt'"
  ),
  content: z.string().describe("Text content of the document"),
  description: z.string().optional().nullable().describe("Optional short description"),
  folder_id: z.string().uuid().optional().nullable().describe("UUID of the folder to place this document in"),
  entity_type: entityTypeEnum.default("none").describe(
    "Optional CRM entity to link this document to"
  ),
  entity_id: z.string().uuid().optional().nullable().describe("UUID of the linked entity"),
});

export async function createTextDocument(args: z.infer<typeof createTextDocumentSchema>) {
  const { file_name, content, description, folder_id, entity_type, entity_id } = args;

  const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const folderPath = entity_type === "none" ? "general" : entity_type;
  const idPart = entity_id || "_none_";
  const storagePath = `${folderPath}/${idPart}/${randomUUID()}_${safeName}`;

  const buffer = Buffer.from(content, "utf-8");

  const ext = (file_name.split(".").pop() || "").toLowerCase();
  const contentTypeMap: Record<string, string> = {
    md: "text/markdown", txt: "text/plain", csv: "text/csv",
    json: "application/json", html: "text/html", htm: "text/html",
    xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
    sql: "text/plain", py: "text/plain",
  };
  const contentType = contentTypeMap[ext] ?? "text/plain";

  const { error: upErr } = await supabase.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (upErr) throw new Error(upErr.message);

  const insert: Record<string, unknown> = {
    file_name,
    file_url: storagePath,
    file_size: buffer.byteLength,
    description: description ?? null,
    folder_id: folder_id ?? null,
    contact_id: entity_type === "contact" ? entity_id : null,
    company_id: entity_type === "company" ? entity_id : null,
    deal_id: entity_type === "deal" ? entity_id : null,
    interaction_id: entity_type === "interaction" ? entity_id : null,
    calendar_event_id: entity_type === "calendar_event" ? entity_id : null,
    task_id: entity_type === "task" ? entity_id : null,
    organization_id: ORG_ID,
    ...agentMeta(),
  };

  const { data, error } = await supabase.from("documents").insert(insert).select("id").single();
  if (error) throw new Error(error.message);
  return { id: data.id, message: `Document "${file_name}" created successfully` };
}

const binaryContentTypeMap: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  bmp: "image/bmp",
  tiff: "image/tiff",
  zip: "application/zip",
  tar: "application/x-tar",
  gz: "application/gzip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  webm: "video/webm",
};

export const uploadBinaryDocumentSchema = z.object({
  file_name: z.string().min(1).describe(
    "File name including extension, e.g. 'report.pdf' or 'slides.pptx'"
  ),
  file_data: z.string().min(1).describe(
    "Base64-encoded file contents (standard Base64, no data-URI prefix)"
  ),
  mime_type: z.string().optional().nullable().describe(
    "MIME type override, e.g. 'application/pdf'. Auto-detected from extension when omitted."
  ),
  description: z.string().optional().nullable().describe("Optional short description"),
  folder_id: z.string().uuid().optional().nullable().describe("UUID of the folder to place this document in"),
  entity_type: entityTypeEnum.default("none").describe(
    "Optional CRM entity to link this document to"
  ),
  entity_id: z.string().uuid().optional().nullable().describe("UUID of the linked entity"),
});

export async function uploadBinaryDocument(args: z.infer<typeof uploadBinaryDocumentSchema>) {
  const { file_name, file_data, mime_type, description, folder_id, entity_type, entity_id } = args;

  const buffer = Buffer.from(file_data, "base64");

  const safeName = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
  const folderPath = entity_type === "none" ? "general" : entity_type;
  const idPart = entity_id || "_none_";
  const storagePath = `${folderPath}/${idPart}/${randomUUID()}_${safeName}`;

  const ext = (file_name.split(".").pop() || "").toLowerCase();
  const contentType = mime_type || binaryContentTypeMap[ext] || "application/octet-stream";

  const { error: upErr } = await supabase.storage
    .from("documents")
    .upload(storagePath, buffer, { contentType, upsert: false });
  if (upErr) throw new Error(upErr.message);

  const insert: Record<string, unknown> = {
    file_name,
    file_url: storagePath,
    file_size: buffer.byteLength,
    description: description ?? null,
    folder_id: folder_id ?? null,
    contact_id: entity_type === "contact" ? entity_id : null,
    company_id: entity_type === "company" ? entity_id : null,
    deal_id: entity_type === "deal" ? entity_id : null,
    interaction_id: entity_type === "interaction" ? entity_id : null,
    calendar_event_id: entity_type === "calendar_event" ? entity_id : null,
    task_id: entity_type === "task" ? entity_id : null,
    organization_id: ORG_ID,
    ...agentMeta(),
  };

  const { data, error } = await supabase.from("documents").insert(insert).select("id").single();
  if (error) throw new Error(error.message);

  const { data: urlData, error: urlErr } = await supabase.storage
    .from("documents")
    .createSignedUrl(storagePath, 3600);
  if (urlErr) throw new Error(urlErr.message);

  return {
    id: data.id,
    file_name,
    file_size: buffer.byteLength,
    signed_url: urlData.signedUrl,
    message: `Binary document "${file_name}" uploaded successfully`,
  };
}

export const updateDocumentContentSchema = z.object({
  id: z.string().uuid().describe("Document UUID to overwrite"),
  content: z.string().describe("New text content"),
});

export async function updateDocumentContent(args: z.infer<typeof updateDocumentContentSchema>) {
  // Fetch existing record to get storage path
  const { data: doc, error: fetchErr } = await supabase
    .from("documents")
    .select("id, file_name, file_url")
    .eq("id", args.id)
    .eq("organization_id", ORG_ID!)
    .is("deleted_at", null)
    .maybeSingle();
  if (fetchErr) throw new Error(fetchErr.message);
  if (!doc) throw new Error("Document not found");

  const buffer = Buffer.from(args.content, "utf-8");

  // Overwrite the file in storage
  const { error: upErr } = await supabase.storage
    .from("documents")
    .update(doc.file_url, buffer, { upsert: true });
  if (upErr) throw new Error(upErr.message);

  // Update file_size in db
  const { error: dbErr } = await supabase
    .from("documents")
    .update({ file_size: buffer.byteLength })
    .eq("id", args.id);
  if (dbErr) throw new Error(dbErr.message);

  return { id: args.id, message: `Document "${doc.file_name}" content updated` };
}

export const updateDocumentSchema = z.object({
  id: z.string().uuid(),
  file_name: z.string().optional().describe("New file name"),
  description: z.string().optional().nullable().describe("New description"),
  folder_id: z.string().uuid().optional().nullable().describe("Move to folder UUID, or null for root"),
  entity_type: entityTypeEnum.optional().describe("Change the linked CRM entity type"),
  entity_id: z.string().uuid().optional().nullable().describe("UUID of the new linked entity"),
});

export async function updateDocument(args: z.infer<typeof updateDocumentSchema>) {
  const { id, entity_type, entity_id, ...rest } = args;
  const update: Record<string, unknown> = { ...rest };

  if (entity_type !== undefined) {
    update.contact_id = entity_type === "contact" ? entity_id : null;
    update.company_id = entity_type === "company" ? entity_id : null;
    update.deal_id = entity_type === "deal" ? entity_id : null;
    update.interaction_id = entity_type === "interaction" ? entity_id : null;
    update.calendar_event_id = entity_type === "calendar_event" ? entity_id : null;
    update.task_id = entity_type === "task" ? entity_id : null;
  }

  const { error } = await supabase.from("documents").update(update).eq("id", id).eq("organization_id", ORG_ID!);
  if (error) throw new Error(error.message);
  return { id, message: "Document updated successfully" };
}

export const deleteDocumentSchema = z.object({
  id: z.string().uuid().describe("Document UUID to delete"),
});

export async function deleteDocument(args: z.infer<typeof deleteDocumentSchema>) {
  const { error } = await supabase
    .from("documents")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", args.id)
    .eq("organization_id", ORG_ID!);
  if (error) throw new Error(error.message);
  return { id: args.id, message: "Document deleted" };
}
