// Snapshot + invariants for renderBriefing. Fixtures live in the CRM repo so
// the CRM's copy of the renderer (Plan B) tests against the same files.
// Regenerate the snapshot after an intentional change:
//   UPDATE_SNAPSHOT=1 npx tsx test/test-briefing-render.ts
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { renderBriefing, type Briefing } from "../src/briefing.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = resolve(here, "../../janreimanncrm/docs/superpowers/fixtures");
const NOW = new Date("2026-09-24T09:00:00Z");

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "✓" : "✗"}  ${name}${ok || !detail ? "" : "\n     " + detail}`);
  if (!ok) failed++;
}
function load(name: string): Briefing {
  return JSON.parse(readFileSync(resolve(fixtures, name), "utf8"));
}

// 1. rich fixture: snapshot
const rich = load("briefing-fixture.json");
const md = renderBriefing(rich, NOW);
const snapPath = resolve(fixtures, "briefing-fixture.md");
if (process.env.UPDATE_SNAPSHOT || !existsSync(snapPath)) {
  writeFileSync(snapPath, md);
  console.log("  (snapshot written — review it against spec §4.2, then commit)");
}
check("rich: matches snapshot", md === readFileSync(snapPath, "utf8"));

// 2. rich: delta capped at 30 lines + a "+5 more" line
const deltaSection = md.split("## Since your last visit")[1]?.split("## Open")[0] ?? "";
const deltaLines = deltaSection.split("\n").filter((l) => l.startsWith("- "));
check("rich: delta has 30 lines", deltaLines.length === 30, `got ${deltaLines.length}`);
check("rich: +5 more hint", /\+5 more \(/.test(deltaSection));

// 2b. rich: the parenthesized per-kind remainder in the "+N more" trailer
// sums to N (remaining counts, not full delta_counts totals).
const trailerMatch = deltaSection.match(/\+(\d+) more \(([^)]*)\)/);
check("rich: +N more trailer present", !!trailerMatch);
if (trailerMatch) {
  const n = Number(trailerMatch[1]);
  const parts = trailerMatch[2].split(", ").map((p) => Number(p.split(": ")[1]));
  const sum = parts.reduce((a, x) => a + x, 0);
  check("rich: trailer breakdown sums to +N", sum === n, `sum=${sum} n=${n} (${trailerMatch[2]})`);
}

// 3. rich: every ref points at an id in the fixture
const ids = new Set<string>();
const collect = (v: unknown) => {
  if (Array.isArray(v)) v.forEach(collect);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (k === "id" || k === "item_id") ids.add(String(x)); collect(x); }
};
collect(rich);
const refs = [...md.matchAll(/\[(?:journal|task|interaction|email|recording|event|document):([0-9a-f-]{36})\]/g)].map((m) => m[1]);
check("rich: refs present", refs.length > 0);
check("rich: all refs resolve", refs.every((r) => ids.has(r)), refs.filter((r) => !ids.has(r)).join(","));

// 4. rich: header facts
check("rich: initiative in header", md.includes("Part of: "));
check("rich: open proposal warning", md.includes("open brief proposal(s)"));
check("rich: basket counts", md.includes("Suggestion basket: 4 emails, 1 recordings"));

// 5. first visit
const first = renderBriefing(load("briefing-first-visit.json"), NOW);
check("first visit: header", first.includes("## First visit — everything below is new to you"));
check("first visit: no since line", !first.includes("## Since your last visit"));

// 6. empty project: placeholders, no empty headers
const empty = renderBriefing(load("briefing-empty.json"), NOW);
check("empty: status placeholder", empty.includes("You have not written a status yet"));
check("empty: brief placeholder", empty.includes("No brief yet."));
check("empty: nothing open", empty.includes("Nothing open."));
check("empty: no list headers", !/Documents \(|Interactions \(|Recordings \(|Events \(/.test(empty));
check("empty: journal line", empty.includes("Journal: 0 entries, 0 pinned"));

// 7. size
check("rich: under 12k chars", md.length < 12000, `${md.length}`);

// 8. index caps: recordings and events print "+N more" like documents/interactions
// do, once their _total exceeds the shown list (§4.2: every capped list prints one).
const capped: Briefing = JSON.parse(JSON.stringify(rich));
capped.index.recordings_total = capped.index.recordings.length + 3;
capped.index.events_total = capped.index.events.length + 2;
const cappedMd = renderBriefing(capped, NOW);
check("recordings: +N more hint", cappedMd.includes(`+3 more → list_project_timeline(project_id, kinds=["audio_recording"])`));
check("events: +N more hint", cappedMd.includes(`+2 more → list_project_timeline(project_id, kinds=["calendar_event"])`));

// 9. agent_session rows: Claude's own session log is printed in full, not
// clipped to 120 chars like every other preview — otherwise Claude cannot
// read back what it wrote last session. Everything else keeps its cap.
const sessions = rich.delta.filter((r) => r.kind === "journal" && r.meta["entry_type"] === "agent_session");
check("agent_session: fixture has session rows", sessions.length >= 2);
const longSession = sessions.find((r) => r.preview.length > 120 && r.preview.split(". ").length > 2);
check("agent_session: fixture has a multi-sentence paragraph > 120 chars", !!longSession);
for (const s of sessions) {
  const full = s.preview.replace(/\s+/g, " ").trim();
  check(`agent_session ${s.item_id.slice(-3)}: paragraph appears in full`, md.includes(`Claude session — ${full} [journal:${s.item_id}]`));
}
// …and an ordinary note with the same long preview is still clipped.
const noteLong: Briefing = JSON.parse(JSON.stringify(rich));
const asNote = noteLong.delta.find((r) => r.item_id === longSession?.item_id)!;
asNote.meta = { ...asNote.meta, entry_type: "note" };
const noteMd = renderBriefing(noteLong, NOW);
const noteLine = noteMd.split("\n").find((l) => l.includes(`[journal:${asNote.item_id}]`)) ?? "";
check("non-session preview still clipped at 120", !noteLine.includes(asNote.preview) && noteLine.includes("…"), noteLine);

if (failed) process.exit(1);
