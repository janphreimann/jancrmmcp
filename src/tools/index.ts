import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Ctx } from "../context.js";
import {
  searchContactsSchema, searchContacts,
  getContactSchema, getContact,
  createContactSchema, createContact,
  updateContactSchema, updateContact,
} from "./contacts.js";
import {
  searchCompaniesSchema, searchCompanies,
  getCompanySchema, getCompany,
  createCompanySchema, createCompany,
  updateCompanySchema, updateCompany,
} from "./companies.js";
import {
  searchProjectsSchema, searchProjects,
  getProjectSchema, getProject,
  createProjectSchema, createProject,
  updateProjectSchema, updateProject,
} from "./projects.js";
import {
  createTaskSchema, createTask,
  searchTasksSchema, searchTasks,
  getTaskSchema, getTask,
  updateTaskSchema, updateTask,
} from "./tasks.js";
import { createCalendarEventSchema, createCalendarEvent } from "./calendar.js";
import { createEmailDraftSchema, createEmailDraft } from "./mail.js";
import {
  listTagsSchema, listTags,
  addTagToEntitySchema, addTagToEntity,
  getPipelineStatsSchema, getPipelineStats,
} from "./tags.js";
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
} from "./documents.js";

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

/**
 * Der Ctx kommt pro Anfrage aus dem Bearer-Token und trägt das
 * Supabase-Access-Token des Nutzers. Jedes Tool bekommt ihn als erstes
 * Argument — es gibt bewusst keinen Modul-Singleton mehr, an dem sich zwei
 * Nutzer treffen könnten.
 */
export function registerAllTools(server: McpServer, ctx: Ctx) {
  server.tool(
    "search_contacts",
    "Search contacts by name, email, company, or source — fuzzy, tolerates typos",
    searchContactsSchema.shape,
    async (args) => ok(await searchContacts(ctx, args as Parameters<typeof searchContacts>[1]))
  );

  server.tool(
    "get_contact",
    "Get full contact details including tags by UUID",
    getContactSchema.shape,
    async (args) => ok(await getContact(ctx, args as Parameters<typeof getContact>[1]))
  );

  server.tool(
    "create_contact",
    "Create a new contact in the CRM",
    createContactSchema.shape,
    async (args) => ok(await createContact(ctx, args as Parameters<typeof createContact>[1]))
  );

  server.tool(
    "update_contact",
    "Update an existing contact's fields",
    updateContactSchema.shape,
    async (args) => ok(await updateContact(ctx, args as Parameters<typeof updateContact>[1]))
  );

  server.tool(
    "search_companies",
    "Search companies by name — fuzzy, tolerates typos",
    searchCompaniesSchema.shape,
    async (args) => ok(await searchCompanies(ctx, args as Parameters<typeof searchCompanies>[1]))
  );

  server.tool(
    "get_company",
    "Get full company details including contacts and tags",
    getCompanySchema.shape,
    async (args) => ok(await getCompany(ctx, args as Parameters<typeof getCompany>[1]))
  );

  server.tool(
    "create_company",
    "Create a new company in the CRM",
    createCompanySchema.shape,
    async (args) => ok(await createCompany(ctx, args as Parameters<typeof createCompany>[1]))
  );

  server.tool(
    "update_company",
    "Update an existing company",
    updateCompanySchema.shape,
    async (args) => ok(await updateCompany(ctx, args as Parameters<typeof updateCompany>[1]))
  );

  server.tool(
    "search_projects",
    "Search projects by name, stage, project type, or linked contact — fuzzy, tolerates typos",
    searchProjectsSchema.shape,
    async (args) => ok(await searchProjects(ctx, args as Parameters<typeof searchProjects>[1]))
  );

  server.tool(
    "get_project",
    "Get full project details by UUID, including linked contacts, companies and tags",
    getProjectSchema.shape,
    async (args) => ok(await getProject(ctx, args as Parameters<typeof getProject>[1]))
  );

  server.tool(
    "create_project",
    "Create a new project with optional linked contacts and companies",
    createProjectSchema.shape,
    async (args) => ok(await createProject(ctx, args as Parameters<typeof createProject>[1]))
  );

  server.tool(
    "update_project",
    "Update a project — stage, description, volumes, dates",
    updateProjectSchema.shape,
    async (args) => ok(await updateProject(ctx, args as Parameters<typeof updateProject>[1]))
  );

  server.tool(
    "create_task",
    "Create a task optionally linked to a contact, company, or project",
    createTaskSchema.shape,
    async (args) => ok(await createTask(ctx, args as Parameters<typeof createTask>[1]))
  );

  server.tool(
    "search_tasks",
    "Search tasks by title, status, priority, due date range, or linked contact/company/project",
    searchTasksSchema.shape,
    async (args) => ok(await searchTasks(ctx, args as Parameters<typeof searchTasks>[1]))
  );

  server.tool(
    "get_task",
    "Get full task details by UUID",
    getTaskSchema.shape,
    async (args) => ok(await getTask(ctx, args as Parameters<typeof getTask>[1]))
  );

  server.tool(
    "update_task",
    "Update a task — title, description, due date, priority, status, or links. Use this to mark a task done (status: Completed).",
    updateTaskSchema.shape,
    async (args) => ok(await updateTask(ctx, args as Parameters<typeof updateTask>[1]))
  );

  server.tool(
    "create_calendar_event",
    "Create a calendar event (appointment) in the user's CalDAV calendar. Use this — not create_task — when the user asks for a 'Termin' or appointment. Times must be ISO 8601 with timezone offset.",
    createCalendarEventSchema.shape,
    async (args) => ok(await createCalendarEvent(ctx, args as Parameters<typeof createCalendarEvent>[1]))
  );

  server.tool(
    "create_email_draft",
    "Save an email draft to the Drafts folder via IMAP. To, CC, subject and body are all optional — useful for pre-filling a draft the user will finish later.",
    createEmailDraftSchema.shape,
    async (args) => ok(await createEmailDraft(ctx, args as Parameters<typeof createEmailDraft>[1]))
  );

  server.tool(
    "list_tags",
    "List all available tags in the organization",
    listTagsSchema.shape,
    async () => ok(await listTags(ctx))
  );

  server.tool(
    "add_tag_to_entity",
    "Add a tag to a contact, company, or project",
    addTagToEntitySchema.shape,
    async (args) => ok(await addTagToEntity(ctx, args as Parameters<typeof addTagToEntity>[1]))
  );

  server.tool(
    "get_pipeline_stats",
    "Get pipeline statistics: project counts by stage, total contacts, companies, open tasks",
    getPipelineStatsSchema.shape,
    async () => ok(await getPipelineStats(ctx))
  );

  // ─── Documents ───────────────────────────────────────────────────────────

  server.tool(
    "list_folders",
    "List all document folders (flat list with parent_folder_id for hierarchy)",
    listFoldersSchema.shape,
    async () => ok(await listFolders(ctx))
  );

  server.tool(
    "create_folder",
    "Create a new document folder. Optionally nest it under a parent folder.",
    createFolderSchema.shape,
    async (args) => ok(await createFolder(ctx, args as Parameters<typeof createFolder>[1]))
  );

  server.tool(
    "rename_folder",
    "Rename an existing document folder",
    renameFolderSchema.shape,
    async (args) => ok(await renameFolder(ctx, args as Parameters<typeof renameFolder>[1]))
  );

  server.tool(
    "list_documents",
    "List documents with optional folder filter and text search. Omit folder_id to get all, pass null to get root-level only.",
    listDocumentsSchema.shape,
    async (args) => ok(await listDocuments(ctx, args as Parameters<typeof listDocuments>[1]))
  );

  server.tool(
    "get_document_content",
    "Get a document's metadata and text content (for .md, .txt, .csv, .json, etc.). Returns a signed download URL for all file types.",
    getDocumentContentSchema.shape,
    async (args) => ok(await getDocumentContent(ctx, args as Parameters<typeof getDocumentContent>[1]))
  );

  server.tool(
    "create_text_document",
    "Create a new text document (markdown, txt, csv, json, …) and upload it to the CRM. Optionally place it in a folder and link it to a CRM entity.",
    createTextDocumentSchema.shape,
    async (args) => ok(await createTextDocument(ctx, args as Parameters<typeof createTextDocument>[1]))
  );

  server.tool(
    "upload_binary_document",
    "Upload a binary file (PDF, PPTX, XLSX, image, etc.) to the CRM as a Base64-encoded payload. Optionally place it in a folder and link it to a CRM entity. Returns the document ID and a signed download URL.",
    uploadBinaryDocumentSchema.shape,
    async (args) => ok(await uploadBinaryDocument(ctx, args as Parameters<typeof uploadBinaryDocument>[1]))
  );

  server.tool(
    "update_document_content",
    "Overwrite the text content of an existing document in-place",
    updateDocumentContentSchema.shape,
    async (args) => ok(await updateDocumentContent(ctx, args as Parameters<typeof updateDocumentContent>[1]))
  );

  server.tool(
    "update_document",
    "Update a document's metadata: rename, change description, move to a different folder, or re-link to a CRM entity",
    updateDocumentSchema.shape,
    async (args) => ok(await updateDocument(ctx, args as Parameters<typeof updateDocument>[1]))
  );

  server.tool(
    "delete_document",
    "Soft-delete a document (moves it to trash, recoverable from the CRM UI)",
    deleteDocumentSchema.shape,
    async (args) => ok(await deleteDocument(ctx, args as Parameters<typeof deleteDocument>[1]))
  );
}
