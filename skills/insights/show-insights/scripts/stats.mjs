// Claude Code stats pipeline: record (SessionEnd hook), backfill, report (HTML).
// Node ESM, stdlib only. All data stays local. HTML rendering lives in render.mjs.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { render } from "./render.mjs";

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
    // ** matches zero or more directory levels (recursive=True semantics).
    walkGlob(dir, remaining, out); // match at this level (zero dirs)...
    for (const e of entries) {
      if (e.isDirectory()) {
        walkGlob(path.join(dir, e.name), rest, out); // ...and recurse keeping ** in place.
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
  if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
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

function session_totals(sid, mainPath) {
  const base = parse_transcript(mainPath || find_transcript(sid));
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
    const tk = _msg_tokens(msg);
    if (!tk) continue;
    r.input_tokens += tk.i;
    r.output_tokens += tk.o;
    r.cache_read_tokens += tk.cr;
    r.cache_creation_tokens += tk.cc;
    if (tk.model && (last_model_epoch === null || (ts !== null && ts >= (last_model_epoch ?? -1)))) {
      if (ts !== null) {
        last_model_epoch = ts;
        r.last_model = tk.model;
      }
    }
  }
  return r;
}

function intOr0(v) {
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

// Extract token usage from an assistant message; null for synthetic/zero rows.
function _msg_tokens(msg) {
  const usage = msg.usage && typeof msg.usage === "object" && !Array.isArray(msg.usage) && msg.usage !== null
    ? msg.usage : {};
  const i = intOr0(usage.input_tokens);
  const o = intOr0(usage.output_tokens);
  const cr = intOr0(usage.cache_read_input_tokens);
  const cc = intOr0(usage.cache_creation_input_tokens);
  if (msg.model === "<synthetic>" || (i === 0 && o === 0 && cr === 0 && cc === 0)) return null;
  return { i, o, cr, cc, model: msg.model };
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

// Strip the mcp__<server>__ prefix so namespaced and bare forms classify alike.
const _canon_tool = (n) => n.replace(/^mcp__.*?__/, "");

const ORCH_TOOLS = new Set([
  "Agent", "Task", "TaskCreate", "TaskUpdate", "TaskStop", "TaskGet", "TaskList", "TaskOutput",
]);
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "ctx_edit"]);
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch",
  "ctx_read", "ctx_search", "ctx_tree", "ctx_overview",
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
        cur.tools.add(_canon_tool(name));
        const inp = b.input && typeof b.input === "object" && !Array.isArray(b.input) ? b.input : {};
        if (name === "Skill") {
          const sk = inp.command || inp.skill || "";
          if (VERIFY_SKILL_RE.test(String(sk))) cur.verify = true;
        } else if (name === "Bash" || name === "PowerShell") {
          if (TEST_RE.test(String(inp.command || ""))) cur.verify = true;
        }
      }
    }
    const tk = _msg_tokens(msg);
    if (!tk) continue;
    cur.in += tk.i;
    cur.out += tk.o;
    cur.cr += tk.cr;
    cur.cc += tk.cc;
    cur.api_turns += 1;
    if (tk.model) cur.model = tk.model;
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

function _build_priors(files) {
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
  for (const p of (files || globSync(path.join(PROJECTS_DIR, "*", "*.jsonl")))) {
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
  fs.writeFileSync(PRIORS_JSON, JSON.stringify(priors, null, 2), { encoding: "utf-8", mode: 0o600 });
  return priors;
}

function round4(x) {
  // Match Python round-half-to-even.
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
  const files = globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"));
  if (!isFile(PRIORS_JSON)) return { stale: true, files };
  const pj = getmtime(PRIORS_JSON);
  if (Date.now() / 1000 - pj > max_age_days * 86400) return { stale: true, files };
  const newest = files.reduce((mx, p) => Math.max(mx, getmtime(p)), 0);
  return { stale: newest > pj, files };
}

function cmd_estimate(args) {
  let p;
  if (!args.no_refresh) {
    const { stale, files } = _priors_stale();
    if (stale) {
      printErr("refreshing priors...");
      p = _build_priors(files);
    }
  }
  if (p === undefined) {
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
        `${model ? ", " + model : ""})`
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
  if (!sid || sid === ZERO_UUID || !/^[0-9a-fA-F-]{1,64}$/.test(sid)) process.exit(0);
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
    fs.appendFileSync(SESSIONS_JSONL, JSON.stringify(rec) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function _prepend_row(row) {
  const line = row.map((x) => _csv_field(x)).join(",");
  if (!isFile(STATS_CSV)) {
    fs.writeFileSync(STATS_CSV, HEADER + "\n" + line + "\n", { encoding: "utf-8", mode: 0o600 });
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
  fs.writeFileSync(STATS_CSV, out.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
}

// ---- backfill ----

// Rebuild stats.csv from all transcripts. Folds in any lingering cost-state
// snapshot (a session whose SessionEnd hook hasn't projected it yet) so its
// cost/duration/lines/rate-limits/context land in the row. `excludeSid` (the
// active session) is skipped entirely — its transcript is mid-flight.
function _rebuild_stats_csv(excludeSid) {
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
    if (sid === ZERO_UUID || sid === excludeSid) continue;
    seen.add(sid);
    const ex = existing[sid] || {};
    const t = session_totals(sid, p);
    const st = read_cost_state(sid);
    const stCost = st && st.cost !== null && st.cost !== undefined && st.cost !== "" ? String(st.cost) : "";
    const cost = (ex.total_cost_usd || "").trim() || stCost;
    if (cost) with_cost += 1;
    const fbNum = (exCol, stKey) => _inum(fwd(ex, exCol)) || (st ? _inum(st[stKey]) : 0);
    const fbRaw = (exCol, stKey) => {
      const ev = fwd(ex, exCol);
      return ev !== "" ? ev : st ? _blank(st[stKey]) : "";
    };
    let dur = fbNum("duration_ms", "duration_ms");
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
      model_id: fwd(ex, "model_id") || (st ? st.model_id : "") || t.last_model,
      model_display_name: fwd(ex, "model_display_name") || (st ? st.model_display_name : ""),
      duration_ms: dur,
      api_duration_ms: fbNum("api_duration_ms", "api_duration_ms"),
      lines_added: fbNum("lines_added", "lines_added"),
      lines_removed: fbNum("lines_removed", "lines_removed"),
      rl_5h_pct: fbRaw("rl_5h_pct", "rl_5h_pct"),
      rl_7d_pct: fbRaw("rl_7d_pct", "rl_7d_pct"),
      context_pct: fbRaw("context_pct", "context_pct"),
      context_window_size: fbRaw("context_window_size", "context_window_size"),
      turns: t.turns,
      tool_calls: t.tool_calls,
      start_epoch: t.start_epoch ? Math.trunc(t.start_epoch) : "",
      facets_json: jsonCompact(t.facets),
    });
  }
  for (const [sid, ex] of Object.entries(existing)) {
    if (seen.has(sid) || sid === excludeSid) continue;
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
  fs.writeFileSync(STATS_CSV, out_lines.join("\n") + "\n", { encoding: "utf-8", mode: 0o600 });
  return { sessions: rows.length, with_cost, no_cost: rows.length - with_cost };
}

function cmd_backfill() {
  print(JSON.stringify(_rebuild_stats_csv(null)));
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

// ---- report freshness ----
// Active session = newest-touched transcript or cost-state file within a live
// window (statusline renders are frequent during active use). Cold shell after
// session close → null, so a hook-missed session's lingering cost-state still
// integrates. getmtime returns seconds.

function _active_sid() {
  const WIN = 180;
  const now = Date.now() / 1000;
  let newest = 0, newestSid = null;
  for (const p of globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"))) {
    const m = getmtime(p);
    if (m > newest) { newest = m; newestSid = path.basename(p, ".jsonl"); }
  }
  for (const p of globSync(path.join(STATE_DIR, "*.json"))) {
    const m = getmtime(p);
    if (m > newest) { newest = m; newestSid = path.basename(p, ".json"); }
  }
  return newestSid && now - newest < WIN ? newestSid : null;
}

// Rebuild stats.csv before rendering if any non-excluded transcript or
// cost-state file is newer than stats.csv (or stats.csv is missing). Excludes
// the active session so a mid-flight transcript never pollutes the report.
function _ensure_fresh() {
  const active = _active_sid();
  const csvMtime = isFile(STATS_CSV) ? getmtime(STATS_CSV) : 0;
  let need = csvMtime === 0;
  if (!need) {
    for (const p of globSync(path.join(PROJECTS_DIR, "*", "*.jsonl"))) {
      if (path.basename(p, ".jsonl") === active) continue;
      if (getmtime(p) > csvMtime) { need = true; break; }
    }
    if (!need) {
      for (const p of globSync(path.join(STATE_DIR, "*.json"))) {
        if (path.basename(p, ".json") === active) continue;
        if (getmtime(p) > csvMtime) { need = true; break; }
      }
    }
  }
  if (need) _rebuild_stats_csv(active);
}

function cmd_report() {
  _ensure_fresh();
  if (!isFile(STATS_CSV)) {
    print(`stats.csv not found at ${STATS_CSV}. Run \`node ${SCRIPT} backfill\` first.`);
    process.exit(1);
  }
  const c = _load_stats();
  const html_doc = render(c);
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
    const src = path.join(SKILL_DIR, "scripts", "statusline.mjs");
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
  print("See INSTALL.md and scripts/statusline.mjs reference. Without it, the report");
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
