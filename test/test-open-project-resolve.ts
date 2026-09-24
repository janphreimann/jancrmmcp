import { resolveProjectQuery } from "../src/tools/openProject.js";
import { isNotFoundError } from "../src/tools/dbErrors.js";

let failed = 0;
function check(name: string, ok: boolean) { console.log(`  ${ok ? "✓" : "✗"}  ${name}`); if (!ok) failed++; }

const hit = (id: string, match_score: number) => ({ id, name: id, match_score });

check("none", resolveProjectQuery([]).kind === "none");
check("single hit opens", resolveProjectQuery([hit("a", 0.3)]).kind === "one");
check("clear winner opens", resolveProjectQuery([hit("a", 0.9), hit("b", 0.4)]).kind === "one");
check("clear winner id", (resolveProjectQuery([hit("a", 0.9), hit("b", 0.4)]) as { id: string }).id === "a");
check("two close scores → many", resolveProjectQuery([hit("a", 0.7), hit("b", 0.6)]).kind === "many");
check("weak top → many", resolveProjectQuery([hit("a", 0.5), hit("b", 0.1)]).kind === "many");
check("gap exactly 0.25 → many (boundary is exclusive)", resolveProjectQuery([hit("a", 0.75), hit("b", 0.5)]).kind === "many");

check("42501 is not-found", isNotFoundError({ code: "42501" }) === true);
check("23503 is not-found", isNotFoundError({ code: "23503" }) === true);
check("P0001 is not-found", isNotFoundError({ code: "P0001" }) === true);
check("08006 is not not-found", isNotFoundError({ code: "08006" }) === false);
check("undefined code is not not-found", isNotFoundError({}) === false);

if (failed) process.exit(1);
