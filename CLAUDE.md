# crm-mcp-server

MCP server exposing CRM tools (contacts, companies, deals, tasks, documents,
folders) to AI agents (Claude, claude.ai connector) backed by the same
Supabase project as the main CRM webapp (`../Jan CRM`).

Interactions are intentionally **not** creatable via this server — logging a
call/meeting/email as an interaction is a user-only action in the CRM UI.
Do not add a `create_interaction` tool back without explicit sign-off.

## Agent-provenance rule (always apply, no exceptions)

Every row this server inserts into a user-facing CRM table must be
distinguishable from a human-created row in the CRM UI, and requires human
approval before it's treated as fully trusted data.

This is implemented with two columns, present on every entity table
(`contacts`, `companies`, `deals`, `tasks`, `interactions`, `documents`,
`document_folders`):

- `created_by_agent boolean not null default false`
- `agent_approved boolean not null default false`

**Any new create-tool you add must spread `agentMeta()` (from `src/supabase.ts`)
into its insert payload:**

```ts
import { supabase, ORG_ID, agentMeta } from "../supabase.js";

const { data, error } = await supabase
  .from("some_table")
  .insert({ ...fields, organization_id: ORG_ID, ...agentMeta() })
  .select("id")
  .single();
```

If the new tool targets a table that doesn't have these two columns yet, add
them in a migration on the CRM webapp side (`../Jan CRM/supabase/migrations`)
before wiring up the tool — do not skip the flag because a table is new.

The CRM frontend renders an "Agent" badge with an Approve button
(`src/components/shared/AgentBadge.tsx` in `../Jan CRM`) for any row where
`created_by_agent = true` and `agent_approved = false`. Once a human clicks
Approve, `agent_approved` flips to `true` and the badge disappears
permanently — approval is a one-way switch, there's no "unapprove".

Update-tools (`update_contact`, `update_deal`, etc.) do not touch these
columns — they only matter at creation time.
