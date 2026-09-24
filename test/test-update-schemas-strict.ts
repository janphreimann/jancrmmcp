// The zone rule (spec §2.1): Claude must not be able to write `brief` or
// the removed `ai_summary` through update_project. With .strict() an
// unknown key is a validation error instead of being silently dropped.
//
// projects.ts pulls in supabase.ts, which throws unless SUPABASE_* env vars
// are set — same reason test-mail-draft.ts loads dotenv before its imports.
import "dotenv/config";
import { updateProjectSchema } from "../src/tools/projects.js";
import { updateInitiativeSchema } from "../src/tools/initiatives.js";

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}`);
  if (!ok) failed++;
}

const id = "11111111-1111-4111-8111-111111111111";
check("update_project rejects brief", !updateProjectSchema.safeParse({ id, brief: "x" }).success);
check("update_project rejects ai_summary", !updateProjectSchema.safeParse({ id, ai_summary: "x" }).success);
check("update_project accepts stage", updateProjectSchema.safeParse({ id, stage: "Active" }).success);
check("update_project rejects deal-era stage", !updateProjectSchema.safeParse({ id, stage: "Identified" }).success);
check("update_initiative rejects unknown key", !updateInitiativeSchema.safeParse({ id, foo: 1 }).success);

if (failed) process.exit(1);
