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
  searchInitiativesSchema, searchInitiatives,
  getInitiativeSchema, getInitiative,
  createInitiativeSchema, createInitiative,
  updateInitiativeSchema, updateInitiative,
  suggestNextStepSchema, suggestNextStep,
} from "./initiatives.js";
import {
  createTaskSchema, createTask,
  searchTasksSchema, searchTasks,
  getTaskSchema, getTask,
  updateTaskSchema, updateTask,
} from "./tasks.js";
import { createCalendarEventSchema, createCalendarEvent } from "./calendar.js";
import {
  createEmailDraftSchema, createEmailDraft,
  listEmailsSchema, listEmails,
  getEmailSchema, getEmail,
} from "./mail.js";
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
import {
  listNoteFoldersSchema, listNoteFolders,
  searchNotesSchema, searchNotes,
  getNoteSchema, getNote,
  createNoteSchema, createNote,
  updateNoteSchema, updateNote,
} from "./notes.js";
import {
  updateAudioRecordingTranscriptSchema, updateAudioRecordingTranscript,
  searchAudioRecordingsSchema, searchAudioRecordings,
  getAudioRecordingSchema, getAudioRecording,
} from "./audioRecordings.js";
import {
  updateAgentProfileSchema, updateAgentProfile, rememberSchema, remember,
  rememberAboutUserSchema, rememberAboutUser,
} from "./selfManagement.js";
import { readChatHistorySchema, readChatHistory } from "./chatHistory.js";
import {
  getOverviewSchema, getOverview,
  createAgentSchema, createAgent, updateAgentSchema, updateAgent,
  pauseAgentSchema, pauseAgent, deleteAgentSchema, deleteAgent,
  delegateSchema, delegate,
  createStandingOrderSchema, createStandingOrder, updateStandingOrderSchema, updateStandingOrder,
  createProposalSchema, createProposal, updateProposalStatusSchema, updateProposalStatus,
} from "./chief.js";
import {
  scheduleRoutineSchema, scheduleRoutine,
  updateRoutineSchema, updateRoutine,
  cancelRoutineSchema, cancelRoutine,
} from "./routines.js";
import { openProjectSchema, openProject } from "./openProject.js";
import {
  updateAgentStatusSchema, updateAgentStatus,
  rememberForProjectSchema, rememberForProject,
  addTimelineEntrySchema, addTimelineEntry,
  proposeDescriptionSchema, proposeDescription,
  linkProjectItemSchema, linkProjectItem,
  listProjectTimelineSchema, listProjectTimeline,
} from "./projectRoom.js";
import { getInteractionSchema, getInteraction, listInteractionsObject, listInteractions } from "./interactions.js";

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

function text(result: string) {
  return { content: [{ type: "text" as const, text: result }] };
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

  // ─── Project data room ───────────────────────────────────────────────────

  server.tool(
    "open_project",
    "Open a project and get its briefing: current state (your status note and the human's project description, each with a date), what the user has told any agent about this project before (Memory), everything that happened since you last opened it, what is open, and an index of every document, interaction, recording, event and pinned note with ids you can pass to the drill-down tools. Call this first whenever a request concerns a project. Whenever the user tells you something that should still hold next time — a constraint, a preference, a decision, a correction of something you got wrong — save it in the same turn, without being asked: remember_for_project for this project, remember_about_user for what holds beyond it. If the user tells you about something that happened in the project (a meeting, a call, a decision), add it with add_timeline_entry. Before you finish working on the project: call update_agent_status if the state changed — that is how your next visit knows where you left off. The timeline is the project's history, not your log: never write your own work into it.",
    openProjectSchema.shape,
    async (args) => text(await openProject(ctx, args as Parameters<typeof openProject>[1]))
  );

  server.tool(
    "update_agent_status",
    "Your own status note for a project (3–8 sentences: where it stands, what happened last, what is next or blocking). Replaces the previous one. No headings. Write it at the end of a session in which the state changed. Before you write it, go through the project's Memory in the briefing: if anything there is outdated, done or contradicted by what you just read, fix it with remember_for_project first.",
    updateAgentStatusSchema.shape,
    async (args) => ok(await updateAgentStatus(ctx, args as Parameters<typeof updateAgentStatus>[1]))
  );

  server.tool(
    "remember_about_user",
    "Memory about the user that holds beyond one project — how they work, rules they gave you, preferences, corrections of your mistakes (\"I only make an offer once the client has said what they want\"). Examples: how they want to be addressed (\"Herr Bauer\"), a rule for how they work, a preference. Every agent gets it: in this server's instructions at connection start and in every in-app chat; the user edits it in Settings. Check after every user message whether it contains something like that, and if so save it right away, in the same turn, without being asked and without announcing it. Full replacement, not an append: start from the current text (the server instructions; the result also returns the previous text), keep what still holds, drop what is outdated. Something that concerns only one project goes to remember_for_project instead.",
    rememberAboutUserSchema.shape,
    async (args) => ok(await rememberAboutUser(ctx, args as Parameters<typeof rememberAboutUser>[1]))
  );

  server.tool(
    "remember_for_project",
    "The project's memory: what the user told you about this project that should still hold next time (constraints, preferences, decisions, corrections of your mistakes). Every agent that opens the project sees it under Memory at the top of the briefing. Check after every user message whether it contains something like that, and if so save it right away, in the same turn, without being asked and without announcing it — don't wait for \"remember this\". Full replacement, not an append: start from the current text, keep what still holds, drop what is outdated, don't duplicate. Something that holds for the user beyond this project goes to remember_about_user instead. Not for the project's state — that is update_agent_status.",
    rememberForProjectSchema.shape,
    async (args) => ok(await rememberForProject(ctx, args as Parameters<typeof rememberForProject>[1]))
  );

  server.tool(
    "add_timeline_entry",
    "Add an event to the project's timeline — the short history of what happened in the project, read by the people on it. Use it only when the user tells you about something that happened in the project and the CRM doesn't already hold it: \"I met Amelie yesterday, we talked about X\", \"Monica decided to drop the dashboard\", \"the offer went out today\". One event, one entry; check the timeline in the briefing first so you don't add it twice. Never use it for what you did, what you plan, what you couldn't do, or for an instruction the user gave you — where the project stands goes to update_agent_status, what the user wants you to keep in mind to remember_for_project. A mail, recording or calendar event is already in the timeline once linked (link_project_item); don't retell it.",
    addTimelineEntrySchema.shape,
    async (args) => ok(await addTimelineEntry(ctx, args as Parameters<typeof addTimelineEntry>[1]))
  );

  server.tool(
    "propose_description",
    "Propose a new version of the human-owned project description (full replacement text, markdown). The user sees a diff and applies or rejects it. You cannot edit the description directly. Only one proposal can be open per project.",
    proposeDescriptionSchema.shape,
    async (args) => ok(await proposeDescription(ctx, args as Parameters<typeof proposeDescription>[1]))
  );

  server.tool(
    "link_project_item",
    "Attach an email, a recording (by recording_group_id) or a calendar event to a project so it becomes part of the project's data room. Only attach things that clearly belong; the user can undo. Shown with an Agent badge until approved.",
    linkProjectItemSchema.shape,
    async (args) => ok(await linkProjectItem(ctx, args as Parameters<typeof linkProjectItem>[1]))
  );

  server.tool(
    "list_project_timeline",
    "Page through a project's unified timeline (journal, tasks, interactions, linked mail/recordings/events, documents), newest first. Use `before` from a previous call's next_before to go further back; `kinds` to filter.",
    listProjectTimelineSchema.shape,
    async (args) => text(await listProjectTimeline(ctx, args as Parameters<typeof listProjectTimeline>[1]))
  );

  server.tool(
    "get_interaction",
    "Full details of one logged interaction (call, meeting, …): content, next steps, internal notes, contacts, companies, linked tasks and documents",
    getInteractionSchema.shape,
    async (args) => ok(await getInteraction(ctx, args as Parameters<typeof getInteraction>[1]))
  );

  server.tool(
    "list_interactions",
    "Compact list of logged interactions for a project, contact or company (at least one filter required), newest first",
    listInteractionsObject.shape,
    async (args) => ok(await listInteractions(ctx, args))
  );

  server.tool(
    "search_projects",
    "Search projects by name (fuzzy), stage, initiative or linked contact. For orientation on one project use open_project.",
    searchProjectsSchema.shape,
    async (args) => ok(await searchProjects(ctx, args as Parameters<typeof searchProjects>[1]))
  );

  server.tool(
    "get_project",
    "Raw project record with linked contacts, companies, tags and initiative. For orientation use open_project — it returns the state, what changed, what is open and an index.",
    getProjectSchema.shape,
    async (args) => ok(await getProject(ctx, args as Parameters<typeof getProject>[1]))
  );

  server.tool(
    "create_project",
    "Create a new project with optional linked contacts, companies and initiative",
    createProjectSchema.shape,
    async (args) => ok(await createProject(ctx, args as Parameters<typeof createProject>[1]))
  );

  // registerTool with the full object schema, not server.tool(…, .shape): the
  // shape form makes the SDK rebuild a plain z.object(shape), which strips
  // unknown keys — .strict() would be lost and `description` silently dropped.
  server.registerTool(
    "update_project",
    {
      description:
        "Update a project's fields — name, stage, budget, dates, initiative. For the status note use update_agent_status; for the description use propose_description.",
      inputSchema: updateProjectSchema,
    },
    async (args) => ok(await updateProject(ctx, args as Parameters<typeof updateProject>[1]))
  );

  server.tool(
    "search_initiatives",
    "List or search initiatives (groups of projects) by name and status",
    searchInitiativesSchema.shape,
    async (args) => ok(await searchInitiatives(ctx, args as Parameters<typeof searchInitiatives>[1]))
  );

  server.tool(
    "get_initiative",
    "Get an initiative with its description and the projects in it",
    getInitiativeSchema.shape,
    async (args) => ok(await getInitiative(ctx, args as Parameters<typeof getInitiative>[1]))
  );

  server.tool(
    "create_initiative",
    "Create an initiative — a named group of projects with a description of what success looks like",
    createInitiativeSchema.shape,
    async (args) => ok(await createInitiative(ctx, args as Parameters<typeof createInitiative>[1]))
  );

  // Same as update_project: the full schema keeps .strict() alive.
  server.registerTool(
    "update_initiative",
    {
      description: "Update an initiative's name, description, status or target date",
      inputSchema: updateInitiativeSchema,
    },
    async (args) => ok(await updateInitiative(ctx, args as Parameters<typeof updateInitiative>[1]))
  );

  server.tool(
    "suggest_next_step",
    "Suggest a concrete, actionable next step for a project. The user reviews it in the CRM and turns it into a task or dismisses it. Check the briefing's suggested next steps first so you don't repeat one.",
    suggestNextStepSchema.shape,
    async (args) => ok(await suggestNextStep(ctx, args as Parameters<typeof suggestNextStep>[1]))
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
    "list_emails",
    "List/search recent emails from the user's mailbox — compact results (subject, sender, preview, read status), not full bodies. Use get_email to fetch a full message.",
    listEmailsSchema.shape,
    async (args) => ok(await listEmails(ctx, args as Parameters<typeof listEmails>[1]))
  );

  server.tool(
    "get_email",
    "Get one email's full content by UUID: body, all recipients, and attachment list",
    getEmailSchema.shape,
    async (args) => ok(await getEmail(ctx, args as Parameters<typeof getEmail>[1]))
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
    "List documents with optional filters (folder, doc_type, linked contact/company/project) and text search. Omit folder_id to get all, pass null to get root-level only. Use doc_type: 'transcript' to find project meeting transcripts and their auto-generated summaries.",
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
    "Upload a binary file (PDF, PPTX, XLSX, image, etc.) to the CRM as a Base64-encoded payload. Optionally place it in a folder and link it to a CRM entity. Returns the document ID.",
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
    "update_audio_recording_transcript",
    "Overwrite an audio recording's cleaned transcript segments (used by the Transcript Cleanup agent only — never call this to change what was actually said, only to remove filler words/disfluencies)",
    updateAudioRecordingTranscriptSchema.shape,
    async (args) => ok(await updateAudioRecordingTranscript(ctx, args as Parameters<typeof updateAudioRecordingTranscript>[1]))
  );

  server.tool(
    "search_audio_recordings",
    "Search call/meeting recording sessions by linked contact, linked company, or a text substring in the title/transcript/summary. Returns transcript summaries and a short transcript snippet per session — never the audio file itself. Use get_audio_recording on a result's recording_group_id for the full transcript.",
    searchAudioRecordingsSchema.shape,
    async (args) => ok(await searchAudioRecordings(ctx, args as Parameters<typeof searchAudioRecordings>[1]))
  );

  server.tool(
    "get_audio_recording",
    "Get the transcript (one line per speaker turn, \"Name: text\"), summary, speakers and linked contacts/companies of one call/meeting recording session. Long transcripts come in pages: while has_more is true, call again with offset = next_offset. Read every page before you summarize or quote — a summary built from the first page alone misses the rest of the meeting. Never returns the audio file itself.",
    getAudioRecordingSchema.shape,
    async (args) => ok(await getAudioRecording(ctx, args as Parameters<typeof getAudioRecording>[1]))
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

  // ─── Notes ───────────────────────────────────────────────────────────────

  server.tool(
    "list_note_folders",
    "List the folders of the Notes library (flat list with parent_folder_id for hierarchy). Separate from document folders.",
    listNoteFoldersSchema.shape,
    async () => ok(await listNoteFolders(ctx))
  );

  server.tool(
    "search_notes",
    "Search notes in the Notes library by text, folder, tag, pinned state, or linked contact/company/project. Returns a preview; read the full note with get_note.",
    searchNotesSchema.shape,
    async (args) => ok(await searchNotes(ctx, args as Parameters<typeof searchNotes>[1]))
  );

  server.tool(
    "get_note",
    "Full note: markdown content, folder, pinned state, tags and linked contacts, companies and projects",
    getNoteSchema.shape,
    async (args) => ok(await getNote(ctx, args as Parameters<typeof getNote>[1]))
  );

  // registerTool with the full schema so .strict() survives (see update_project).
  server.registerTool(
    "create_note",
    {
      description: "Create a note in the Notes library (markdown). File it into a note folder (list_note_folders), tag it (list_tags) and link the contacts, companies and projects it is about — all in one call. For files or long documents use create_text_document instead.",
      inputSchema: createNoteSchema,
    },
    async (args) => ok(await createNote(ctx, args as Parameters<typeof createNote>[1]))
  );

  server.registerTool(
    "update_note",
    {
      description: "Edit a note: title, content (replaces the whole body), folder, pinned, and add (link) or remove (unlink) tags, contacts, companies and projects. Links you don't name stay as they are.",
      inputSchema: updateNoteSchema,
    },
    async (args) => ok(await updateNote(ctx, args as Parameters<typeof updateNote>[1]))
  );

  // ─── Self-management ─────────────────────────────────────────────────────

  server.tool(
    "update_agent_profile",
    "Rename yourself, change your color, or set your one-line description — do this once you understand what the user wants you to be.",
    updateAgentProfileSchema.shape,
    async (args) => ok(await updateAgentProfile(ctx, args as Parameters<typeof updateAgentProfile>[1]))
  );

  server.tool(
    "remember",
    "Overwrite your own memory document — the durable summary of your job and the working patterns you've learned for it, re-read on every message. Only you see it: anything the user tells you about themselves goes to remember_about_user, anything about one project to remember_for_project.",
    rememberSchema.shape,
    async (args) => ok(await remember(ctx, args as Parameters<typeof remember>[1]))
  );

  server.tool(
    "read_chat_history",
    "Page back through or search your own chat thread beyond the recent messages in your context window. Use it whenever something refers to earlier conversation you can't see, instead of guessing.",
    readChatHistorySchema.shape,
    async (args) => ok(await readChatHistory(ctx, args as Parameters<typeof readChatHistory>[1]))
  );

  server.tool(
    "get_overview",
    "The big picture: every agent you can see (job, routines, last run, paused), the runs of the last 48 hours, the projects with the most recent activity (with their status note) and the open/overdue task counts. Call it whenever a question is about what is going on overall, or before handing work to another agent.",
    getOverviewSchema.shape,
    async (args) => ok(await getOverview(ctx, args as Parameters<typeof getOverview>[1]))
  );

  // registerTool with the full object schema keeps .strict() (see update_project).
  server.registerTool(
    "delegate",
    { description: "Hand a task to another agent and get the result back: it runs as a new turn in that agent's thread, and its final reply comes back to you as a message \"Result from …\". Returns at once. Use agent ids from get_overview. Only the Chief delegates on its own; other agents only while working on a task delegated to them. A system agent's thread and runs are visible to the whole organization, so never put the user's private mail content or personal details into a task for a system agent — use one of the user's own agents for that. For notes that need no reply, use send_agent_message.", inputSchema: delegateSchema },
    async (args) => ok(await delegate(ctx, args as Parameters<typeof delegate>[1]))
  );
  server.registerTool(
    "create_agent",
    { description: "Chief only: create a helper agent with a fixed job. Set temporary=true for a one-off job — it is removed automatically (default after 48 hours). Tools: CRM tools only; omit to give it your own CRM tools.", inputSchema: createAgentSchema },
    async (args) => ok(await createAgent(ctx, args as Parameters<typeof createAgent>[1]))
  );
  server.registerTool(
    "update_agent",
    { description: "Chief only: rename one of the user's agents, or change job, tools or expiry of an agent you created. System agents cannot be changed.", inputSchema: updateAgentSchema },
    async (args) => ok(await updateAgent(ctx, args as Parameters<typeof updateAgent>[1]))
  );
  server.registerTool(
    "pause_agent",
    { description: "Chief only: pause or resume one of the user's agents. A paused agent runs no routines and takes no delegated tasks.", inputSchema: pauseAgentSchema },
    async (args) => ok(await pauseAgent(ctx, args as Parameters<typeof pauseAgent>[1]))
  );
  server.registerTool(
    "delete_agent",
    { description: "Chief only: remove an agent you created (soft delete — restorable). Agents the user built and system agents cannot be deleted by you.", inputSchema: deleteAgentSchema },
    async (args) => ok(await deleteAgent(ctx, args as Parameters<typeof deleteAgent>[1]))
  );
  server.registerTool(
    "create_standing_order",
    { description: "Chief only: save something the user wants you to keep watching (\"whenever …\"). The desktop app then wakes you in batches when something changes that may concern it (at most 40 autonomous turns a day). Instruction in the user's words; project_id when it concerns one project.", inputSchema: createStandingOrderSchema },
    async (args) => ok(await createStandingOrder(ctx, args as Parameters<typeof createStandingOrder>[1]))
  );
  server.registerTool(
    "update_standing_order",
    { description: "Chief only: change a standing order's instruction or project, or switch it off (enabled=false) / on again.", inputSchema: updateStandingOrderSchema },
    async (args) => ok(await updateStandingOrder(ctx, args as Parameters<typeof updateStandingOrder>[1]))
  );
  server.registerTool(
    "create_proposal",
    { description: "Chief only: propose a step to the user (a card with Accept / Reject in the app). Say exactly what you will do if accepted. Never carry it out yourself before you get the message that the user accepted it.", inputSchema: createProposalSchema },
    async (args) => ok(await createProposal(ctx, args as Parameters<typeof createProposal>[1]))
  );
  server.registerTool(
    "update_proposal_status",
    { description: "Chief only: mark an accepted proposal done once you have carried it out, with a one-line outcome. Accepting and rejecting are the user's — there is no way to do that from here.", inputSchema: updateProposalStatusSchema },
    async (args) => ok(await updateProposalStatus(ctx, args as Parameters<typeof updateProposalStatus>[1]))
  );

  // ─── Routines ────────────────────────────────────────────────────────────

  server.tool(
    "schedule_routine",
    "Set up a recurring task for yourself — either every N minutes or at a fixed daily time. Fires even when nobody is chatting with you.",
    scheduleRoutineSchema.shape,
    async (args) => ok(await scheduleRoutine(ctx, args as Parameters<typeof scheduleRoutine>[1]))
  );

  server.tool(
    "update_routine",
    "Change or pause (enabled: false) one of your existing routines.",
    updateRoutineSchema.shape,
    async (args) => ok(await updateRoutine(ctx, args as Parameters<typeof updateRoutine>[1]))
  );

  server.tool(
    "cancel_routine",
    "Permanently delete one of your own routines.",
    cancelRoutineSchema.shape,
    async (args) => ok(await cancelRoutine(ctx, args as Parameters<typeof cancelRoutine>[1]))
  );
}
