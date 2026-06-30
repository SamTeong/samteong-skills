// improve-insights: audit the show-insights pipeline end-to-end (capture -> schema ->
// aggregation -> visualization) and emit a prioritized improvement roadmap.
// Read-only, stdlib only. Imports show-insights' stats.mjs as the data layer.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const SKILL_STATE_DIR = path.join(HOME, ".agents", ".show-insights", "state");
const SESSIONS_JSONL = path.join(SKILL_STATE_DIR, "sessions.jsonl");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);

// ---- fs helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function _sibling_skill(name, file) {
  // Resolve a sibling skill's script path without hardcoding the install root.
  const anchor = path.join(path.dirname(SKILL_DIR), name, "scripts", file);
  const cands = [
    anchor,
    path.join(HOME, ".agents", "skills", name, "scripts", file),
    path.join(HOME, ".claude", "skills", name, "scripts", file),
  ];
  for (const cand of cands) {
    if (isFile(cand)) return cand;
  }
  return anchor;
}

const STATS_MJS = _sibling_skill("show-insights", "stats.mjs");

async function _load_stats_module() {
  // Import show-insights' stats.mjs so we reuse its single-pass CSV loader (DRY).
  if (!isFile(STATS_MJS)) return null;
  try {
    return await import(pathToFileURL(STATS_MJS).href);
  } catch {
    return null;
  }
}

// ---- minimal glob (single directory-level `*`) ----

function globSegToRe(seg) {
  let s = "^";
  for (const ch of seg) {
    if (ch === "*") s += "[^\\\\/]*";
    else s += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  s += "$";
  return new RegExp(s);
}

function countGlob(pattern) {
  const parts = pattern.split(/[\\/]/);
  let baseEnd = 0;
  while (baseEnd < parts.length && !parts[baseEnd].includes("*")) baseEnd++;
  let base = parts.slice(0, baseEnd).join(path.sep);
  if (base === "") base = path.sep;
  const rest = parts.slice(baseEnd);
  let count = 0;
  _walkCount(base, rest, () => { count += 1; });
  return count;
}

function _walkCount(dir, rest, add) {
  if (rest.length === 0) return;
  const seg = rest[0];
  const remaining = rest.slice(1);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const re = globSegToRe(seg);
  for (const e of entries) {
    if (!re.test(e.name)) continue;
    if (remaining.length === 0) {
      add();
    } else if (e.isDirectory()) {
      _walkCount(path.join(dir, e.name), remaining, add);
    }
  }
}

function _count_lines(text) {
  // Mirror Python `sum(1 for _ in open(f))` under universal-newline semantics:
  // every newline-terminated line counts, plus a trailing line if no final newline.
  if (text === "") return 0;
  let n = 0;
  let i = 0;
  while ((i = text.indexOf("\n", i)) !== -1) { n++; i++; }
  if (!text.endsWith("\n")) n++;
  return n;
}

function _data_inventory() {
  let archive = 0;
  if (isFile(SESSIONS_JSONL)) {
    try {
      archive = _count_lines(fs.readFileSync(SESSIONS_JSONL, "utf-8"));
    } catch {
      archive = 0;
    }
  }
  return {
    transcripts: countGlob(path.join(PROJECTS_DIR, "*", "*.jsonl")),
    history: isFile(path.join(CLAUDE_DIR, "history.jsonl")),
    tasks: countGlob(path.join(CLAUDE_DIR, "tasks", "*")),
    file_history: countGlob(path.join(CLAUDE_DIR, "file-history", "*")),
    archive,
  };
}

// ---- Python-style output formatting (preserve the prior Python CLI output shape) ----

function pyBool(b) {
  return b ? "True" : "False";
}

function roundHalfEven(x, ndigits) {
  if (!Number.isFinite(x)) return x;
  const m = Math.pow(10, ndigits);
  const scaled = x * m;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let r;
  if (diff > 0.5) r = floor + 1;
  else if (diff < 0.5) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / m;
}

function fmt0f(x) {
  // Mirror Python f"{x:.0f}" — round half to even, no decimal point.
  return String(Math.trunc(roundHalfEven(x, 0)));
}

function pyDictRepr(d) {
  // Mirror Python repr for dict[str, int]: {'k': v, 'k2': v2}.
  return "{" + Object.entries(d).map(([k, v]) => `'${k}': ${v}`).join(", ") + "}";
}

function pyJsonDumps(obj) {
  // Mirror json.dumps(obj, ensure_ascii=False) default separators (', ', ': ').
  return _pyJson(obj);
}

function _pyJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") return String(v);
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) {
    return "[" + v.map(_pyJson).join(", ") + "]";
  }
  return "{" + Object.entries(v).map(([k, val]) => JSON.stringify(k) + ": " + _pyJson(val)).join(", ") + "}";
}

// ---- roadmap ----

async function build_roadmap() {
  // Return { suggestions, inventory, sessions, totals, usage }.
  // Each suggestion: {area, status in (available|partial|idea), text}.
  const inv = _data_inventory();
  const m = await _load_stats_module();
  let sessions = [];
  let totals = { sessions: 0 };
  let usage = { tools: {}, agents: {}, skills: {} };
  if (m !== null && isFile(m.STATS_CSV)) {
    try {
      const c = m._load_stats();
      sessions = c.sessions;
      totals = c.totals;
      usage = c.usage;
    } catch {
      /* leave defaults */
    }
  }
  const n = totals.sessions || 1;
  const loc_cov = sessions.reduce((acc, s) => acc + (((s.la || 0) + (s.lr || 0)) > 0 ? 1 : 0), 0);
  const sg = [];

  function add(area, status, text) {
    sg.push({ area, status, text });
  }

  // --- data you already have locally but the report doesn't chart yet ---
  if (inv.history) {
    add("Prompt patterns", "available",
      "history.jsonl present — add prompt-length distribution, prompts/session, and " +
      "think-time between prompts (when in the day you're most productive).");
  }
  if (inv.tasks) {
    add("Task completion", "available",
      `${inv.tasks} TaskCreate todo lists in ~/.claude/tasks — add a todo ` +
      "completion-rate stat (done vs abandoned per session).");
  }
  if (inv.file_history) {
    add("File churn", "available",
      `${inv.file_history} file-history snapshots — surface most-edited files/repos ` +
      "and real churn, independent of statusline line counts.");
  }
  add("Response latency", "available",
    "Transcript message timestamps support a think-time vs generation-time split per session.");

  // --- capture/coverage gaps (fill as more sessions record) ---
  add("LOC coverage", "partial",
    `lines added/removed present for ${loc_cov}/${totals.sessions || 0} sessions ` +
    `(${fmt0f(loc_cov / n * 100)}%); $/line is now cost-scoped to line-bearing rows and ` +
    "shown as '—' below 5% coverage. Value still firms up as more sessions record via the statusline.");
  add("Active-time tracking", "partial",
    "$/hour now uses an active-time proxy (cost>0 sessions, per-session duration uncapped " +
    "— legit sessions can exceed 8h) instead of raw transcript wall-clock span, which " +
    "counted idle/hung sessions (e.g. 577h @ $0). The $0-cost filter alone drops " +
    "idle/hung sessions; proxy still underestimates real hourly cost because idle is " +
    "distributed within billed sessions; a true fix needs turn-level active-time capture " +
    "in the statusline, not transcript span.");
  add("Rate-limit utilization", "partial",
    "rl_5h_pct / rl_7d_pct now charted (utilization %, throttle-safety >80%/100%, " +
    "spend per 7d%-point at peak). Forward-only from the statusline rate_limits field " +
    "(Claude Code v2.1.80+, Claude.ai Pro/Max only — absent for API-key/Bedrock/Vertex " +
    "and some Max 20x oauth users). Coverage grows as sessions record; efficient-use " +
    "judgment firms up once a full 7-day window is captured.");
  if (inv.archive === 0) {
    add("Statusline archive", "partial",
      "sessions.jsonl is empty — the full-JSON archive fills as new sessions end; future " +
      "metrics (rate-limit trends, context fullness) then need no re-capture.");
  } else {
    add("Statusline archive", "available",
      `${inv.archive} sessions archived in sessions.jsonl — mine rate-limit % and ` +
      "context-fullness trends next.");
  }

  // --- visualization / UX improvements ---
  add("Report UX", "idea",
    "Add a date-range filter, a session search box, sortable tables, and CSV/PNG export.");
  add("Report UX", "idea",
    "Per-project filter mirroring the model filter; drill from a project into its sessions.");
  add("Cross-tool", "idea",
    "Reconcile against other AI-coding spend trackers (e.g. CodeBurn, agent-insights) " +
    "for spend across Copilot, Cursor, Codex, if you use any.");
  return { suggestions: sg, inventory: inv, sessions, totals, usage };
}

async function cmd_roadmap(args) {
  const { suggestions: sg, inventory: inv, totals, usage } = await build_roadmap();
  if (args.json) {
    console.log(pyJsonDumps(sg));
    return;
  }
  console.log("=== improve-insights · pipeline audit ===");
  console.log(`stats.mjs found: ${pyBool(isFile(STATS_MJS))}   sessions in stats.csv: ${totals.sessions || 0}`);
  console.log(`transcripts=${inv.transcripts}  history.jsonl=${pyBool(inv.history)}  tasks=${inv.tasks}  ` +
    `file-history=${inv.file_history}  sessions.jsonl=${inv.archive}`);
  if (usage.tools && Object.keys(usage.tools).length) {
    const entries = Object.entries(usage.tools);
    entries.sort((a, b) => b[1] - a[1]); // stable: preserves insertion order on ties
    const top = Object.fromEntries(entries.slice(0, 8));
    console.log(`top tools: ${pyDictRepr(top)}`);
  }
  console.log("\n=== roadmap (status · area · idea) ===");
  for (const s of sg) {
    console.log(`[${s.status.padEnd(9)}] ${s.area}: ${s.text}`);
  }
  console.log("\nImplement an item: ask to add it; the agent edits stats.mjs/statusline.mjs and re-runs backfill+report.");
}

async function main() {
  let parsed;
  try {
    parsed = parseArgs({
      args: process.argv.slice(2),
      options: { json: { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (e) {
    process.stderr.write(`improve.mjs: error: ${e.message}\n`);
    process.exit(2);
  }
  const cmd = parsed.positionals[0];
  if (cmd === "roadmap") {
    await cmd_roadmap(parsed.values);
  } else {
    process.stderr.write("improve.mjs: error: the following arguments are required: cmd\n");
    process.exit(2);
  }
}

main().catch((e) => {
  process.stderr.write(String(e && e.stack ? e.stack : e) + "\n");
  process.exit(1);
});