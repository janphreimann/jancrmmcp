// Guards against the drift that broke search_projects/create_project once:
// the MCP server's stage list must equal the CRM frontend's. Reads the
// frontend file from disk (both repos live side by side).
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROJECT_STAGES } from "../src/constants.js";

const here = dirname(fileURLToPath(import.meta.url));
const frontendFile = resolve(here, "../../janreimanncrm/src/modules/projects/constants.ts");
const src = readFileSync(frontendFile, "utf8");

const m = src.match(/export const PROJECT_STAGES = \[([\s\S]*?)\] as const;/);
if (!m) {
  console.error("✗ could not find PROJECT_STAGES in", frontendFile);
  process.exit(1);
}
const frontendStages = [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);

const same =
  frontendStages.length === PROJECT_STAGES.length &&
  frontendStages.every((s, i) => s === PROJECT_STAGES[i]);

if (!same) {
  console.error("✗ PROJECT_STAGES drift\n  frontend:", frontendStages, "\n  mcp:     ", PROJECT_STAGES);
  process.exit(1);
}
console.log("  ✓  PROJECT_STAGES matches the CRM frontend");
