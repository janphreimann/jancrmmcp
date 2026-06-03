import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
  searchDealsSchema, searchDeals,
  createDealSchema, createDeal,
  updateDealSchema, updateDeal,
} from "./deals.js";
import { createTaskSchema, createTask } from "./tasks.js";
import { createInteractionSchema, createInteraction } from "./interactions.js";
import {
  listTagsSchema, listTags,
  addTagToEntitySchema, addTagToEntity,
  getPipelineStatsSchema, getPipelineStats,
} from "./tags.js";

function ok(result: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
}

export function registerAllTools(server: McpServer) {
  server.tool(
    "search_contacts",
    "Search contacts by name, email, company, source, or do-not-contact flag",
    searchContactsSchema.shape,
    async (args) => ok(await searchContacts(args as Parameters<typeof searchContacts>[0]))
  );

  server.tool(
    "get_contact",
    "Get full contact details including tags by UUID",
    getContactSchema.shape,
    async (args) => ok(await getContact(args as Parameters<typeof getContact>[0]))
  );

  server.tool(
    "create_contact",
    "Create a new contact in the CRM",
    createContactSchema.shape,
    async (args) => ok(await createContact(args as Parameters<typeof createContact>[0]))
  );

  server.tool(
    "update_contact",
    "Update an existing contact's fields",
    updateContactSchema.shape,
    async (args) => ok(await updateContact(args as Parameters<typeof updateContact>[0]))
  );

  server.tool(
    "search_companies",
    "Search companies by name, industry, or source",
    searchCompaniesSchema.shape,
    async (args) => ok(await searchCompanies(args as Parameters<typeof searchCompanies>[0]))
  );

  server.tool(
    "get_company",
    "Get full company details including contacts and tags",
    getCompanySchema.shape,
    async (args) => ok(await getCompany(args as Parameters<typeof getCompany>[0]))
  );

  server.tool(
    "create_company",
    "Create a new company in the CRM",
    createCompanySchema.shape,
    async (args) => ok(await createCompany(args as Parameters<typeof createCompany>[0]))
  );

  server.tool(
    "update_company",
    "Update an existing company",
    updateCompanySchema.shape,
    async (args) => ok(await updateCompany(args as Parameters<typeof updateCompany>[0]))
  );

  server.tool(
    "search_deals",
    "Search deals by name, stage, deal type, or linked contact",
    searchDealsSchema.shape,
    async (args) => ok(await searchDeals(args as Parameters<typeof searchDeals>[0]))
  );

  server.tool(
    "create_deal",
    "Create a new deal with optional linked contacts and companies",
    createDealSchema.shape,
    async (args) => ok(await createDeal(args as Parameters<typeof createDeal>[0]))
  );

  server.tool(
    "update_deal",
    "Update a deal — stage, priority, description, volumes, dates",
    updateDealSchema.shape,
    async (args) => ok(await updateDeal(args as Parameters<typeof updateDeal>[0]))
  );

  server.tool(
    "create_task",
    "Create a task optionally linked to a contact, company, or deal",
    createTaskSchema.shape,
    async (args) => ok(await createTask(args as Parameters<typeof createTask>[0]))
  );

  server.tool(
    "create_interaction",
    "Log an interaction (call, meeting, email) linked to contacts, companies, or deals. Supports internal_notes and sentiment.",
    createInteractionSchema.shape,
    async (args) => ok(await createInteraction(args as Parameters<typeof createInteraction>[0]))
  );

  server.tool(
    "list_tags",
    "List all available tags in the organization",
    listTagsSchema.shape,
    async () => ok(await listTags())
  );

  server.tool(
    "add_tag_to_entity",
    "Add a tag to a contact, company, or deal",
    addTagToEntitySchema.shape,
    async (args) => ok(await addTagToEntity(args as Parameters<typeof addTagToEntity>[0]))
  );

  server.tool(
    "get_pipeline_stats",
    "Get pipeline statistics: deal counts by stage, total contacts, companies, open tasks",
    getPipelineStatsSchema.shape,
    async () => ok(await getPipelineStats())
  );
}
