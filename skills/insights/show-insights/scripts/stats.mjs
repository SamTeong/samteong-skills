// Claude Code stats pipeline: record (SessionEnd hook), backfill, report (HTML).
// Node ESM, stdlib only. All data stays local.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CHROME_CSS, JUMP_JS, jumpNavHtml } from "./report_chrome.mjs";

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, ".claude");
const PROJECTS_DIR = path.join(CLAUDE_DIR, "projects");
const SKILL_STATE_DIR = path.join(HOME, ".agents", ".show-insights", "state");
const STATE_DIR = path.join(SKILL_STATE_DIR, "cost-state");
export const STATS_CSV = path.join(SKILL_STATE_DIR, "stats.csv");
const SESSIONS_JSONL = path.join(SKILL_STATE_DIR, "sessions.jsonl");
const REPORTS_DIR = path.join(HOME, ".agents", ".show-insights", "reports");
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const SCRIPT = fileURLToPath(import.meta.url);

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

const HEADER = "timestamp,session_id,total_cost_usd,last_model,input_tokens,output_tokens," +
  "cache_read_tokens,cache_creation_tokens,model_id,model_display_name,duration_ms," +
  "api_duration_ms,lines_added,lines_removed,rl_5h_pct,rl_7d_pct,context_pct," +
  "context_window_size,turns,tool_calls,start_epoch,facets_json";
const COLS = HEADER.split(",");
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// ---- fs helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function getmtime(p) {
  return fs.statSync(p).mtimeMs / 1000;
}

// Mirror Python glob.glob for the simple patterns used here. Supports a single
// directory-level `*` and `**` (recursive) segments. Returns absolute paths.
function globSync(pattern) {
  const parts = pattern.split(/[\\/]/);
  // Find first segment containing a wildcard.
  let baseEnd = 0;
  while (baseEnd < parts.length && !parts[baseEnd].includes("*")) baseEnd++;
  let base = parts.slice(0, baseEnd).join(path.sep);
  if (base === "") base = path.sep;
  const rest = parts.slice(baseEnd);
  const results = [];
  walkGlob(base, rest, results);
  return results;
}

function walkGlob(dir, rest, out) {
  if (rest.length === 0) {
    if (fs.existsSync(dir)) out.push(dir);
    return;
  }
  const seg = rest[0];
  const remaining = rest.slice(1);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  if (seg === "**") {
    // ** matches zero or more directory levels (Python recursive=True semantics).
    // Try matching the rest at this level (zero dirs)...
    walkGlob(dir, remaining, out);
    // ...and recurse into every subdirectory keeping ** in place.
    for (const e of entries) {
      if (e.isDirectory()) {
        walkGlob(path.join(dir, e.name), rest, out);
      }
    }
    return;
  }
  const re = globSegToRe(seg);
  for (const e of entries) {
    if (re.test(e.name)) {
      walkGlob(path.join(dir, e.name), remaining, out);
    }
  }
}

function globSegToRe(seg) {
  let s = "^";
  for (const ch of seg) {
    if (ch === "*") s += "[^\\\\/]*";
    else s += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  s += "$";
  return new RegExp(s);
}

// ---- CSV (RFC 4180) ----

function parseCsv(text) {
  // Returns array of arrays of fields. Handles quoted fields with embedded
  // commas, newlines, and "" escapes.
  const rows = [];
  let field = "";
  let row = [];
  let i = 0;
  let inQuotes = false;
  const n = text.length;
  let started = false;
  while (i < n) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += ch;
        i++;
      }
    } else if (ch === '"') {
      inQuotes = true;
      started = true;
      i++;
    } else if (ch === ",") {
      row.push(field);
      field = "";
      started = true;
      i++;
    } else if (ch === "\r") {
      // handle CRLF or lone CR as line break
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      i++;
      if (text[i] === "\n") i++;
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      i++;
    } else {
      field += ch;
      started = true;
      i++;
    }
  }
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function* dictReader(text) {
  // Mirror csv.DictReader: first row is header, yields {col: value} objects.
  // Strip a UTF-8 BOM if present (utf-8-sig in Python).
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = parseCsv(text);
  if (!rows.length) return;
  const header = rows[0];
  for (let r = 1; r < rows.length; r++) {
    const vals = rows[r];
    // skip fully blank rows (csv.DictReader skips blank lines)
    if (vals.length === 1 && vals[0] === "") continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) {
      obj[header[c]] = c < vals.length ? vals[c] : null;
    }
    yield obj;
  }
}

function _csv_field(v) {
  let s = v === null || v === undefined ? "" : String(v);
  if (s.includes(",") || s.includes('"')) {
    s = '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// ---- general helpers ----

function* iter_jsonl(p) {
  let text;
  try {
    text = fs.readFileSync(p, "utf-8");
  } catch {
    return;
  }
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    try {
      yield JSON.parse(line);
    } catch {
      continue;
    }
  }
}

function epoch_from_iso(s) {
  if (!s) return null;
  try {
    const d = new Date(s.replace("Z", "+00:00"));
    const t = d.getTime();
    if (Number.isNaN(t)) return null;
    return t / 1000;
  } catch {
    return null;
  }
}

function esc(s) {
  return htmlEscape(s === null || s === undefined ? "" : String(s));
}

// Python html.escape(quote=True): & < > " '
function htmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

function htmlUnescape(s) {
  return String(s)
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&amp;/g, "&");
}

function _dig(obj, ...keys) {
  let cur = obj;
  for (const k of keys) {
    if (cur === null || typeof cur !== "object" || Array.isArray(cur)) return null;
    cur = cur[k];
    if (cur === undefined) cur = null;
  }
  return cur;
}

function _extract_state(d) {
  return {
    cost: _dig(d, "cost", "total_cost_usd"),
    model_id: _dig(d, "model", "id") || "",
    model_display_name: _dig(d, "model", "display_name") || "",
    duration_ms: _dig(d, "cost", "total_duration_ms") || 0,
    api_duration_ms: _dig(d, "cost", "total_api_duration_ms") || 0,
    lines_added: _dig(d, "cost", "total_lines_added") || 0,
    lines_removed: _dig(d, "cost", "total_lines_removed") || 0,
    rl_5h_pct: _dig(d, "rate_limits", "five_hour", "used_percentage"),
    rl_7d_pct: _dig(d, "rate_limits", "seven_day", "used_percentage"),
    context_pct: _dig(d, "context_window", "used_percentage"),
    context_window_size: _dig(d, "context_window", "context_window_size"),
    raw: d,
  };
}

function read_cost_state(sid) {
  const j = path.join(STATE_DIR, `${sid}.json`);
  if (isFile(j)) {
    try {
      return _extract_state(JSON.parse(fs.readFileSync(j, "utf-8")));
    } catch {
      /* fall through */
    }
  }
  return null;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function fmtLocal(d) {
  return (
    d.getFullYear() +
    "-" +
    pad2(d.getMonth() + 1) +
    "-" +
    pad2(d.getDate()) +
    " " +
    pad2(d.getHours()) +
    ":" +
    pad2(d.getMinutes()) +
    ":" +
    pad2(d.getSeconds())
  );
}

function now_local() {
  return fmtLocal(new Date());
}

function local_fmt(epoch) {
  if (epoch === null || epoch === undefined) return null;
  try {
    const d = new Date(epoch * 1000);
    if (Number.isNaN(d.getTime())) return null;
    return fmtLocal(d);
  } catch {
    return null;
  }
}

function find_transcript(sid) {
  const hits = globSync(path.join(PROJECTS_DIR, "*", `${sid}.jsonl`));
  return hits.length ? hits[0] : null;
}

function session_totals(sid) {
  const base = parse_transcript(find_transcript(sid));
  for (const p of globSync(path.join(PROJECTS_DIR, "*", sid, "**", "*.jsonl"))) {
    const s = parse_transcript(p);
    base.input_tokens += s.input_tokens;
    base.output_tokens += s.output_tokens;
    base.cache_read_tokens += s.cache_read_tokens;
    base.cache_creation_tokens += s.cache_creation_tokens;
    base.turns += s.turns;
    base.tool_calls += s.tool_calls;
    _merge_facets(base.facets, s.facets);
    if (s.end_epoch && (base.end_epoch === null || s.end_epoch > base.end_epoch)) {
      base.end_epoch = s.end_epoch;
    }
    if (s.start_epoch && (base.start_epoch === null || s.start_epoch < base.start_epoch)) {
      base.start_epoch = s.start_epoch;
    }
  }
  return base;
}

function _merge_facets(a, b) {
  for (const k of ["tools", "agents", "skills"]) {
    for (const [name, n] of Object.entries(b[k])) {
      a[k][name] = (a[k][name] || 0) + n;
    }
  }
  a.tool_errors += b.tool_errors;
  a.compactions += b.compactions;
  a.cwd = a.cwd || b.cwd;
  a.branch = a.branch || b.branch;
}

function _new_facets() {
  return { tools: {}, tool_errors: 0, agents: {}, skills: {}, compactions: 0, cwd: "", branch: "" };
}

function parse_transcript(p) {
  const r = {
    last_model: "",
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    end_epoch: null,
    start_epoch: null,
    turns: 0,
    tool_calls: 0,
    facets: _new_facets(),
  };
  const fc = r.facets;
  if (!p || !isFile(p)) return r;
  let last_model_epoch = null;
  for (const o of iter_jsonl(p)) {
    if (o.isSidechain === true || o.isMeta === true) continue;
    if (o.cwd) fc.cwd = o.cwd;
    if (o.gitBranch) fc.branch = o.gitBranch;
    if (o.isCompactSummary === true) fc.compactions += 1;
    const ts = epoch_from_iso(o.timestamp);
    if (ts) {
      if (r.end_epoch === null || ts > r.end_epoch) r.end_epoch = ts;
      if (r.start_epoch === null || ts < r.start_epoch) r.start_epoch = ts;
    }
    const typ = o.type;
    if (typ === "user") {
      const c = (o.message || {}).content;
      const human =
        typeof c === "string" ||
        (Array.isArray(c) && c.some((b) => b && typeof b === "object" && b.type === "text"));
      if (human) r.turns += 1;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && typeof b === "object" && b.type === "tool_result" && b.is_error) {
            fc.tool_errors += 1;
          }
        }
      }
      continue;
    }
    if (typ !== "assistant") continue;
    const msg = o.message || {};
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === "object" && b.type === "tool_use") {
          r.tool_calls += 1;
          const name = b.name || "?";
          fc.tools[name] = (fc.tools[name] || 0) + 1;
          const inp = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
          if (name === "Agent") {
            const st = inp.subagent_type || "general-purpose";
            fc.agents[st] = (fc.agents[st] || 0) + 1;
          } else if (name === "Skill") {
            const sk = inp.command || inp.skill || "?";
            fc.skills[sk] = (fc.skills[sk] || 0) + 1;
          }
        }
      }
    }
    const model = msg.model;
    let usage = msg.usage || {};
    if (typeof usage !== "object" || Array.isArray(usage) || usage === null) usage = {};
    const i = intOr0(usage.input_tokens);
    const o_ = intOr0(usage.output_tokens);
    const cr = intOr0(usage.cache_read_input_tokens);
    const cc = intOr0(usage.cache_creation_input_tokens);
    if (model === "<synthetic>" || (i === 0 && o_ === 0 && cr === 0 && cc === 0)) continue;
    r.input_tokens += i;
    r.output_tokens += o_;
    r.cache_read_tokens += cr;
    r.cache_creation_tokens += cc;
    if (model && (last_model_epoch === null || (ts !== null && ts >= (last_model_epoch ?? -1)))) {
      if (ts !== null) {
        last_model_epoch = ts;
        r.last_model = model;
      }
    }
  }
  return r;
}

function intOr0(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

// ---- priors (pre-execution cost estimation) ----

const PRIORS_JSON = path.join(SKILL_STATE_DIR, "priors.json");

const PRICE = {
  opus: [5.0, 25.0, 0.5, 6.25],
  sonnet: [3.0, 15.0, 0.3, 3.75],
  haiku: [1.0, 5.0, 0.1, 1.25],
  fable: [10.0, 50.0, 1.0, 12.5],
  mythos: [10.0, 50.0, 1.0, 12.5],
};
const DEFAULT_PRICE_KEY = "opus";

const ORCH_TOOLS = new Set([
  "Agent", "Task", "TaskCreate", "TaskUpdate", "TaskStop", "TaskGet", "TaskList", "TaskOutput",
]);
const EDIT_TOOLS = new Set([
  "Edit", "Write", "MultiEdit", "NotebookEdit", "ctx_edit", "mcp__lean-ctx__ctx_edit",
]);
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
  "ctx_read", "ctx_search", "ctx_tree", "ctx_overview",
  "mcp__lean-ctx__ctx_read", "mcp__lean-ctx__ctx_search",
  "mcp__lean-ctx__ctx_tree", "mcp__lean-ctx__ctx_overview",
]);
const PLAN_TOOLS = new Set(["EnterPlanMode", "ExitPlanMode"]);
const TEST_RE = new RegExp(
  "\\b(pytest|jest|vitest|mocha|go test|dotnet test|" +
    "npm (run )?test|pnpm (run )?test|cargo test|rspec|" +
    "phpunit|unittest|tox)\\b",
  "i"
);
const VERIFY_SKILL_RE = /verify|review|test/i;

function _price_key(model) {
  const m = (model || "").toLowerCase();
  for (const k of Object.keys(PRICE)) {
    if (m.includes(k)) return k;
  }
  return DEFAULT_PRICE_KEY;
}

function _msg_cost(model, i, o, cr, cc) {
  const [inp, out, crp, ccp] = PRICE[_price_key(model)];
  return (i * inp + o * out + cr * crp + cc * ccp) / 1e6;
}

function _seg_weight(seg) {
  const m = (seg.model || "").toLowerCase();
  if (!Object.keys(PRICE).some((k) => m.includes(k))) return 0.0;
  return _msg_cost(seg.model, seg.in, seg.out, seg.cr, seg.cc);
}

function _seg_new() {
  return {
    start: null, end: null, in: 0, out: 0, cr: 0, cc: 0,
    tools: new Set(), verify: false, has_subagent: false, model: "", api_turns: 0,
  };
}

function segment_transcript(p) {
  const segs = [];
  let cur = null;
  if (!p || !isFile(p)) return segs;
  for (const o of iter_jsonl(p)) {
    if (o.isSidechain === true || o.isMeta === true) continue;
    const typ = o.type;
    const ts = epoch_from_iso(o.timestamp);
    if (typ === "user") {
      const c = (o.message || {}).content;
      const human =
        typeof c === "string" ||
        (Array.isArray(c) && c.some((b) => b && typeof b === "object" && b.type === "text"));
      if (human) {
        cur = _seg_new();
        cur.start = ts;
        segs.push(cur);
      }
      continue;
    }
    if (typ !== "assistant") continue;
    if (cur === null) {
      cur = _seg_new();
      cur.start = ts;
      segs.push(cur);
    }
    if (ts) {
      if (cur.start === null) cur.start = ts;
      cur.end = ts;
    }
    const msg = o.message || {};
    const content = msg.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (!(b && typeof b === "object" && b.type === "tool_use")) continue;
        const name = b.name || "?";
        cur.tools.add(name);
        const inp = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
        if (name === "Skill") {
          const sk = inp.command || inp.skill || "";
          if (VERIFY_SKILL_RE.test(String(sk))) cur.verify = true;
        } else if (name === "Bash" || name === "PowerShell") {
          if (TEST_RE.test(String(inp.command || ""))) cur.verify = true;
        }
      }
    }
    const model = msg.model;
    let usage = msg.usage;
    if (typeof usage !== "object" || Array.isArray(usage) || usage === null) usage = {};
    const i = intOr0(usage.input_tokens);
    const o_ = intOr0(usage.output_tokens);
    const cr = intOr0(usage.cache_read_input_tokens);
    const cc = intOr0(usage.cache_creation_input_tokens);
    if (model === "<synthetic>" || (i === 0 && o_ === 0 && cr === 0 && cc === 0)) continue;
    cur.in += i;
    cur.out += o_;
    cur.cr += cr;
    cur.cc += cc;
    cur.api_turns += 1;
    if (model) cur.model = model;
  }
  return segs;
}

function _subagent_runs(sid) {
  const runs = [];
  for (const p of globSync(path.join(PROJECTS_DIR, "*", sid, "**", "*.jsonl"))) {
    const s = parse_transcript(p);
    runs.push({
      start: s.start_epoch, model: s.last_model,
      in: s.input_tokens, out: s.output_tokens,
      cr: s.cache_read_tokens, cc: s.cache_creation_tokens,
    });
  }
  return runs;
}

function classify_segment(seg) {
  const t = seg.tools;
  if (seg.has_subagent || setIntersects(t, ORCH_TOOLS)) return "orchestration";
  if (setIntersects(t, EDIT_TOOLS)) return "execution";
  if (seg.verify) return "verification";
  if (setIntersects(t, PLAN_TOOLS) || (t.size && setIsSubset(t, READ_TOOLS))) return "planning";
  return "other";
}

function setIntersects(a, b) {
  for (const x of a) if (b.has(x)) return true;
  return false;
}

function setIsSubset(a, b) {
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

function _build_priors() {
  const cats = {};
  const existing_cost = {};
  if (isFile(STATS_CSV)) {
    const text = fs.readFileSync(STATS_CSV, "utf-8");
    for (const row of dictReader(text)) {
      const sid = (row.session_id || "").trim();
      const c = (row.total_cost_usd || "").trim();
      if (sid && c) {
        const f = parseFloat(c);
        if (!Number.isNaN(f)) existing_cost[sid] = f;
      }
    }
  }
  let n_sessions = 0;
  for (const p of globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"))) {
    const sid = path.basename(p, ".jsonl");
    if (sid === ZERO_UUID) continue;
    const segs = segment_transcript(p);
    if (!segs.length) continue;
    n_sessions += 1;
    for (const r of _subagent_runs(sid)) {
      const st = r.start;
      let tgt = null;
      if (st !== null) {
        for (const seg of segs) {
          if (seg.start !== null && seg.end !== null && seg.start <= st && st <= seg.end) {
            tgt = seg;
            break;
          }
        }
        if (tgt === null) {
          const cand = segs.filter((s) => s.start !== null && s.start <= st);
          if (cand.length) {
            tgt = cand.reduce((a, b) => (b.start > a.start ? b : a));
          }
        }
      }
      if (tgt === null) tgt = segs[segs.length - 1];
      tgt.has_subagent = true;
      tgt.in += r.in;
      tgt.out += r.out;
      tgt.cr += r.cr;
      tgt.cc += r.cc;
    }
    const weights = segs.map((s) => _seg_weight(s));
    const sumw = weights.reduce((a, b) => a + b, 0);
    const actual = existing_cost[sid];
    const calibrated = actual !== undefined && actual > 0 && sumw > 0;
    for (let idx = 0; idx < segs.length; idx++) {
      const seg = segs[idx];
      const w = weights[idx];
      const cost = calibrated ? (actual * w) / sumw : w;
      const cat = classify_segment(seg);
      (cats[cat] = cats[cat] || []).push({
        cost, calibrated, out: seg.out, api_turns: seg.api_turns,
        tot: seg.in + seg.out + seg.cr + seg.cc,
      });
    }
  }

  const dist = (vals) => {
    const sv = vals.slice().sort((a, b) => a - b);
    return {
      p50: round4(_percentile(sv, 0.5)),
      p90: round4(_percentile(sv, 0.9)),
      mean: sv.length ? round4(sv.reduce((a, b) => a + b, 0) / sv.length) : 0.0,
    };
  };

  const categories = {};
  for (const [cat, recs] of Object.entries(cats)) {
    const cal_costs = recs.filter((r) => r.calibrated).map((r) => r.cost);
    categories[cat] = {
      n: recs.length,
      n_cost: cal_costs.length,
      cost: dist(cal_costs),
      out_tok: dist(recs.map((r) => r.out)),
      total_tok: dist(recs.map((r) => r.tot)),
      api_turns: dist(recs.map((r) => r.api_turns)),
    };
  }
  let n_cost = 0;
  let n_ops = 0;
  for (const recs of Object.values(cats)) {
    n_ops += recs.length;
    for (const r of recs) if (r.calibrated) n_cost += 1;
  }
  const price_per_mtok = {};
  for (const [k, v] of Object.entries(PRICE)) {
    price_per_mtok[k] = { input: v[0], output: v[1], cache_read: v[2], cache_write_5m: v[3] };
  }
  const priors = {
    n_sessions,
    n_ops,
    n_ops_cost_calibrated: n_cost,
    cost_basis:
      "per-op USD = session total_cost_usd redistributed across " +
      "ops by token-price weight; non-Claude/local models weight 0. " +
      "Absolute scale is real billed cost; price table sets only " +
      "relative weights.",
    price_per_mtok,
    categories,
  };
  fs.writeFileSync(PRIORS_JSON, JSON.stringify(priors, null, 2), "utf-8");
  return priors;
}

function round4(x) {
  // Python round() uses banker's rounding; differences at 4dp are negligible for
  // the values here, but match round-half-to-even to be faithful.
  return roundHalfEven(x, 4);
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

function _print_priors(p) {
  const cs = p.categories;
  print(`priors -> ${PRIORS_JSON}`);
  print(`sessions=${p.n_sessions} ops=${p.n_ops} cost-calibrated=${p.n_ops_cost_calibrated}`);
  print(
    padR("category", 14) + padL("n", 6) + padL("$ p50", 9) +
      padL("$ p90", 9) + padL("out p50", 9) + padL("turns", 7)
  );
  const cats = Object.keys(cs).sort((a, b) => cs[b].cost.p50 - cs[a].cost.p50);
  for (const cat of cats) {
    const d = cs[cat];
    print(
      padR(cat, 14) +
        padL(String(d.n), 6) +
        padL(fixed(d.cost.p50, 4), 9) +
        padL(fixed(d.cost.p90, 4), 9) +
        padL(String(Math.trunc(d.out_tok.p50)), 9) +
        padL(fixed(d.api_turns.p50, 1), 7)
    );
  }
}

function cmd_priors() {
  _print_priors(_build_priors());
}

// ---- estimate (pre-op cost lookup; no LLM) ----

function _latest_context() {
  const files = globSync(path.join(STATE_DIR, "*.json"));
  if (!files.length) return null;
  let newest = files[0];
  let newestM = getmtime(newest);
  for (const f of files) {
    const m = getmtime(f);
    if (m > newestM) {
      newest = f;
      newestM = m;
    }
  }
  let d;
  try {
    d = JSON.parse(fs.readFileSync(newest, "utf-8"));
  } catch {
    return null;
  }
  const cu = _dig(d, "context_window", "current_usage") || {};
  let tok = 0;
  for (const k of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    tok += intOr0(cu[k]);
  }
  return { tokens: tok, model: _dig(d, "model", "id") || "" };
}

function _priors_stale(max_age_days = 7) {
  if (!isFile(PRIORS_JSON)) return true;
  const pj = getmtime(PRIORS_JSON);
  if (Date.now() / 1000 - pj > max_age_days * 86400) return true;
  let newest = 0;
  for (const p of globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"))) {
    const m = getmtime(p);
    if (m > newest) newest = m;
  }
  return newest > pj;
}

function cmd_estimate(args) {
  let p;
  if (!args.no_refresh && _priors_stale()) {
    printErr("refreshing priors...");
    p = _build_priors();
  } else {
    if (!isFile(PRIORS_JSON)) {
      printErr("no priors.json — run: node stats.mjs priors");
      process.exit(1);
    }
    p = JSON.parse(fs.readFileSync(PRIORS_JSON, "utf-8"));
  }
  const cats = p.categories || {};
  let cat = args.category;
  if (!(cat in cats)) {
    const hits = Object.keys(cats).filter((c) => c.startsWith(cat));
    if (hits.length === 1) {
      cat = hits[0];
    } else {
      printErr(`unknown category '${args.category}'. choose: ${Object.keys(cats).sort().join(", ")}`);
      process.exit(1);
    }
  }
  const d = cats[cat];
  const cost = d.cost;
  const turns = d.api_turns.p50;
  print(`category: ${cat}  (n=${d.n}, cost-calibrated n=${d.n_cost ?? 0})`);
  print(
    `historical cost:  p50 $${fixed(cost.p50, 2)}   p90 $${fixed(cost.p90, 2)}   mean $${fixed(cost.mean, 2)}`
  );
  print(`typical turns: ${fixed(turns, 0)}   typical output: ${_abbr(d.out_tok.p50)} tok`);

  let ctx_tok = args.context_tokens;
  let model = args.model;
  if (ctx_tok === null || ctx_tok === undefined) {
    const live = _latest_context();
    if (live) {
      ctx_tok = live.tokens;
      model = model || live.model;
    }
  }
  if (ctx_tok) {
    const crp = PRICE[_price_key(model)][2];
    const floor = (ctx_tok * turns * crp) / 1e6;
    print(
      `input re-read floor: $${fixed(floor, 2)}  ` +
        `(${_abbr(ctx_tok)} ctx x ${fixed(turns, 0)} turns @ $${crp}/MTok cache-read` +
        `${model ? ", " + (model || "opus") : ""})`
    );
  }
  print(`\nestimate: $${fixed(cost.p50, 2)}-$${fixed(cost.p90, 2)}`);
}

// ---- record (live SessionEnd hook) ----

function _blank(v) {
  return v === null || v === undefined ? "" : v;
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function cmd_record() {
  let data;
  try {
    data = JSON.parse(readStdin() || "{}");
  } catch {
    process.exit(0);
  }
  const sid = data.session_id;
  if (!sid || sid === ZERO_UUID) process.exit(0);
  const state = read_cost_state(sid);
  if (!state || state.cost === null || state.cost === undefined || state.cost === "") process.exit(0);
  const t = session_totals(sid);
  let dur = _inum(state.duration_ms);
  if (!dur && t.start_epoch && t.end_epoch) {
    dur = Math.trunc((t.end_epoch - t.start_epoch) * 1000);
  }
  const rowd = {
    timestamp: now_local(),
    session_id: sid,
    total_cost_usd: state.cost,
    last_model: t.last_model,
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read_tokens: t.cache_read_tokens,
    cache_creation_tokens: t.cache_creation_tokens,
    model_id: state.model_id || "",
    model_display_name: state.model_display_name || "",
    duration_ms: dur,
    api_duration_ms: _inum(state.api_duration_ms),
    lines_added: _inum(state.lines_added),
    lines_removed: _inum(state.lines_removed),
    rl_5h_pct: _blank(state.rl_5h_pct),
    rl_7d_pct: _blank(state.rl_7d_pct),
    context_pct: _blank(state.context_pct),
    context_window_size: _blank(state.context_window_size),
    turns: t.turns,
    tool_calls: t.tool_calls,
    start_epoch: t.start_epoch ? Math.trunc(t.start_epoch) : "",
    facets_json: jsonCompact(t.facets),
  };
  _prepend_row(COLS.map((c) => (c in rowd ? rowd[c] : "")));
  if (state.raw !== null && state.raw !== undefined) _archive(sid, state.raw);
  try {
    fs.unlinkSync(path.join(STATE_DIR, `${sid}.json`));
  } catch {
    /* ignore */
  }
  process.exit(0);
}

// json.dumps(..., ensure_ascii=False, separators=(",", ":"))
function jsonCompact(obj) {
  return JSON.stringify(obj);
}

function _archive(sid, raw) {
  try {
    const rec = { recorded_at: now_local(), session_id: sid, statusline: raw };
    fs.appendFileSync(SESSIONS_JSONL, JSON.stringify(rec) + "\n", "utf-8");
  } catch {
    /* ignore */
  }
}

function _prepend_row(row) {
  const line = row.map((x) => _csv_field(x)).join(",");
  if (!isFile(STATS_CSV)) {
    fs.writeFileSync(STATS_CSV, HEADER + "\n" + line + "\n", "utf-8");
    return;
  }
  let text = fs.readFileSync(STATS_CSV, "utf-8");
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split(/\r?\n/);
  // splitlines() drops a trailing empty string from a final newline
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let rest;
  if (lines.length && lines[0].trim() !== HEADER) {
    rest = lines;
  } else {
    rest = lines.length > 1 ? lines.slice(1) : [];
  }
  const out = [HEADER, line, ...rest.filter((l) => l.trim())];
  fs.writeFileSync(STATS_CSV, out.join("\n") + "\n", "utf-8");
}

// ---- backfill ----

function cmd_backfill() {
  const existing = {};
  if (isFile(STATS_CSV)) {
    const text = fs.readFileSync(STATS_CSV, "utf-8");
    for (const row of dictReader(text)) {
      const sid = (row.session_id || "").trim();
      if (!sid || sid === ZERO_UUID) continue;
      const prev = existing[sid];
      if (prev && (prev.total_cost_usd || "").trim() && !(row.total_cost_usd || "").trim()) {
        continue;
      }
      existing[sid] = row;
    }
  }

  const fwd = (ex, col) => (ex ? ex[col] || "" : "");

  const rows = [];
  const seen = new Set();
  let with_cost = 0;
  for (const p of globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"))) {
    const sid = path.basename(p, ".jsonl");
    if (sid === ZERO_UUID) continue;
    seen.add(sid);
    const ex = existing[sid] || {};
    const t = session_totals(sid);
    const cost = (ex.total_cost_usd || "").trim();
    if (cost) with_cost += 1;
    let dur = _inum(fwd(ex, "duration_ms"));
    if (!dur && t.start_epoch && t.end_epoch) {
      dur = Math.trunc((t.end_epoch - t.start_epoch) * 1000);
    }
    const ts =
      (ex.timestamp || "").trim() ||
      local_fmt(t.end_epoch) ||
      local_fmt(getmtime(p)) ||
      "";
    rows.push({
      timestamp: ts || "",
      session_id: sid,
      total_cost_usd: cost,
      last_model: t.last_model,
      input_tokens: t.input_tokens,
      output_tokens: t.output_tokens,
      cache_read_tokens: t.cache_read_tokens,
      cache_creation_tokens: t.cache_creation_tokens,
      model_id: fwd(ex, "model_id") || t.last_model,
      model_display_name: fwd(ex, "model_display_name"),
      duration_ms: dur,
      api_duration_ms: _inum(fwd(ex, "api_duration_ms")),
      lines_added: _inum(fwd(ex, "lines_added")),
      lines_removed: _inum(fwd(ex, "lines_removed")),
      rl_5h_pct: fwd(ex, "rl_5h_pct"),
      rl_7d_pct: fwd(ex, "rl_7d_pct"),
      context_pct: fwd(ex, "context_pct"),
      context_window_size: fwd(ex, "context_window_size"),
      turns: t.turns,
      tool_calls: t.tool_calls,
      start_epoch: t.start_epoch ? Math.trunc(t.start_epoch) : "",
      facets_json: jsonCompact(t.facets),
    });
  }
  for (const [sid, ex] of Object.entries(existing)) {
    if (seen.has(sid)) continue;
    if ((ex.total_cost_usd || "").trim()) with_cost += 1;
    const r = {};
    for (const c of COLS) r[c] = ex[c] || "";
    rows.push(r);
  }
  // Python sorts by timestamp string, reverse=True, stable sort.
  stableSort(rows, (a, b) => {
    const av = a.timestamp || "";
    const bv = b.timestamp || "";
    return av < bv ? 1 : av > bv ? -1 : 0;
  });
  const out_lines = [HEADER];
  for (const r of rows) {
    out_lines.push(COLS.map((c) => _csv_field(c in r ? r[c] : "")).join(","));
  }
  fs.writeFileSync(STATS_CSV, out_lines.join("\n") + "\n", "utf-8");
  print(JSON.stringify({ sessions: rows.length, with_cost, no_cost: rows.length - with_cost }));
}

function stableSort(arr, cmp) {
  const indexed = arr.map((v, i) => [v, i]);
  indexed.sort((a, b) => {
    const c = cmp(a[0], b[0]);
    return c !== 0 ? c : a[1] - b[1];
  });
  for (let i = 0; i < arr.length; i++) arr[i] = indexed[i][0];
}

// ---- report: numeric helpers ----

function _fnum(v) {
  if (v === null || v === undefined || v === "") return 0.0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0.0 : f;
}

function _inum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0 : Math.trunc(f);
}

function _percentile(sorted_vals, p) {
  if (!sorted_vals.length) return 0.0;
  const k = (sorted_vals.length - 1) * p;
  const f = Math.floor(k);
  const c = Math.ceil(k);
  if (f === c) return Number(sorted_vals[Math.trunc(k)]);
  return sorted_vals[f] * (c - k) + sorted_vals[c] * (k - f);
}

function _abbr(n) {
  n = Number(n || 0);
  for (const [u, div] of [["b", 1e9], ["m", 1e6], ["k", 1e3]]) {
    if (Math.abs(n) >= div) return fixed(n / div, 1) + u;
  }
  return fixed(n, 0);
}

function _render_suggestions(sg) {
  if (!sg) {
    return (
      "<p class='muted'>Run <code>/improve-insights</code> for the pipeline " +
      "improvement roadmap (capture → schema → aggregation → visualization).</p>"
    );
  }
  const badge = { available: "var(--ac)", partial: "#c98a1c", idea: "#5b6cc4" };
  const rows = sg
    .map(
      (s) =>
        `<div class='sg'><span class='sg-b' style='background:${badge[s.status] || "var(--ink-faint)"}'>` +
        `${esc(s.status)}</span><span class='sg-a'>${esc(s.area)}</span>` +
        `<span class='sg-t'>${esc(s.text)}</span></div>`
    )
    .join("");
  return `<div class='sgs'>${rows}</div>`;
}

const IMPROVE_PY = _sibling_skill("improve-insights", "improve.mjs");

function _fetch_roadmap() {
  if (!isFile(IMPROVE_PY)) return null;
  try {
    const out = execFileSync(process.execPath, [IMPROVE_PY, "roadmap", "--json"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 60000,
      encoding: "utf-8",
    });
    const data = JSON.parse(out);
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ---- report (HTML) ----

export function _load_stats() {
  const days = {};
  const months = {};
  const per_model = {};
  const totals = {
    sessions: 0, cost: 0.0, in: 0, out: 0, cr: 0, cc: 0,
    dur: 0, api: 0, la: 0, lr: 0, turns: 0, tools: 0,
  };
  const distinct_models = new Set();
  const sessions = [];
  const usage = { tools: {}, tool_errors: 0, agents: {}, skills: {}, compactions: 0 };
  const projects = {};
  const text = fs.readFileSync(STATS_CSV, "utf-8");
  for (const row of dictReader(text)) {
    const ts = (row.timestamp || "").trim();
    if (ts === "timestamp" || (row.total_cost_usd || "").trim() === "total_cost_usd") continue;
    const sid = (row.session_id || "").trim();
    const cost = _fnum(row.total_cost_usd);
    const model = (row.last_model || "").trim();
    const i = _inum(row.input_tokens);
    const o = _inum(row.output_tokens);
    const cr = _inum(row.cache_read_tokens);
    const cc = _inum(row.cache_creation_tokens);
    const dur = _inum(row.duration_ms);
    const api = _inum(row.api_duration_ms);
    const la = _inum(row.lines_added);
    const lr = _inum(row.lines_removed);
    const r5 = _fnum(row.rl_5h_pct);
    const r7 = _fnum(row.rl_7d_pct);
    const turns = _inum(row.turns);
    const tools = _inum(row.tool_calls);
    const tok = i + o + cr + cc;
    totals.sessions += 1;
    for (const [kk, vv] of [
      ["cost", cost], ["in", i], ["out", o], ["cr", cr], ["cc", cc],
      ["dur", dur], ["api", api], ["la", la], ["lr", lr],
      ["turns", turns], ["tools", tools],
    ]) {
      totals[kk] += vv;
    }
    if (model) {
      distinct_models.add(model);
      const m =
        per_model[model] ||
        (per_model[model] = { sessions: 0, cost: 0.0, tokens: 0, in: 0, out: 0, cr: 0, cc: 0 });
      m.sessions += 1;
      m.cost += cost;
      m.tokens += tok;
      m.in += i;
      m.out += o;
      m.cr += cr;
      m.cc += cc;
    }
    for (const [key, bucket] of [[ts.slice(0, 10), days], [ts.slice(0, 7), months]]) {
      if (!key) continue;
      const d =
        bucket[key] ||
        (bucket[key] = {
          sessions: 0, cost: 0.0, in: 0, out: 0, cr: 0, cc: 0,
          models: new Set(), cost_by_model: {},
        });
      d.sessions += 1;
      d.cost += cost;
      d.in += i;
      d.out += o;
      d.cr += cr;
      d.cc += cc;
      if (model) d.models.add(model);
      if (cost) {
        const mk = model || "others";
        d.cost_by_model[mk] = (d.cost_by_model[mk] || 0.0) + cost;
      }
    }
    const dt = parseDateTime(ts);
    sessions.push({
      ts, sid, cost, model, in: i, out: o, cr, cc, tok,
      dur, api, la, lr, rl5: r5, rl7: r7, turns, tools,
      hour: dt ? dt.getHours() : null,
      dow: dt ? jsWeekdayPy(dt) : null,
      facets: null,
    });
    const fj = row.facets_json;
    if (fj) {
      let fc;
      try {
        fc = JSON.parse(fj);
      } catch {
        fc = null;
      }
      sessions[sessions.length - 1].facets = fc;
      if (fc) {
        for (const kk of ["tools", "agents", "skills"]) {
          for (const [nm, n] of Object.entries(fc[kk] || {})) {
            usage[kk][nm] = (usage[kk][nm] || 0) + n;
          }
        }
        usage.tool_errors += _inum(fc.tool_errors);
        usage.compactions += _inum(fc.compactions);
        const proj = (fc.cwd || "").trim() || "unknown";
        const pp = projects[proj] || (projects[proj] = { sessions: 0, cost: 0.0 });
        pp.sessions += 1;
        pp.cost += cost;
      }
    }
  }
  // sessions.sort(key=lambda s: s["cost"], reverse=True) — Python stable sort.
  stableSort(sessions, (a, b) => b.cost - a.cost);
  return {
    days, months, per_model, totals,
    models: Array.from(distinct_models).sort(),
    sessions, usage, projects,
  };
}

function parseDateTime(ts) {
  // datetime.strptime(ts, "%Y-%m-%d %H:%M:%S") — strict; returns null on mismatch.
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(ts);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
}

function jsWeekdayPy(d) {
  // Python datetime.weekday(): Mon=0..Sun=6. JS getDay(): Sun=0..Sat=6.
  return (d.getDay() + 6) % 7;
}

function cmd_report() {
  if (!isFile(STATS_CSV)) {
    print(`stats.csv not found at ${STATS_CSV}. Run \`node ${SCRIPT} backfill\` first.`);
    process.exit(1);
  }
  const c = _load_stats();
  let html_doc = _render(c);
  html_doc = _inject_jump_nav(html_doc);
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const out = path.join(REPORTS_DIR, `report-${reportStamp(new Date())}.html`);
  fs.writeFileSync(out, html_doc, "utf-8");
  try {
    fs.chmodSync(out, 0o600);
  } catch {
    /* ignore */
  }
  print(String(out));
  _open_report(out);
}

function reportStamp(d) {
  return (
    d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) +
    "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds())
  );
}

function _open_report(p) {
  try {
    const name = process.env.INSIGHTS_BROWSER;
    let cmd, cmdArgs;
    if (process.platform === "win32") {
      cmd = "cmd";
      cmdArgs = name ? ["/c", "start", "", name, p] : ["/c", "start", "", p];
    } else if (process.platform === "darwin") {
      cmd = "open";
      cmdArgs = name ? ["-a", name, p] : [p];
    } else {
      cmd = name || "xdg-open";
      cmdArgs = [p];
    }
    execFileSync(cmd, cmdArgs, { stdio: "ignore" });
  } catch {
    /* best-effort */
  }
}

function _build_sessions_json(sessions) {
  const out = [];
  for (const s of sessions) {
    const d = {
      ts: s.ts, sid: s.sid, cost: s.cost, model: s.model,
      in: s.in, out: s.out, cr: s.cr, cc: s.cc, tok: s.tok,
      dur: s.dur, api: s.api, la: s.la, lr: s.lr,
      r5: s.rl5, r7: s.rl7,
      turns: s.turns, tools: s.tools, hour: s.hour, dow: s.dow,
    };
    const fc = s.facets;
    if (fc) {
      const f = {};
      if (fc.tools && Object.keys(fc.tools).length) f.t = fc.tools;
      if (fc.agents && Object.keys(fc.agents).length) f.a = fc.agents;
      if (fc.skills && Object.keys(fc.skills).length) f.s = fc.skills;
      const ce = _inum(fc.compactions);
      const te = _inum(fc.tool_errors);
      if (ce) f.ce = ce;
      if (te) f.te = te;
      const cwd = (fc.cwd || "").trim();
      if (cwd) f.cwd = cwd;
      if (Object.keys(f).length) d.facets = f;
    }
    out.push(d);
  }
  return out;
}

const _CFG_JS = `const CFG = {
  PALETTE: ["var(--ac)", "#2f8fb0", "#5b6cc4", "#8a5cc2", "#c98a1c", "#c2566e", "#6b7a8a", "#3aa6a0"],
  TOKEN: [{name:"input",key:"in",col:"#5b6cc4"},{name:"output",key:"out",col:"var(--ac)"},{name:"cache_read",key:"cr",col:"#2f8fb0"},{name:"cache_creation",key:"cc",col:"#c98a1c"}],
  HEAT: ["transparent","color-mix(in srgb,var(--ac) 22%,transparent)","color-mix(in srgb,var(--ac) 45%,transparent)","color-mix(in srgb,var(--ac) 70%,transparent)","var(--ac)"],
  LINE_COV: 0.05,
  PRESETS: [{id:"7d",label:"Last 7 days",days:7},{id:"30d",label:"Last 30 days",days:30},{id:"all",label:"All time"}]
};
`;

const _RANGE_CSS = `
.range-bar{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:14px 0 0;padding:10px 14px;background:var(--surface);border:1px solid var(--line);border-radius:8px;font-family:var(--mono);font-size:12px}
.range-bar .filter-lbl{color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase;font-size:11px;margin-right:2px}
.range-preset{font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-soft);background:transparent;border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.range-preset:hover{border-color:var(--ink-faint);color:var(--ink)}
.range-preset.active{background:var(--ac);color:#fff;border-color:var(--ac)}
.range-bar input[type=date]{font-family:var(--mono);font-size:12px;color:var(--ink);background:var(--surface-2);border:1px solid var(--line);border-radius:6px;padding:4px 8px}
.range-bar .sep{color:var(--ink-faint);padding:0 2px}
`;

const _JS_MODULE = String.raw`'use strict';
// ---- fmt helpers ----
function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML;}
function escAttr(s){return esc(s).replace(/'/g,'&#39;').replace(/"/g,'&#34;');}
function fmtMoney(n){return '$'+(n||0).toFixed(2);}
function fmtMoney3(n){return '$'+(n||0).toFixed(3);}
function fmtInt(n){return Math.round(n||0).toLocaleString('en-US');}
function fmtAbbr(n){n=+n||0;var u=[['b',1e9],['m',1e6],['k',1e3]];for(var i=0;i<u.length;i++){if(Math.abs(n)>=u[i][1])return (n/u[i][1]).toFixed(1)+u[i][0];}return (n).toFixed(0);}
function pad2(n){return String(n).padStart(2,'0');}
function el(id){return document.getElementById(id);}
function isDate(s){return typeof s==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(s);}
function jsWeekday(d){return (d.getDay()+6)%7;}  // Mon=0..Sun=6
function addDays(iso,n){var y=+iso.slice(0,4),m=+iso.slice(5,7),d=+iso.slice(8,10);var dt=new Date(y,m-1,d+n);return dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate());}

// ---- derived-stats math (client-side, embedded in the report) ----
function percentile(sv,p){if(!sv.length)return 0;var k=(sv.length-1)*p,f=Math.floor(k),c=Math.ceil(k);if(f===c)return +sv[f];return sv[f]*(c-k)+sv[c]*(k-f);}
function costDist(costs){var cs=costs.filter(function(c){return c!=null;}).slice().sort(function(a,b){return a-b;});var n=cs.length;return {mean:n?cs.reduce(function(a,b){return a+b;},0)/n:0,median:percentile(cs,0.5),p90:percentile(cs,0.9),max:n?cs[n-1]:0,n:n};}
function runRate(days){var keys=Object.keys(days).sort();if(!keys.length)return {avg:0,proj30:0,ndays:0};var last=keys.slice(-7);var s=0;last.forEach(function(k){s+=days[k].cost;});var nd=last.length||1;var avg=s/nd;return {avg:avg,proj30:avg*30,ndays:last.length};}
function pareto(costs){var cs=costs.filter(function(c){return c>0;}).sort(function(a,b){return b-a;});var tot=cs.reduce(function(a,b){return a+b;},0)||1;var cum=0,pts=[];cs.forEach(function(c,i){cum+=c;pts.push([i+1,c,cum/tot*100]);});return {top10_pct:cs.length?cs.slice(0,10).reduce(function(a,b){return a+b;},0)/tot*100:0,points:pts,n:cs.length,total:tot};}
function perModelRates(pm){var out={};for(var m in pm){var v=pm[m];var inp=v.in,cr=v.cr,tok=v.tokens,cost=v.cost;out[m]={cache_hit:(cr+inp)?cr/(cr+inp):0,cost_per_mtok:tok?cost/(tok/1e6):0,cost:cost,sessions:v.sessions};}return out;}
function bucketer(vals){var sv=vals.filter(function(v){return v>0;}).sort(function(a,b){return a-b;});if(!sv.length)return function(){return 0;};var q1=percentile(sv,0.25),q2=percentile(sv,0.5),q3=percentile(sv,0.75);return function(c){if(c<=0)return 0;if(c<=q1)return 1;if(c<=q2)return 2;if(c<=q3)return 3;return 4;};}
function spendSeries(days,lastDate){if(!lastDate)return [];var y=+lastDate.slice(0,4),m=+lastDate.slice(5,7),d=+lastDate.slice(8,10);var out=[];for(var i=29;i>=0;i--){var dt=new Date(y,m-1,d-i);var iso=dt.getFullYear()+'-'+pad2(dt.getMonth()+1)+'-'+pad2(dt.getDate());out.push((days[iso]||{}).cost||0);}return out;}
function modelColorMap(models){var cm={},i=0;models.forEach(function(m){if(m==='others')cm[m]='var(--ink-faint)';else{cm[m]=CFG.PALETTE[i%CFG.PALETTE.length];i++;}});return cm;}
function costByModel(bucket){var o={};Object.keys(bucket).forEach(function(k){var m=bucket[k].cost_by_model;var inner={};Object.keys(m).forEach(function(mm){inner[mm]=Math.round(m[mm]*1e6)/1e6;});o[k]=inner;});return o;}
function topn(d,n){n=n||12;var arr=Object.keys(d).map(function(k){return [k,d[k]];}).sort(function(a,b){return b[1]-a[1];}).slice(0,n);var o={};arr.forEach(function(x){o[x[0]]=x[1];});return o;}
function projLabel(p){if(!p||p==='unknown')return 'unknown';var parts=p.replace(/[\\/]+$/,'').split(/[\\/]/).filter(Boolean);return parts.length?parts.slice(-2).join('/'):p;}

// ---- SVG primitives ----
function svgWrap(w,h,inner,cls){return "<svg viewBox='0 0 "+w+" "+h+"' class='"+(cls||'chart')+"' xmlns='http://www.w3.org/2000/svg'>"+inner+"</svg>";}
function scaler(xmin,xmax,ymin,ymax,w,h,pad){var xr=(xmax-xmin)||1,yr=(ymax-ymin)||1;return [function(x){return pad+(x-xmin)/xr*(w-2*pad);},function(y){return h-pad-(y-ymin)/yr*(h-2*pad);}];}
function pathD(points,stroke,dash,fill,width){if(!points.length)return '';var d='M'+points.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' L');var da=dash?" stroke-dasharray='6 5'":'';return "<path d='"+d+"' fill='"+(fill||'none')+"' stroke='"+stroke+"' stroke-width='"+(width||2)+"' vector-effect='non-scaling-stroke'"+da+"/>";}
function sparkline(vals,color){if(!vals.length||Math.max.apply(null,vals)<=0)return "<svg class='spark'></svg>";var W=200,H=28,P=2;var s=scaler(0,Math.max(vals.length-1,1),0,Math.max.apply(null,vals)||1,W,H,P);return svgWrap(W,H,pathD(vals.map(function(v,i){return [s[0](i),s[1](v)];}),color,false,'none',1.5),'spark');}
function svgCumulative(days,run){
  var keys=Object.keys(days).filter(isDate).sort();
  if(!keys.length)return '<p class="muted">No data.</p>';
  var W=1000,H=300,P=44,cum=0,pts=[];
  keys.forEach(function(k,i){cum+=days[k].cost;pts.push([i,cum]);});
  var xmax=keys.length-1, proj=[];
  if(run.avg && keys.length>=1){for(var j=1;j<15;j++)proj.push([xmax+j,cum+run.avg*j]);}
  var pxmax=proj.length?(xmax+14):(xmax||1);
  var ytop=(proj.length?proj[proj.length-1][1]:cum)||1;
  var s=scaler(0,pxmax||1,0,ytop,W,H,P),fx=s[0],fy=s[1];
  var lastX=fx(xmax);
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+fmtInt(Math.round(ytop))+"</text>"+
            "<text x='"+P+"' y='"+(H-P+16)+"'>"+esc(keys[0])+"</text>";
  inner+=pathD(pts.map(function(p){return [fx(p[0]),fy(p[1])];}),'var(--ac)',false,'none',2.2);
  // $ labels on the first and last (today) green datapoints
  inner+="<text x='"+(fx(0)+8).toFixed(1)+"' y='"+(fy(pts[0][1])-6).toFixed(1)+"' fill='var(--ink-soft)'>$"+fmtInt(Math.round(pts[0][1]))+"</text>";
  inner+="<text x='"+(lastX-8).toFixed(1)+"' y='"+(fy(pts[pts.length-1][1])-6).toFixed(1)+"' text-anchor='end' fill='var(--ink-soft)'>$"+fmtInt(Math.round(pts[pts.length-1][1]))+"</text>";
  inner+="<line x1='"+lastX.toFixed(1)+"' y1='"+P+"' x2='"+lastX.toFixed(1)+"' y2='"+(H-P)+"' stroke='var(--line)' stroke-width='1' stroke-dasharray='3 3'/>";
  var todayTop=!!proj.length && (W-P-lastX)<70;
  var todayY=todayTop?(P-12):(H-P+16);
  var todayFill=todayTop?" fill='var(--ink-faint)'":"";
  inner+="<text x='"+lastX.toFixed(1)+"' y='"+todayY+"' text-anchor='middle'"+todayFill+">"+esc(keys[keys.length-1])+"</text>";
  if(proj.length){
    var projEnd=addDays(keys[keys.length-1],14);
    var allp=[[pts[pts.length-1][0],pts[pts.length-1][1]]].concat(proj);
    inner+=pathD(allp.map(function(p){return [fx(p[0]),fy(p[1])];}),'var(--ink-faint)',true,'none',2);
    inner+="<text x='"+(W-P)+"' y='"+(P-12)+"' text-anchor='end' fill='var(--ink-faint)'>proj $"+fmtInt(Math.round(proj[proj.length-1][1]))+"</text>";
    inner+="<text x='"+(W-P)+"' y='"+(H-P+16)+"' text-anchor='end' fill='var(--ink-faint)'>"+esc(projEnd)+"</text>";
  }
  return svgWrap(W,H,inner);
}
function svgScatter(S,cmap){
  var pts=S.filter(function(s){return s.tok>0&&s.cost>0;});
  if(!pts.length)return '<p class="muted">No data.</p>';
  var W=1000,H=320,P=48,xs=pts.map(function(s){return Math.log10(s.tok);}),ys=pts.map(function(s){return s.cost;});
  var s=scaler(Math.min.apply(null,xs),Math.max.apply(null,xs)||1,0,Math.max.apply(null,ys)||1,W,H,P),fx=s[0],fy=s[1];
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+Math.max.apply(null,ys).toFixed(2)+"</text>"+
            "<text x='"+(W-P)+"' y='"+(H-P+18)+"' text-anchor='end'>tokens (log) →</text>"+
            "<text x='"+P+"' y='"+(H-P+18)+"'>cost ↑</text>";
  pts.forEach(function(s){var x=fx(Math.log10(s.tok)),y=fy(s.cost);var col=cmap[s.model||'others']||'var(--ink-faint)';inner+="<circle cx='"+x.toFixed(1)+"' cy='"+y.toFixed(1)+"' r='4' fill='"+col+"' opacity='0.6'><title>"+esc(s.model||'others')+" · $"+s.cost.toFixed(2)+" · "+fmtInt(s.tok)+" tok</title></circle>";});
  return svgWrap(W,H,inner);
}
function svgPareto(par){
  var pts=par.points;if(!pts.length)return '<p class="muted">No data.</p>';
  var cap=60,bars=pts.slice(0,cap),W=1000,H=300,P=48,n=bars.length,cmax=bars.length?bars[0][1]:1;
  var s=scaler(0,Math.max(n,1),0,cmax,W,H,P),fx=s[0],fy=s[1];
  function fyp(p){return H-P-p/100*(H-2*P);}
  var bw=(W-2*P)/n*0.8;
  var inner="<line class='axis' x1='"+P+"' y1='"+(H-P)+"' x2='"+(W-P)+"' y2='"+(H-P)+"'/>"+
            "<line class='axis' x1='"+P+"' y1='"+P+"' x2='"+P+"' y2='"+(H-P)+"'/>"+
            "<text x='"+P+"' y='"+(P-12)+"'>$"+cmax.toFixed(2)+"</text>"+
            "<text x='"+(W-P)+"' y='"+(P-12)+"' text-anchor='end' fill='var(--ink-faint)'>100% cum</text>";
  bars.forEach(function(b){var rank=b[0],c=b[1];var x=fx(rank-0.5)-bw/2,y=fy(c);inner+="<rect x='"+x.toFixed(1)+"' y='"+y.toFixed(1)+"' width='"+bw.toFixed(1)+"' height='"+(H-P-y).toFixed(1)+"' fill='var(--ac)' opacity='0.55'><title>#"+rank+" · $"+c.toFixed(2)+"</title></rect>";});
  inner+=pathD(pts.slice(0,cap).map(function(b){return [fx(b[0]-0.5),fyp(b[2])];}),'var(--ink-soft)',false,'none',2);
  if(par.n>cap)inner+="<text x='"+(W-P)+"' y='"+(H-P+18)+"' text-anchor='end'>top "+cap+" of "+par.n+" sessions</text>";
  return svgWrap(W,H,inner);
}
function svgTreemap(pm,cmap){
  var items=Object.keys(pm).map(function(m){return [m,pm[m].cost];}).filter(function(x){return x[1]>0;}).sort(function(a,b){return b[1]-a[1];});
  if(!items.length)return '<p class="muted">No data.</p>';
  var W=1000,H=170,tot=items.reduce(function(a,b){return a+b[1];},0)||1,x=0,inner='';
  items.forEach(function(it){var m=it[0],c=it[1],w=c/tot*W;inner+="<rect x='"+x.toFixed(1)+"' y='0' width='"+w.toFixed(1)+"' height='"+H+"' fill='"+(cmap[m]||'var(--ink-faint)')+"' stroke='var(--surface)' stroke-width='2'><title>"+escAttr(m)+" · $"+c.toFixed(2)+" · "+(c/tot*100).toFixed(1)+"%</title></rect>";if(w>64){var label=esc(m.split('/').pop().slice(0,18));inner+="<text x='"+(x+7).toFixed(1)+"' y='22' fill='#fff' style='font-size:11px'>"+label+"</text><text x='"+(x+7).toFixed(1)+"' y='39' fill='#fff' style='font-size:11px'>$"+Math.round(c)+"</text>";}x+=w;});
  return svgWrap(W,H,inner,'treemap');
}
function calHeatmap(days){
  var dkeys=Object.keys(days).filter(isDate).sort();if(!dkeys.length)return '<p class="muted">No data.</p>';
  var d0=new Date(+dkeys[0].slice(0,4),+dkeys[0].slice(5,7)-1,+dkeys[0].slice(8,10)),d1=new Date(+dkeys[dkeys.length-1].slice(0,4),+dkeys[dkeys.length-1].slice(5,7)-1,+dkeys[dkeys.length-1].slice(8,10));
  var start=new Date(d0);start.setDate(start.getDate()-jsWeekday(d0));
  var b=bucketer(dkeys.map(function(k){return days[k].cost;}));
  var cells='',cur=new Date(start);
  while(cur<=d1){var iso=cur.getFullYear()+'-'+pad2(cur.getMonth()+1)+'-'+pad2(cur.getDate());var c=(days[iso]||{}).cost||0;var tip=iso+' · '+(c?'$'+c.toFixed(2):'—');cells+="<div class='c' style='background:"+CFG.HEAT[b(c)]+"' title='"+escAttr(tip)+"'></div>";cur.setDate(cur.getDate()+1);}
  return "<div class='heat-cal'>"+cells+"</div>";
}
function dayhourHeatmap(S){
  var grid=[];for(var d=0;d<7;d++)grid.push(new Array(24).fill(0));var seen=false;
  S.forEach(function(s){if(s.dow==null||s.hour==null)return;grid[s.dow][s.hour]+=s.cost;seen=true;});
  if(!seen)return '<p class="muted">No data.</p>';
  var b=bucketer(grid.flat());var dow=['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];var out=["<div class='hl'></div>"];
  for(var h=0;h<24;h++)out.push("<div class='hl'>"+(h%3===0?h:'')+"</div>");
  for(var d=0;d<7;d++){out.push("<div class='rl'>"+dow[d]+"</div>");for(var h=0;h<24;h++){var c=grid[d][h];var tip=dow[d]+' '+pad2(h)+':00 · '+(c?'$'+c.toFixed(2):'—');out.push("<div class='c' style='background:"+CFG.HEAT[b(c)]+"' title='"+escAttr(tip)+"'></div>");}}
  return "<div class='heat-dh'>"+out.join('')+"</div>";
}

// ---- bars / tables ----
function tokenBars(bucket,vis){
  var keys=Object.keys(bucket).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var visKeys=vis||CFG.TOKEN.map(function(tk){return tk.key;});
  var mx=0;keys.forEach(function(k){var b=bucket[k];var t=0;visKeys.forEach(function(key){t+=b[key];});if(t>mx)mx=t;});mx=mx||1;
  var rows='';keys.forEach(function(k){var b=bucket[k];var tot=0;var segs='';CFG.TOKEN.forEach(function(tk){if(visKeys.indexOf(tk.key)<0)return;var v=b[tk.key];if(v<=0)return;tot+=v;segs+="<div class='seg' style='width:"+(v/mx*100).toFixed(4)+"%;background:"+tk.col+"' data-tip='"+tk.name+" · "+fmtInt(v)+"'></div>";});rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='sbar-track'>"+segs+"</div><div class='bar-val'>"+fmtAbbr(tot)+"</div></div>";});
  return rows;
}
function barChart(counts,color,fmt,color_map){
  var keys=Object.keys(counts);if(!keys.length)return '<p class="muted">No data.</p>';
  var mx=0;keys.forEach(function(k){if(counts[k]>mx)mx=counts[k];});mx=mx||1;
  var rows='';keys.forEach(function(k){var v=counts[k];var pct=Math.max(3,Math.round(v/mx*100));var val=fmt?fmt(v):v;var bcol=color_map?(color_map[k]||color):color;rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='bar-track'><div class='bar' style='width:"+pct+"%;background:"+bcol+"'></div></div><div class='bar-val'>"+esc(val)+"</div></div>";});
  return rows;
}
function shareBars(months,cmap){
  var keys=Object.keys(months).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var rows='';keys.forEach(function(k){var cbm=months[k].cost_by_model;var tot=Object.keys(cbm).reduce(function(a,m){return a+cbm[m];},0)||1;var segs='';Object.keys(cbm).sort(function(a,b){return cbm[b]-cbm[a];}).forEach(function(m){var w=cbm[m]/tot*100;if(w<=0)return;segs+="<div class='seg' style='width:"+w.toFixed(3)+"%;background:"+(cmap[m]||'var(--ink-faint)')+"' data-tip='"+escAttr(m)+" · "+w.toFixed(1)+"%'></div>";});rows+="<div class='bar-row'><div class='bar-label'>"+esc(k)+"</div><div class='sbar-track'>"+segs+"</div><div class='bar-val'>$"+Math.round(tot)+"</div></div>";});
  return rows;
}
function periodTable(bucket,label){
  var keys=Object.keys(bucket).sort().reverse();if(!keys.length)return '<p class="muted">No data.</p>';
  var head="<tr><th>"+esc(label)+"</th><th>Sessions</th><th>Cost $</th><th>Input tok</th><th>Output tok</th><th>Cache read</th><th>Cache create</th></tr>";
  var body='',tot={sessions:0,cost:0,in:0,out:0,cr:0,cc:0};
  keys.forEach(function(k){var d=bucket[k];body+="<tr><td>"+esc(k)+"</td><td>"+d.sessions+"</td><td>"+d.cost.toFixed(2)+"</td><td>"+fmtInt(d.in)+"</td><td>"+fmtInt(d.out)+"</td><td>"+fmtInt(d.cr)+"</td><td>"+fmtInt(d.cc)+"</td></tr>";tot.sessions+=d.sessions;tot.cost+=d.cost;tot.in+=d.in;tot.out+=d.out;tot.cr+=d.cr;tot.cc+=d.cc;});
  body+="<tr class='total'><td>Total</td><td>"+tot.sessions+"</td><td>"+tot.cost.toFixed(2)+"</td><td>"+fmtInt(tot.in)+"</td><td>"+fmtInt(tot.out)+"</td><td>"+fmtInt(tot.cr)+"</td><td>"+fmtInt(tot.cc)+"</td></tr>";
  return "<table>"+head+body+"</table>";
}
function statline(items){var cells='';items.forEach(function(it){cells+="<div class='s'><div class='v'>"+esc(it[1])+"</div><div class='k'>"+esc(it[0])+"</div></div>";});return "<div class='statline'>"+cells+"</div>";}
function svgRateTrend(sessions){
  var rl=sessions.filter(function(s){return s.r5>0||s.r7>0;}).sort(function(a,b){return a.ts<b.ts?-1:a.ts>b.ts?1:0;});
  if(!rl.length)return '<p class="muted">No rate-limit data yet.</p>';
  var W=1000,H=220,P=34,n=rl.length;
  var s=scaler(0,Math.max(n-1,1),0,100,W,H,P);
  var d5=pathD(rl.map(function(s2,i){return [s[0](i),s[1](s2.r5)];}),'#2f8fb0',false,'none',2);
  var d7=pathD(rl.map(function(s2,i){return [s[0](i),s[1](s2.r7)];}),'var(--ac)',false,'none',2);
  var th80=pathD([[s[0](0),s[1](80)],[s[0](n-1),s[1](80)]],'var(--ink-soft)',true,'none',1);
  var ceiling=pathD([[s[0](0),s[1](100)],[s[0](n-1),s[1](100)]],'var(--ink-faint)',false,'none',0.6);
  var leg="<div class='legend' style='margin:6px 0'><span class='lg-item'><span class='lg-swatch' style='background:#2f8fb0'></span>5h window</span><span class='lg-item'><span class='lg-swatch' style='background:var(--ac)'></span>7d window</span></div>";
  return leg+svgWrap(W,H,ceiling+th80+d5+d7,'chart');
}
function renderRateLimits(sessions){
  var rl=sessions.filter(function(s){return s.r5>0||s.r7>0;});
  if(!rl.length)return "<p class='muted'>Rate-limit tracking fills as sessions record (forward-only, Claude.ai Pro/Max only).</p>";
  var r5s=rl.map(function(s){return s.r5;}),r7s=rl.map(function(s){return s.r7;});
  var avg=function(a){return a.reduce(function(x,y){return x+y;},0)/a.length;};
  var maxA=function(a){return Math.max.apply(null,a);};
  var nearCap=rl.filter(function(s){return s.r5>=80||s.r7>=80;}).length;
  var capped=rl.filter(function(s){return s.r5>=99.5||s.r7>=99.5;}).length;
  var peak7=maxA(r7s)||1;
  var rlCost=rl.reduce(function(x,s){return x+s.cost;},0);
  var $per7pt=peak7>0?(rlCost/peak7):0;
  return svgRateTrend(sessions)+statline([
    ["5h avg %",avg(r5s).toFixed(1)],
    ["5h peak %",maxA(r5s).toFixed(1)],
    ["7d avg %",avg(r7s).toFixed(1)],
    ["7d peak %",maxA(r7s).toFixed(1)],
    ["near-cap (>80%)",fmtInt(nearCap)],
    ["capped (100%)",fmtInt(capped)],
    ["$/7d%-pt at peak",fmtMoney($per7pt)]
  ]);
}
function perModelEfficiency(rates,days,cmap){
  var keys=Object.keys(rates);if(!keys.length)return '<p class="muted">No data.</p>';
  var dkeys=Object.keys(days).filter(isDate).sort();
  var arr=keys.map(function(m){return [m,rates[m]];}).sort(function(a,b){return b[1].cost-a[1].cost;});
  var cards='';arr.forEach(function(x){var m=x[0],v=x[1];var series=dkeys.map(function(k){return (days[k].cost_by_model||{})[m]||0;});var spark=sparkline(series,cmap[m]||'var(--ac)');cards+="<div class='eff'><div class='nm'><span class='lg-swatch' style='background:"+(cmap[m]||'var(--ink-faint)')+";margin-right:6px'></span>"+esc(m)+"</div><div class='row'><span>cache hit</span><span>"+Math.round(v.cache_hit*100)+"%</span></div><div class='row'><span>$/1M tok</span><span>$"+v.cost_per_mtok.toFixed(2)+"</span></div><div class='row'><span>cost</span><span>$"+v.cost.toFixed(2)+"</span></div>"+spark+"</div>";});
  return "<div class='eff-grid'>"+cards+"</div>";
}
function topTable(sessions){
  var top=sessions.slice(0,10);var rows='';top.forEach(function(s){rows+="<tr><td>"+esc(s.ts)+"</td><td class='mono'>"+esc(s.sid.slice(0,8))+"</td><td class='num'>"+s.cost.toFixed(2)+"</td><td>"+esc(s.model||'-')+"</td><td class='num'>"+fmtInt(s.tok)+"</td></tr>";});
  return "<table><thead><tr><th>Timestamp</th><th>Session</th><th class='num'>Cost $</th><th>Model</th><th class='num'>Tokens</th></tr></thead><tbody>"+rows+"</tbody></table>";
}

// ---- aggregate ----
function aggregate(S){
  var t={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,dur:0,api:0,la:0,lr:0,turns:0,tools:0};
  var days={},months={},per_model={},models=[],modelSet={};
  var usage={tools:{},tool_errors:0,agents:{},skills:{},compactions:0},projects={};
  for(var i=0;i<S.length;i++){
    var s=S[i];
    t.sessions++;t.cost+=s.cost;t.in+=s.in;t.out+=s.out;t.cr+=s.cr;t.cc+=s.cc;t.dur+=s.dur;t.api+=s.api;t.la+=s.la;t.lr+=s.lr;t.turns+=s.turns;t.tools+=s.tools;
    if(s.model){if(!modelSet[s.model]){modelSet[s.model]=1;models.push(s.model);}var pm=per_model[s.model]||(per_model[s.model]={sessions:0,cost:0,tokens:0,in:0,out:0,cr:0,cc:0});pm.sessions++;pm.cost+=s.cost;pm.tokens+=s.tok;pm.in+=s.in;pm.out+=s.out;pm.cr+=s.cr;pm.cc+=s.cc;}
    var dk=s.ts.slice(0,10),mk=s.ts.slice(0,7);
    if(dk){var dd=days[dk]||(days[dk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,cost_by_model:{}});dd.sessions++;dd.cost+=s.cost;dd.in+=s.in;dd.out+=s.out;dd.cr+=s.cr;dd.cc+=s.cc;if(s.cost){var mm=s.model||'others';dd.cost_by_model[mm]=(dd.cost_by_model[mm]||0)+s.cost;}}
    if(mk){var mo=months[mk]||(months[mk]={sessions:0,cost:0,in:0,out:0,cr:0,cc:0,cost_by_model:{}});mo.sessions++;mo.cost+=s.cost;mo.in+=s.in;mo.out+=s.out;mo.cr+=s.cr;mo.cc+=s.cc;if(s.cost){var mm2=s.model||'others';mo.cost_by_model[mm2]=(mo.cost_by_model[mm2]||0)+s.cost;}}
    var fc=s.facets;
    if(fc){
      if(fc.t){for(var nm in fc.t){usage.tools[nm]=(usage.tools[nm]||0)+fc.t[nm];}}
      if(fc.a){for(var nm2 in fc.a){usage.agents[nm2]=(usage.agents[nm2]||0)+fc.a[nm2];}}
      if(fc.s){for(var nm3 in fc.s){usage.skills[nm3]=(usage.skills[nm3]||0)+fc.s[nm3];}}
      usage.tool_errors+=fc.te||0;usage.compactions+=fc.ce||0;
      var cwd=fc.cwd||'unknown';var p=projects[cwd]||(projects[cwd]={sessions:0,cost:0});p.sessions++;p.cost+=s.cost;
    }
  }
  models.sort();
  var ss=S.slice().sort(function(a,b){return b.cost-a.cost;});
  return {totals:t,days:days,months:months,per_model:per_model,models:models,sessions:ss,n:S.length,usage:usage,projects:projects};
}
function deriveStats(agg,range){
  var t=agg.totals,costs=agg.sessions.map(function(s){return s.cost;});
  var loc=0,lineSessions=0,locCost=0,activeDurMs=0,activeCost=0;
  agg.sessions.forEach(function(s){loc+=s.la+s.lr;if(s.la+s.lr>0){lineSessions++;locCost+=s.cost;}if(s.cost>0){activeDurMs+=s.dur;activeCost+=s.cost;}});
  return {dist:costDist(costs),run:runRate(agg.days),pareto:pareto(costs),rates:perModelRates(agg.per_model),series:spendSeries(agg.days,range.to),cacheHit:(t.cr+t.in)?t.cr/(t.cr+t.in):0,loc:loc,lineSessions:lineSessions,locCost:locCost,lineCov:agg.n?lineSessions/agg.n:0,activeDurHr:activeDurMs/3.6e6,activeCost:activeCost};
}
function filterSessions(range){return SESSIONS.filter(function(s){var d=s.ts.slice(0,10);return d>=range.from && d<=range.to;});}

// ---- hero ----
function renderHero(agg,st,firstDate){
  var t=agg.totals,fromNote='from '+firstDate;
  var lineVal=(st.loc&&st.lineCov>=CFG.LINE_COV)?fmtMoney3(st.locCost/st.loc):'—';
  var lineSub=st.loc?(fmtInt(st.loc)+' lines · '+Math.round(st.lineCov*100)+'% coverage'):fromNote;
  var hourVal=st.activeDurHr?fmtMoney(st.activeCost/st.activeDurHr):'—';
  var hourSub=st.activeDurHr?(st.activeDurHr.toFixed(1)+'h active'):fromNote;
  var lineTip="$/line = cost of line-bearing sessions / total lines changed. Shown only when line coverage >= "+(CFG.LINE_COV*100).toFixed(0)+"% of sessions; lines_added/lines_removed are forward-only statusline columns, so older sessions have 0 lines and would inflate the value. Coverage now "+Math.round(st.lineCov*100)+"% ("+st.lineSessions+"/"+agg.n+").";
  var hourTip="$/hour = cost of $0-cost-excluded sessions / active hours (sum of per-session duration, uncapped). duration_ms is the transcript wall-clock span (first->last event), so sessions left open for days (idle/hung, e.g. 577h @ $0) are excluded by the $0-cost filter. Long-but-real sessions count fully.";
  var spendTip="Sum of total_cost_usd across all sessions in range.";
  function kpi(cls,big,lbl,sub,tip){return "<div class='"+cls+"' title='"+escAttr(tip)+"'><div class='big'>"+esc(big)+"</div><div class='lbl'>"+esc(lbl)+"</div><div class='sub2'>"+esc(sub)+"</div></div>";}
  var heroMain="<div class='kpi lead hero-main' title='"+escAttr(spendTip)+"'><div class='hero-num'>"+esc(fmtMoney(t.cost))+"</div><div class='lbl'>total spend</div><div class='sub2'>"+esc(fromNote)+"</div></div>";
  var heroSpark="<div class='hero-spark' title='"+escAttr('Daily spend, trailing 30 days of range.')+"'>"+sparkline(st.series,'var(--ac)')+"<div class='sub2'>last 30 days</div></div>";
  var hero="<div class='hero'><div class='hero-left'>"+heroMain+heroSpark+"</div><div class='hero-eff'>"+kpi('kpi sec',hourVal,'$/hour',hourSub,hourTip)+kpi('kpi sec',lineVal,'$/line',lineSub,lineTip)+"</div></div>";
  var apiPct=t.dur?(t.api/t.dur*100):0;
  var supp=[["sessions",fmtInt(agg.n),"recorded","Rows in stats.csv (one per session)."],["output tok",fmtAbbr(t.out),fmtAbbr(t.in)+" input","Output vs input tokens across all sessions."],["cache hit",Math.round(st.cacheHit*100)+"%","read / (read+input)","cache_read / (cache_read + input) — higher means less re-processed context."],["API time",t.dur?(apiPct.toFixed(0)+'%'):'—',t.dur?'of wall-clock':fromNote,"api_duration_ms / duration_ms — share of wall-clock spent on API calls."],["models",String(agg.models.length),"distinct","Distinct last_model values across sessions."]];
  var suppHtml='';supp.forEach(function(s){suppHtml+="<div class='supp' title='"+escAttr(s[3])+"'><span class='v'>"+esc(s[1])+"</span><span class='k'>"+esc(s[0])+"</span><span class='d'>"+esc(s[2])+"</span></div>";});
  return hero+"<div class='supp-strip'>"+suppHtml+"</div>";
}

// ---- render ----
function render(range){
  var S=filterSessions(range);
  var agg=aggregate(S);
  if(!agg.n){var msg='<p class="muted">No sessions in selected range.</p>';['kpi','sec-cumulative','sec-runrate','sec-cal','day-chart','month-chart','day-table','month-table','tok-day-bars','tok-month-bars','tok-mix','cc-ratio','sec-eff-models','sec-throughput','sec-ratelimits','sec-dayhour','sec-scatter','sec-pareto','sec-toptable','sec-treemap','sec-model-sessions','sec-model-cost','sec-share','sec-usage-stats','sec-tools','sec-agents','sec-skills','sec-proj-cost','sec-proj-sess'].forEach(function(id){var e=el(id);if(e)e.innerHTML=msg;});el('tok-legend').innerHTML='';return;}
  var st=deriveStats(agg,range),t=agg.totals;
  var chartModels=agg.models.slice();
  var hasOthers=Object.keys(agg.days).some(function(k){return 'others' in agg.days[k].cost_by_model;})||Object.keys(agg.months).some(function(k){return 'others' in agg.months[k].cost_by_model;});
  if(hasOthers)chartModels.push('others');
  var cmap=modelColorMap(chartModels);
  CHART={day:costByModel(agg.days),month:costByModel(agg.months),models:chartModels,colors:cmap};
  // hero
  el('kpi').innerHTML=renderHero(agg,st,FIRST_DATE);
  // spend over time
  el('sec-cumulative').innerHTML=svgCumulative(agg.days,st.run);
  el('sec-runrate').innerHTML=statline([["avg / day (last "+st.run.ndays+"d)",fmtMoney(st.run.avg)],["projected 30d",fmtMoney(st.run.proj30)],["total to date",fmtMoney(t.cost)]]);
  el('sec-cal').innerHTML=calHeatmap(agg.days);
  // breakdown
  _draw();
  el('day-table').innerHTML=periodTable(agg.days,'Date');
  el('month-table').innerHTML=periodTable(agg.months,'Month');
  // token economics (legend pills filter the composition bars)
  CUR_AGG=agg;renderTok();
  var totTok=t.in+t.out+t.cr+t.cc;
  el('tok-mix').innerHTML=statline(CFG.TOKEN.map(function(tk){var v=t[tk.key];var pct=totTok?(v/totTok*100):0;return [tk.name,Math.round(pct)+"%"];}));
  var ccWaste={};Object.keys(agg.days).forEach(function(k){var d=agg.days[k];ccWaste[k]=d.cr?(d.cc/d.cr):0;});
  el('cc-ratio').innerHTML=barChart(ccWaste,'var(--ink-soft)',function(v){return v.toFixed(2);});
  // efficiency
  el('sec-eff-models').innerHTML=perModelEfficiency(st.rates,agg.days,cmap);
  el('sec-throughput').innerHTML=statline([
    ["turns / session",agg.n?(t.turns/agg.n).toFixed(1):'—'],
    ["tools / session",agg.n?(t.tools/agg.n).toFixed(1):'—'],
    ["lines / session",(st.loc&&agg.n)?(st.loc/agg.n).toFixed(0):'—'],
    ["lines / hour",(st.loc&&st.activeDurHr)?(st.loc/st.activeDurHr).toFixed(0):'—'],
    ["churn (del/add)",t.la?(t.lr/t.la).toFixed(2):'—'],
    ["median $/session",fmtMoney(st.dist.median)],
    ["p90 $/session",fmtMoney(st.dist.p90)],
    ["max $/session",fmtMoney(st.dist.max)]
  ]);
  // rate-limit utilization (5h / 7d) — forward-only, Claude.ai Pro/Max only
  el('sec-ratelimits').innerHTML=renderRateLimits(agg.sessions);
  // when you work
  el('sec-dayhour').innerHTML=dayhourHeatmap(agg.sessions);
  // sessions
  el('sec-scatter').innerHTML=svgScatter(agg.sessions,cmap);
  el('sec-pareto').innerHTML=svgPareto(st.pareto);
  el('sec-pareto-title').textContent="Pareto · top-10 sessions = "+Math.round(st.pareto.top10_pct)+"% of spend";
  el('sec-toptable').innerHTML=topTable(agg.sessions);
  // models
  el('sec-treemap').innerHTML=svgTreemap(agg.per_model,cmap);
  var modelSessions={},modelCost={};Object.keys(agg.per_model).forEach(function(m){modelSessions[m]=agg.per_model[m].sessions;modelCost[m]=agg.per_model[m].cost;});
  el('sec-model-sessions').innerHTML=barChart(modelSessions,'var(--ink-soft)',null,cmap);
  el('sec-model-cost').innerHTML=barChart(modelCost,'var(--ac)',function(v){return fmtMoney(v);},cmap);
  el('sec-share').innerHTML=shareBars(agg.months,cmap);
  // usage patterns
  var totTool=0;Object.keys(agg.usage.tools).forEach(function(k){totTool+=agg.usage.tools[k];});
  var errRate=totTool?(agg.usage.tool_errors/totTool*100):0;
  el('sec-usage-stats').innerHTML=statline([["tool calls",fmtInt(totTool)],["tool errors",fmtInt(agg.usage.tool_errors)],["error rate",errRate.toFixed(1)+"%"],["compactions",fmtInt(agg.usage.compactions)],["subagent types",String(Object.keys(agg.usage.agents).length)],["skills used",String(Object.keys(agg.usage.skills).length)]]);
  el('sec-tools').innerHTML=barChart(topn(agg.usage.tools),'var(--ink-soft)',function(v){return fmtInt(v);});
  el('sec-agents').innerHTML=barChart(topn(agg.usage.agents),'#5b6cc4',function(v){return fmtInt(v);});
  el('sec-skills').innerHTML=barChart(topn(agg.usage.skills,20),'#8a5cc2',function(v){return fmtInt(v);});
  // projects
  var projCost={},projSess={};Object.keys(agg.projects).forEach(function(k){var lbl=projLabel(k);projCost[lbl]=(projCost[lbl]||0)+agg.projects[k].cost;projSess[lbl]=(projSess[lbl]||0)+agg.projects[k].sessions;});
  el('sec-proj-cost').innerHTML=barChart(topn(projCost,15),'var(--ac)',function(v){return fmtMoney(v);});
  el('sec-proj-sess').innerHTML=barChart(topn(projSess,15),'var(--ink-soft)',function(v){return fmtInt(v);});
}

// ---- controls ----
function loadRange(){
  try{var r=JSON.parse(localStorage.getItem('show-insights.range')||'null');if(r&&isDate(r.from)&&isDate(r.to)&&r.from<=r.to){r.preset=r.preset||null;return r;}}catch(e){}
  return {from:FIRST_DATE,to:LAST_DATE,preset:'all'};
}
function persistRange(r){try{localStorage.setItem('show-insights.range',JSON.stringify(r));}catch(e){}}
function setActivePreset(id){document.querySelectorAll('.range-preset').forEach(function(b){b.className=b.dataset.p===id?'range-preset active':'range-preset';});}
function applyPreset(id){
  var from,to=LAST_DATE;
  if(id==='7d')from=addDays(LAST_DATE,-6);
  else if(id==='30d')from=addDays(LAST_DATE,-29);
  else from=FIRST_DATE;
  var range={from:from,to:to,preset:id};
  el('from').value=from;el('to').value=to;persistRange(range);setActivePreset(id);render(range);
}
function onDateChange(){
  var from=el('from').value,to=el('to').value;
  if(from&&to&&from>to){var tmp=from;from=to;to=tmp;el('from').value=from;el('to').value=to;}
  var range={from:from||FIRST_DATE,to:to||LAST_DATE,preset:null};
  persistRange(range);setActivePreset(null);render(range);
}
function initControls(range){
  var bar=el('rangeBar'),html='<span class="filter-lbl">Range</span>';
  CFG.PRESETS.forEach(function(p){html+="<button class='range-preset"+(p.id===range.preset?' active':'')+"' data-p='"+p.id+"'>"+p.label+"</button>";});
  html+="<input type='date' id='from' min='"+FIRST_DATE+"' max='"+LAST_DATE+"' value='"+range.from+"'><span class='sep'>→</span><input type='date' id='to' min='"+FIRST_DATE+"' max='"+LAST_DATE+"' value='"+range.to+"'>";
  bar.innerHTML=html;
  bar.querySelectorAll('.range-preset').forEach(function(b){b.onclick=function(){applyPreset(b.dataset.p);};});
  el('from').onchange=onDateChange;el('to').onchange=onDateChange;
}

// ---- model-filter (breakdown bars only) ----
var CHART={},ACTIVE=new Set();
function _fmt(v){return '$'+v.toFixed(2);}
function _vis(){return ACTIVE.size?ACTIVE:new Set(CHART.models);}
function _chart(target,data){
  var vis=_vis(),keys=Object.keys(data).sort().reverse(),totals={},mx=0;
  keys.forEach(function(k){var t=0;Object.keys(data[k]).forEach(function(m){if(vis.has(m))t+=data[k][m];});totals[k]=t;if(t>mx)mx=t;});
  mx=mx||1;var h='',any=false;
  keys.forEach(function(k){var t=totals[k];if(t<=0)return;any=true;var segs='';
    CHART.models.forEach(function(m){if(!vis.has(m))return;var c=data[k][m]||0;if(c<=0)return;segs+='<div class="seg" style="width:'+(c/mx*100).toFixed(4)+'%;background:'+CHART.colors[m]+'" data-tip="'+m+' · '+_fmt(c)+'"></div>';});
    h+='<div class="bar-row"><div class="bar-label">'+k+'</div><div class="sbar-track">'+segs+'</div><div class="bar-val">'+_fmt(t)+'</div></div>';
  });
  target.innerHTML=any?h:'<p class="muted">No data for selected models.</p>';
}
function _legend(){
  var filtered=ACTIVE.size>0,target=el('model-filter');
  target.innerHTML=CHART.models.map(function(m){var off=filtered&&!ACTIVE.has(m)?' off':'';return '<button class="lg-item'+off+'" data-m="'+m+'"><span class="lg-swatch" style="background:'+CHART.colors[m]+'"></span>'+m+'</button>';}).join('')+'<button class="lg-all'+(filtered?'':' active')+'">All</button>';
  target.querySelectorAll('button[data-m]').forEach(function(b){b.onclick=function(){_toggle(b.dataset.m);};});
  target.querySelector('.lg-all').onclick=function(){ACTIVE=new Set();_draw();};
}
function _toggle(m){if(ACTIVE.has(m))ACTIVE.delete(m);else ACTIVE.add(m);_draw();}
function _draw(){_legend();_chart(el('day-chart'),CHART.day);_chart(el('month-chart'),CHART.month);}

// ---- token-legend filter (token composition bars) ----
// SEMANTIC IS SOLO/DESELECT, NOT independent show/hide — confirmed correct, do NOT "fix":
//   empty TOK_ACTIVE = all series visible (default); click a pill = solo it (set adds key,
//   others get .off); click again = remove from set; emptied set or All = back to all-visible.
// Empty-means-all makes independent per-pill toggle impossible without extra base-state.
// tokVis MUST return Array.from(TOK_ACTIVE) (a Set crashes tokenBars on .indexOf).
var TOK_ACTIVE=new Set(),CUR_AGG=null;
function tokVis(){return TOK_ACTIVE.size?Array.from(TOK_ACTIVE):CFG.TOKEN.map(function(tk){return tk.key;});}
function renderTokLegend(){
  var filtered=TOK_ACTIVE.size>0,target=el('tok-legend');
  target.innerHTML=CFG.TOKEN.map(function(tk){var off=filtered&&!TOK_ACTIVE.has(tk.key)?' off':'';return '<button class="lg-item'+off+'" data-k="'+tk.key+'"><span class="lg-swatch" style="background:'+tk.col+'"></span>'+tk.name+'</button>';}).join('')+'<button class="lg-all'+(filtered?'':' active')+'">All</button>';
  target.querySelectorAll('button[data-k]').forEach(function(b){b.onclick=function(){_toggleTok(b.dataset.k);};});
  target.querySelector('.lg-all').onclick=function(){TOK_ACTIVE=new Set();renderTok();};
}
function _toggleTok(k){if(TOK_ACTIVE.has(k))TOK_ACTIVE.delete(k);else TOK_ACTIVE.add(k);renderTok();}
function renderTok(){
  renderTokLegend();
  if(!CUR_AGG)return;
  var vis=tokVis();
  el('tok-day-bars').innerHTML=tokenBars(CUR_AGG.days,vis);
  el('tok-month-bars').innerHTML=tokenBars(CUR_AGG.months,vis);
}

// ---- view + theme toggles ----
function show(v){
  el('day-view').style.display=v==='day'?'':'none';
  el('month-view').style.display=v==='month'?'':'none';
  el('btn-day').className=v==='day'?'active':'';
  el('btn-month').className=v==='month'?'active':'';
  try{localStorage['show-insights.view']=v;}catch(e){}
}
function showTok(v){
  el('tok-day').style.display=v==='day'?'':'none';
  el('tok-month').style.display=v==='month'?'':'none';
  el('tbtn-day').className=v==='day'?'active':'';
  el('tbtn-month').className=v==='month'?'active':'';
}
function __lbl(t){el('theme-tgl').innerHTML=t==='dark'?'&#9728; Light':'&#9790; Dark';}
function __tgl(){var d=document.documentElement,n=d.dataset.theme==='dark'?'light':'dark';d.dataset.theme=n;try{localStorage.setItem('agents-report-theme',n);}catch(e){}__lbl(n);}

// ---- main ----
var FIRST_DATE,LAST_DATE;
function main(){
  var ds=SESSIONS.map(function(s){return s.ts.slice(0,10);}).filter(isDate).sort();
  FIRST_DATE=ds[0];LAST_DATE=ds[ds.length-1];
  var range=loadRange();
  initControls(range);
  render(range);
  __lbl(document.documentElement.dataset.theme);
  try{if(localStorage['show-insights.view']==='month')show('month');}catch(e){}
}
document.addEventListener('DOMContentLoaded',main);
`;

function _render(c) {
  const secs = _build_sessions_json(c.sessions);
  const sessions_json = JSON.stringify(secs);
  const roadmap_html = _render_suggestions(_fetch_roadmap());
  const gen = fmtLocal(new Date());
  const style = _STYLE + _RANGE_CSS;
  return [
    "<!DOCTYPE html>\n<html lang='en'><head><meta charset='utf-8'>",
    "<meta name='viewport' content='width=device-width, initial-scale=1'>",
    "<title>Claude Code Insights</title>",
    "<script>(function(){try{document.documentElement.dataset.theme=localStorage.getItem('agents-report-theme')||'light';}catch(e){document.documentElement.dataset.theme='light';}})();</script>",
    "<style>", style, "</style></head><body>",
    "<button class='theme-tgl' id='theme-tgl' onclick=\"__tgl()\">&#9790; Dark</button>",
    "<header><div class='wrap'>",
    "<div class='kicker prompt'>$ claude-insights<span class='cur'></span></div>",
    "<h1>Claude Code Insights</h1>",
    "<div class='sub'>Local session cost &amp; token usage across all recorded runs</div>",
    "<div class='spec'>" +
      "<div class='cell'><span class='k'>Generated</span><span class='v'>", esc(gen), "</span></div>" +
      "<div class='cell'><span class='k'>Source</span><span class='v'>~/.agents/.show-insights/state/stats.csv</span></div>" +
      "<div class='cell'><span class='k'>Scope</span><span class='v'>local only</span></div>" +
      "</div></div></header>",
    "<div class='wrap'>",
    "<div class='range-bar' id='rangeBar'></div>",
    "<div id='kpi'></div>",
    "<div class='eyebrow'>Spend over time</div>",
    "<div class='card'><h3>Cumulative spend + projection</h3><div id='sec-cumulative'></div></div>",
    "<div class='grid2'><div class='card'><h3>Run-rate</h3><div id='sec-runrate'></div></div>",
    "<div class='card'><h3>Daily spend calendar</h3><div id='sec-cal'></div></div></div>",
    "<div class='eyebrow'>Breakdown</div>",
    "<div class='toggle'><button id='btn-day' class='active' onclick=\"show('day')\">By Day</button>" +
      "<button id='btn-month' onclick=\"show('month')\">By Month</button></div>",
    "<div class='filter-bar'><span class='filter-lbl'>Filter models</span><div id='model-filter' class='legend'></div></div>",
    "<section id='day-view'><div class='card'><h3>Cost by day</h3><div id='day-chart'></div></div>" +
      "<div class='scroll' id='day-table'></div></section>",
    "<section id='month-view' style='display:none'><div class='card'><h3>Cost by month</h3><div id='month-chart'></div></div>" +
      "<div class='scroll' id='month-table'></div></section>",
    "<div class='eyebrow'>Token economics</div>",
    "<div class='toggle' style='margin-top:4px'><button id='tbtn-day' class='active' onclick=\"showTok('day')\">By Day</button>" +
      "<button id='tbtn-month' onclick=\"showTok('month')\">By Month</button></div>",
    "<div id='tok-legend' class='legend'></div>",
    "<div id='tok-day'><div class='card'><h3>Token composition by day</h3><div id='tok-day-bars'></div></div></div>",
    "<div id='tok-month' style='display:none'><div class='card'><h3>Token composition by month</h3><div id='tok-month-bars'></div></div></div>",
    "<div class='grid2'><div class='card'><h3>Token mix</h3><div id='tok-mix'></div></div>",
    "<div class='card'><h3>Cache-creation / cache-read ratio by day</h3><div id='cc-ratio'></div></div></div>",
    "<div class='eyebrow'>Efficiency</div>",
    "<div class='card'><h3>Per-model efficiency</h3><div id='sec-eff-models'></div></div>",
    "<div class='card'><h3>Throughput &amp; engagement</h3><div id='sec-throughput'></div></div>",
    "<div class='eyebrow'>Rate-limit utilization · 5h &amp; 7d</div>",
    "<div class='card'><h3>5h / 7d usage-limit efficiency</h3><div id='sec-ratelimits'></div></div>",
    "<div class='eyebrow'>When you work</div>",
    "<div class='card flush2'><h3>Spend by day-of-week × hour</h3><div id='sec-dayhour'></div></div>",
    "<div class='eyebrow'>Sessions</div>",
    "<div class='grid2'><div class='card'><h3>Cost vs tokens (per session)</h3><div id='sec-scatter'></div></div>",
    "<div class='card'><h3 id='sec-pareto-title'></h3><div id='sec-pareto'></div></div></div>",
    "<div class='scroll' id='sec-toptable'></div>",
    "<div class='eyebrow'>Usage patterns</div>",
    "<div class='card'><h3>Tool activity</h3><div id='sec-usage-stats'></div></div>",
    "<div class='grid2'><div class='card'><h3>Tool mix (top 12)</h3><div id='sec-tools'></div></div>",
    "<div class='card'><h3>Subagent types</h3><div id='sec-agents'></div></div></div>",
    "<div class='card'><h3>Skills invoked</h3><div id='sec-skills'></div></div>",
    "<div class='eyebrow'>By project</div>",
    "<div class='grid2'><div class='card'><h3>Cost by project</h3><div id='sec-proj-cost'></div></div>",
    "<div class='card'><h3>Sessions by project</h3><div id='sec-proj-sess'></div></div></div>",
    "<div class='eyebrow'>Models</div>",
    "<div class='card'><h3>Cost share by model (area ∝ cost)</h3><div id='sec-treemap'></div></div>",
    "<div class='grid2'><div class='card'><h3>Sessions by model</h3><div id='sec-model-sessions'></div></div>",
    "<div class='card'><h3>Cost by model</h3><div id='sec-model-cost'></div></div></div>",
    "<div class='card'><h3>Model adoption — cost share by month</h3><div id='sec-share'></div></div>",
    "<div class='eyebrow'>Insights roadmap · what could come next</div>",
    "<div class='card'>", roadmap_html, "</div>",
    "<footer>Generated locally from ~/.agents/.show-insights/state/stats.csv. All session data stays on this machine. " +
      "Line counts, API time and rate-limit data are captured from the statusline going forward; older " +
      "sessions show them as 0/—. Tool usage, projects, subagents, skills and compactions are derived " +
      "from transcripts (retroactive). Run <code>improve.mjs roadmap</code> for the roadmap as text.</footer>",
    "</div>",
    "<script>\nvar SESSIONS=", sessions_json, ";\n", _CFG_JS, _JS_MODULE, "\n</script>",
    "</body></html>",
  ].join("");
}

const _STYLE = `
:root{
  --bg:#f4f5f7; --surface:#fff; --surface-2:#fafbfc; --line:#e4e7eb;
  --ink:#191c21; --ink-soft:#5b6470; --ink-faint:#909aa5;
  --head-bg:#e9edf2; --head-ink:#191c21; --head-soft:#5f6b7a;
  --ac:#1c9b73;
  --mono:'Cascadia Code','Cascadia Mono',ui-monospace,'SF Mono',Consolas,'Liberation Mono',monospace;
  --sans:'Segoe UI Variable Text','Segoe UI',system-ui,-apple-system,Roboto,sans-serif;
}
:root[data-theme="dark"]{ --bg:#0c1411; --surface:#121a17; --surface-2:#0f1714; --line:#203029;
    --ink:#d7e3dd; --ink-soft:#93a59c; --ink-faint:#647168;
    --head-bg:#070d0b; --head-ink:#eaf3ef; --head-soft:#8fb6a8; --ac:#3fb68b; }
*{box-sizing:border-box}
body{font-family:var(--sans);margin:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
.wrap{max-width:980px;margin:0 auto;padding:0 22px}
.num{font-family:var(--mono);font-variant-numeric:tabular-nums}
header{background:var(--head-bg);color:var(--head-ink);padding:30px 0 26px;border-bottom:1px solid var(--line)}
.kicker{font-family:var(--mono);font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:var(--head-soft);margin:0 0 12px}
h1{font-family:var(--mono);margin:0 0 6px;font-size:25px;font-weight:600;letter-spacing:-.01em}
.sub{color:var(--head-soft);font-size:13px;margin:2px 0}
.spec{display:flex;flex-wrap:wrap;margin-top:16px;border:1px solid color-mix(in srgb,var(--head-soft) 28%,transparent);border-radius:8px;overflow:hidden;font-family:var(--mono);font-size:11.5px}
.spec .cell{padding:7px 14px;border-right:1px solid color-mix(in srgb,var(--head-soft) 22%,transparent)}
.spec .cell:last-child{border-right:0}
.spec .k{color:var(--head-soft);letter-spacing:.14em;text-transform:uppercase;margin-right:7px}
.spec .v{color:var(--head-ink);font-weight:600}
.eyebrow{font-family:var(--mono);font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:var(--ink-soft);font-weight:600;margin:38px 0 12px;padding-bottom:8px;border-bottom:1px solid var(--line);scroll-margin-top:14px}
/* hero thesis: 1 dominant spend + sparkline, 2 efficiency ratios, 5 supporting */
.hero{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:26px 0 4px}
@media (max-width:760px){.hero{grid-template-columns:1fr}}
.hero-left{background:var(--surface);border:1px solid color-mix(in srgb,var(--ac) 45%,var(--line));border-radius:8px;padding:18px 20px;display:flex;align-items:center;gap:24px}
.hero-main{flex:none;min-width:0}
.hero-num{font-family:var(--mono);font-size:44px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums;color:var(--ac);letter-spacing:-.02em}
.hero-spark{flex:1;min-width:0;text-align:right}
.hero-spark .spark{height:34px;width:100%}
.hero-eff{display:flex;flex-direction:column;gap:12px}
.kpi{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:16px 18px}
.kpi.sec{flex:1;display:flex;flex-direction:column;justify-content:center}
.kpi.sec .big{font-family:var(--mono);font-size:26px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums;color:var(--ink)}
.kpi .big{font-family:var(--mono);font-size:30px;font-weight:700;line-height:1.05;font-variant-numeric:tabular-nums}
.kpi.lead{border-color:color-mix(in srgb,var(--ac) 45%,var(--line))}
.kpi.lead .big{color:var(--ac)}
.kpi .lbl{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);margin-top:6px}
.kpi .sub2{font-size:12px;color:var(--ink-faint);margin-top:2px}
.supp-strip{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:0;margin:12px 0 4px;background:var(--surface);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.supp{display:flex;flex-direction:column;gap:1px;padding:11px 14px;border-right:1px solid var(--line);min-width:0}
.supp:last-child{border-right:0}
.supp .v{font-family:var(--mono);font-size:17px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.supp .k{font-family:var(--mono);font-size:10px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft);margin-top:3px}
.supp .d{font-size:11px;color:var(--ink-faint);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:12px}
@media (max-width:760px){.grid2{grid-template-columns:1fr}}
.card{background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin-top:12px}
.card h3{font-family:var(--mono);margin:0 0 10px;font-size:12px;font-weight:600;letter-spacing:.04em;color:var(--ink-soft);text-transform:uppercase}
.grid2 .card{margin-top:0}
.muted{color:var(--ink-faint);font-size:12px}
.bar-row{display:flex;align-items:center;margin:5px 0;font-size:12px;font-family:var(--mono)}
.bar-label{width:30%;min-width:90px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--ink-soft)}
.bar-track{flex:1;background:color-mix(in srgb,var(--ink-faint) 14%,transparent);border-radius:3px;height:13px;margin:0 9px;overflow:hidden}
.bar{height:13px;border-radius:3px}
.bar-val{width:74px;text-align:right;color:var(--ink);font-variant-numeric:tabular-nums}
.sbar-track{flex:1;display:flex;height:13px;margin:0 9px;border-radius:3px;background:color-mix(in srgb,var(--ink-faint) 14%,transparent)}
.seg{height:13px;position:relative;cursor:default;transition:filter .1s}
.seg:first-child{border-radius:3px 0 0 3px}
.seg:last-child{border-radius:0 3px 3px 0}
.seg:hover{filter:brightness(1.15)}
.seg:hover::after{content:attr(data-tip);position:absolute;bottom:19px;left:50%;transform:translateX(-50%);white-space:nowrap;background:var(--ink);color:var(--surface);font-family:var(--mono);font-size:11px;padding:3px 8px;border-radius:5px;pointer-events:none;z-index:30;box-shadow:0 2px 10px rgba(0,0,0,.35)}
.filter-bar{display:flex;align-items:center;flex-wrap:wrap;gap:10px;margin:12px 0}
.filter-lbl{font-family:var(--mono);font-size:11px;letter-spacing:.1em;text-transform:uppercase;color:var(--ink-soft)}
.legend{display:flex;flex-wrap:wrap;gap:8px}
.lg-item{display:inline-flex;align-items:center;gap:6px;font-family:var(--mono);font-size:11px;color:var(--ink-soft);background:var(--surface);border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.lg-item:hover{border-color:var(--ink-faint)}
.lg-item.off{opacity:.45;text-decoration:line-through}
.lg-swatch{width:10px;height:10px;border-radius:2px;flex:none}
.lg-all{font-family:var(--mono);font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--ink-soft);background:transparent;border:1px solid var(--line);border-radius:999px;padding:4px 11px;cursor:pointer}
.lg-all:hover{border-color:var(--ink-faint);color:var(--ink)}
.lg-all.active{background:var(--ac);color:#fff;border-color:var(--ac)}
.scroll{overflow-x:auto;border:1px solid var(--line);border-radius:8px;background:var(--surface);margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:12.5px}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid var(--line)}
thead th,table tr:first-child th{background:var(--surface-2);color:var(--ink-soft);font-family:var(--mono);font-weight:600;font-size:11px;letter-spacing:.04em;text-transform:uppercase;white-space:nowrap}
td.num,th.num{text-align:right;font-family:var(--mono);font-variant-numeric:tabular-nums}
tr.total td{font-weight:700;border-top:2px solid var(--line);font-family:var(--mono)}
.mono{font-family:var(--mono);font-size:12px}
.toggle{margin:0 0 4px}
.toggle button{font-family:var(--mono);background:var(--surface);border:1px solid var(--line);color:var(--ink-soft);border-radius:8px;padding:6px 14px;font-size:12px;letter-spacing:.04em;text-transform:uppercase;cursor:pointer;margin-right:6px}
.toggle button.active{background:var(--ac);color:#fff;border-color:var(--ac)}
.chart{width:100%;height:auto;display:block}
.chart text{font-family:var(--mono);font-size:11px;fill:var(--ink-faint)}
.chart .axis{stroke:var(--line);stroke-width:1}
.treemap{width:100%;height:auto;display:block}
.spark{display:block;width:100%;height:28px;margin-top:8px}
.statline{display:flex;flex-wrap:wrap;gap:20px}
.statline .s .v{font-family:var(--mono);font-size:20px;font-weight:700;color:var(--ink);font-variant-numeric:tabular-nums}
.statline .s .k{font-family:var(--mono);font-size:10px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-faint);margin-top:2px}
.eff-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}
.eff{background:var(--surface-2);border:1px solid var(--line);border-radius:8px;padding:11px 13px}
.eff .nm{display:flex;align-items:center;font-family:var(--mono);font-size:11px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.eff .row{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px;color:var(--ink-soft);margin-top:5px}
.heat-cal{display:inline-grid;grid-auto-flow:column;grid-template-rows:repeat(7,13px);gap:3px;overflow-x:auto;padding:2px}
.heat-cal .c{width:13px;height:13px;border-radius:2px;border:1px solid color-mix(in srgb,var(--line) 60%,transparent)}
.card.flush2{overflow-x:auto}
.heat-dh{display:grid;grid-template-columns:auto repeat(24,1fr);gap:2px;min-width:560px}
.heat-dh .c{height:14px;border-radius:2px;border:1px solid color-mix(in srgb,var(--line) 50%,transparent)}
.heat-dh .rl{font-family:var(--mono);font-size:10px;color:var(--ink-faint);text-align:right;padding-right:5px;line-height:14px}
.heat-dh .hl{font-family:var(--mono);font-size:9px;color:var(--ink-faint);text-align:center;line-height:12px}
footer{margin:44px 0 60px;color:var(--ink-faint);font-size:11.5px;font-family:var(--mono);border-top:1px solid var(--line);padding-top:14px;line-height:1.7}
footer code{background:var(--surface-2);padding:1px 5px;border-radius:4px;border:1px solid var(--line)}
.sgs{display:flex;flex-direction:column;gap:8px}
.sg{display:grid;grid-template-columns:74px 130px 1fr;gap:10px;align-items:baseline;font-size:12.5px}
@media (max-width:680px){.sg{grid-template-columns:1fr}}
.sg-b{font-family:var(--mono);font-size:9.5px;letter-spacing:.06em;text-transform:uppercase;color:#fff;text-align:center;border-radius:999px;padding:2px 0}
.sg-a{font-family:var(--mono);font-size:11.5px;color:var(--ink);font-weight:600}
.sg-t{color:var(--ink-soft);line-height:1.5}
` + "\n" + CHROME_CSS;

function _inject_jump_nav(html_doc) {
  const items = [["top", "↑ Top"]];
  const seen = new Set();

  html_doc = html_doc.replace(/<div class='eyebrow'>([\s\S]*?)<\/div>/g, (m, raw) => {
    const text = htmlUnescape(raw);
    let slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "sec";
    let sid = `sec-${slug}`;
    let k = 2;
    while (seen.has(sid)) {
      sid = `sec-${slug}-${k}`;
      k += 1;
    }
    seen.add(sid);
    items.push([sid, text]);
    return `<div class='eyebrow' id='${sid}'>${raw}</div>`;
  });
  html_doc = html_doc.replace(
    "<h1>Claude Code Insights</h1>",
    "<h1 id='top'>Claude Code Insights</h1>"
  );
  if (items.length <= 1) return html_doc;
  const nav = jumpNavHtml(items);
  html_doc = html_doc.replace("<script>\nvar SESSIONS=", nav + "<script>\nvar SESSIONS=");
  html_doc = html_doc.replace(
    "\n</script></body></html>",
    "\n" + JUMP_JS + "</script></body></html>"
  );
  return html_doc;
}

// ---- install (cross-machine setup) ----

function _settings_path() {
  return path.join(CLAUDE_DIR, "settings.json");
}

function _load_settings() {
  const p = _settings_path();
  if (!isFile(p)) return {};
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8"));
  } catch {
    return null; // corrupt → refuse to write
  }
}

function _is_our_record_hook(cmd, stats_abs) {
  const forms = [stats_abs, stats_abs.replace(/\\/g, "/")];
  return cmd.replace(/\s+$/, "").endsWith('" record') && forms.some((f) => cmd.includes(f));
}

function _is_foreign_record_hook(cmd, stats_abs) {
  const forms = [stats_abs, stats_abs.replace(/\\/g, "/")];
  return (
    cmd.replace(/\s+$/, "").endsWith('" record') &&
    cmd.includes("stats.mjs") &&
    !forms.some((f) => cmd.includes(f))
  );
}

function cmd_install(args) {
  const stats_abs = SCRIPT;
  const hook_cmd = `node "${stats_abs}" record`;
  const s_path = _settings_path();
  let cfg = _load_settings();
  const corrupt = cfg === null;
  if (corrupt) cfg = {};

  if (!cfg.hooks) cfg.hooks = {};
  if (!cfg.hooks.SessionEnd) cfg.hooks.SessionEnd = [];
  const se = cfg.hooks.SessionEnd;
  const existing = [];
  for (const block of se) {
    for (const h of block.hooks || []) {
      if (h.type === "command") existing.push(h.command || "");
    }
  }
  const already = existing.some((c) => _is_our_record_hook(c, stats_abs));
  const foreign = existing.filter((c) => _is_foreign_record_hook(c, stats_abs));

  print("=== show-insights install ===");
  print(`platform: ${process.platform}   interpreter: node`);
  print(`stats.mjs: ${stats_abs}`);
  print(`settings: ${s_path}`);
  print(`hook cmd: ${hook_cmd}`);
  print(`dirs:     ${STATE_DIR} , ${REPORTS_DIR}`);

  let action;
  if (already) {
    action = "noop";
    print("SessionEnd hook already present.");
  } else if (foreign.length && !args.force) {
    print("REFUSING: a SessionEnd record-hook points to a different stats.mjs:");
    for (const c of foreign) print(`  - ${c}`);
    print("Re-run with --force to replace it.");
    return;
  } else {
    action = "add";
  }

  let sl_action = "skip";
  let sl_note = "";
  if (args.with_statusline) {
    const sl = cfg.statusLine;
    if (sl && sl.command) {
      sl_note = "existing statusLine left in place (remove it first to use the reference)";
    } else {
      sl_action = "install";
    }
  }

  if (args.dry_run) {
    print("\n[dry-run] nothing written.");
    print(
      `would ${action === "add" ? "add" : "keep"} SessionEnd hook; ` +
        `${action !== "noop" ? "create" : "ensure"} dirs; statusline: ${sl_action}.`
    );
    return;
  }

  for (const d of [STATE_DIR, REPORTS_DIR]) {
    fs.mkdirSync(d, { recursive: true });
  }

  if (action === "add") {
    if (foreign.length) {
      cfg.hooks.SessionEnd = se
        .filter((block) => block.hooks)
        .map((block) => ({
          hooks: (block.hooks || []).filter(
            (h) =>
              !(h.type === "command" && _is_foreign_record_hook(h.command || "", stats_abs))
          ),
        }));
    }
    cfg.hooks.SessionEnd.push({ hooks: [{ type: "command", command: hook_cmd }] });
    if (corrupt) {
      print(`\n${sl_note || "settings.json unreadable"} — add this SessionEnd hook manually:`);
      print('  hooks.SessionEnd -> hooks -> { type: "command", command: <below> }');
      print(`    ${hook_cmd}`);
    } else {
      fs.mkdirSync(CLAUDE_DIR, { recursive: true });
      fs.writeFileSync(s_path, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
      print(`\nWrote SessionEnd hook to ${s_path}.`);
    }
  }

  if (sl_action === "install") {
    const src = path.join(SKILL_DIR, "statusline", "statusline.mjs");
    if (isFile(src)) {
      const dest = path.join(CLAUDE_DIR, "statusline.mjs");
      fs.writeFileSync(dest, fs.readFileSync(src, "utf-8"), "utf-8");
      const sl_cmd = `node "${dest}"`;
      const cfg2 = _load_settings() || {};
      cfg2.statusLine = { type: "command", command: sl_cmd };
      if (!corrupt) {
        fs.writeFileSync(s_path, JSON.stringify(cfg2, null, 2) + "\n", "utf-8");
        print(`Installed reference statusline → ${dest}`);
        print(`  statusLine.command: ${sl_cmd}`);
      } else {
        print(`Reference statusline copied to ${dest}; add to settings.json:`);
        print('  statusLine -> { type: "command", command: <below> }');
        print(`    ${sl_cmd}`);
      }
    } else {
      print(`No reference statusline.mjs shipped at ${src} — skipping.`);
    }
  }

  print("\nCapture contract: your statusline must write the raw statusline JSON to");
  print(`  ${STATE_DIR}/<session_id>.json   (last write per session wins)`);
  print("See INSTALL.md and statusline/ reference snippets. Without it, the report");
  print("still renders from transcripts only (cost/duration/lines blank).");
  print("\nDone. Generate a report:  node " + stats_abs + " report");
}

// ---- output helpers ----

function print(s) {
  process.stdout.write(s + "\n");
}

function printErr(s) {
  process.stderr.write(s + "\n");
}

function padR(s, w) {
  s = String(s);
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function padL(s, w) {
  s = String(s);
  return s.length >= w ? s : " ".repeat(w - s.length) + s;
}

function fixed(n, d) {
  return Number(n).toFixed(d);
}

// ---- CLI dispatch ----

function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    printErr("usage: stats.mjs {record,backfill,report,priors,install,estimate}");
    process.exit(2);
  }
  if (cmd === "record") {
    cmd_record();
  } else if (cmd === "backfill") {
    cmd_backfill();
  } else if (cmd === "report") {
    cmd_report();
  } else if (cmd === "priors") {
    cmd_priors();
  } else if (cmd === "install") {
    const args = {
      dry_run: argv.includes("--dry-run"),
      force: argv.includes("--force"),
      with_statusline: argv.includes("--with-statusline"),
    };
    cmd_install(args);
  } else if (cmd === "estimate") {
    const rest = argv.slice(1);
    const args = { category: null, context_tokens: null, model: null, no_refresh: false };
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === "--context-tokens") args.context_tokens = parseInt(rest[++i], 10);
      else if (a.startsWith("--context-tokens=")) args.context_tokens = parseInt(a.split("=")[1], 10);
      else if (a === "--model") args.model = rest[++i];
      else if (a.startsWith("--model=")) args.model = a.split("=")[1];
      else if (a === "--no-refresh") args.no_refresh = true;
      else if (!a.startsWith("--") && args.category === null) args.category = a;
    }
    if (args.category === null) {
      printErr("estimate: the following arguments are required: category");
      process.exit(2);
    }
    cmd_estimate(args);
  } else {
    printErr(`unknown command: ${cmd}`);
    process.exit(2);
  }
}

// Only dispatch the CLI when invoked directly (not on import).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
