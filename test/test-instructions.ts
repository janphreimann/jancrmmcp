// The user's standing rules reach every client through the initialize
// result's instructions — only there, so only initialize pays the query.
import { renderInstructions, isInitialize } from "../src/instructions.js";

let failed = 0;
function check(name: string, ok: boolean) {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}`);
  if (!ok) failed++;
}

check("memory is in the instructions", renderInstructions("- Address me as Herr Bauer.").includes("- Address me as Herr Bauer."));
check("empty memory says so", renderInstructions("  ").includes("nothing saved yet"));
check("instructions tell the agent to save", renderInstructions("").includes("remember_about_user"));
check("initialize is recognized", isInitialize({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
check("initialize inside a batch is recognized", isInitialize([{ method: "notifications/initialized" }, { method: "initialize" }]));
check("tools/call is not initialize", !isInitialize({ method: "tools/call" }));
check("no body is not initialize", !isInitialize(undefined));

if (failed) { console.log(`\n${failed} failed`); process.exit(1); }
