// HTML report renderer for show-insights: render(c) -> full self-contained document.
// The page layout lives in sources/base.html ({{PLACEHOLDER}} slots) and the larger
// hero/header block in sources/hero.html; short section markup is inlined as
// constants below, each returned by its render_<section>() function. Client-side
// chart code is sources/app.js, page CSS is sources/style.css (shared chrome CSS
// appended from report_chrome.mjs).
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CHROME_CSS, JUMP_JS, jumpNavHtml } from "./report_chrome.mjs";

const HOME = os.homedir();
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(SCRIPT_DIR);
const SOURCES_DIR = path.join(SCRIPT_DIR, "sources");

function _source(name) {
  return fs.readFileSync(path.join(SOURCES_DIR, name), "utf-8");
}

// Replace {{KEY}} slots with literal values (callback form so '$' sequences in
// the replacement — common in the embedded JS/CSS — are never treated as
// String.replace special patterns).
function _fill(tpl, slots) {
  return tpl.replace(/\{\{([A-Z_]+)\}\}/g, (m, key) => (key in slots ? slots[key] : m));
}

// ---- helpers ----

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
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

function _inum(v) {
  if (v === null || v === undefined || v === "") return 0;
  const f = parseFloat(v);
  return Number.isNaN(f) ? 0 : Math.trunc(f);
}

// ---- roadmap (improve-insights integration) ----

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

const IMPROVE_MJS = _sibling_skill("improve-insights", "improve.mjs");

function _fetch_roadmap() {
  if (!isFile(IMPROVE_MJS)) return null;
  try {
    const out = execFileSync(process.execPath, [IMPROVE_MJS, "roadmap", "--json"], {
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

// ---- embedded SESSIONS payload ----

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

// ---- sections ----

function render_style() {
  return _source("style.css") + "\n" + CHROME_CSS;
}

// hero.html carries the page <header>, opens the main .wrap container (closed
// by base.html after the last section), and includes the spend-over-time cards.
function render_hero() {
  return _fill(_source("hero.html"), { GENERATED: esc(fmtLocal(new Date())) });
}

const BREAKDOWN_HTML = `<div class='eyebrow'>Breakdown</div>
<div class='toggle'><button id='btn-day' class='active' onclick="show('day')">By Day</button><button id='btn-month' onclick="show('month')">By Month</button></div>
<div class='filter-bar'><span class='filter-lbl'>Filter models</span><div id='model-filter' class='legend'></div></div>
<section id='day-view'><div class='card'><h3>Cost by day</h3><div id='day-chart'></div></div><div class='scroll' id='day-table'></div></section>
<section id='month-view' style='display:none'><div class='card'><h3>Cost by month</h3><div id='month-chart'></div></div><div class='scroll' id='month-table'></div></section>`;

function render_breakdown() {
  return BREAKDOWN_HTML;
}

const TOKEN_ECONOMICS_HTML = `<div class='eyebrow'>Token economics</div>
<div class='toggle' style='margin-top:4px'><button id='tbtn-day' class='active' onclick="showTok('day')">By Day</button><button id='tbtn-month' onclick="showTok('month')">By Month</button></div>
<div id='tok-legend' class='legend'></div>
<div id='tok-day'><div class='card'><h3>Token composition by day</h3><div id='tok-day-bars'></div></div></div>
<div id='tok-month' style='display:none'><div class='card'><h3>Token composition by month</h3><div id='tok-month-bars'></div></div></div>
<div class='grid2'><div class='card'><h3>Token mix</h3><div id='tok-mix'></div></div>
<div class='card'><h3>Cache-creation / cache-read ratio by day</h3><div id='cc-ratio'></div></div></div>`;

function render_token_economics() {
  return TOKEN_ECONOMICS_HTML;
}

const EFFICIENCY_HTML = `<div class='eyebrow'>Efficiency</div>
<div class='card'><h3>Per-model efficiency</h3><div id='sec-eff-models'></div></div>
<div class='card'><h3>Throughput &amp; engagement</h3><div id='sec-throughput'></div></div>`;

function render_efficiency() {
  return EFFICIENCY_HTML;
}

const RATE_LIMITS_HTML = `<div class='eyebrow'>Rate-limit utilization · 5h &amp; 7d</div>
<div class='card'><h3>5h / 7d usage-limit efficiency</h3><div id='sec-ratelimits'></div></div>`;

function render_rate_limits() {
  return RATE_LIMITS_HTML;
}

const WHEN_YOU_WORK_HTML = `<div class='eyebrow'>When you work</div>
<div class='card flush2'><h3>Spend by day-of-week × hour</h3><div id='sec-dayhour'></div></div>`;

function render_when_you_work() {
  return WHEN_YOU_WORK_HTML;
}

const SESSIONS_HTML = `<div class='eyebrow'>Sessions</div>
<div class='grid2'><div class='card'><h3>Cost vs tokens (per session)</h3><div id='sec-scatter'></div></div>
<div class='card'><h3 id='sec-pareto-title'></h3><div id='sec-pareto'></div></div></div>
<div class='scroll' id='sec-toptable'></div>`;

function render_sessions() {
  return SESSIONS_HTML;
}

const USAGE_PATTERNS_HTML = `<div class='eyebrow'>Usage patterns</div>
<div class='card'><h3>Tool activity</h3><div id='sec-usage-stats'></div></div>
<div class='grid2'><div class='card'><h3>Tool mix (top 12)</h3><div id='sec-tools'></div></div>
<div class='card'><h3>Subagent types</h3><div id='sec-agents'></div></div></div>
<div class='card'><h3>Skills invoked</h3><div id='sec-skills'></div></div>`;

function render_usage_patterns() {
  return USAGE_PATTERNS_HTML;
}

const PROJECTS_HTML = `<div class='eyebrow'>By project</div>
<div class='grid2'><div class='card'><h3>Cost by project</h3><div id='sec-proj-cost'></div></div>
<div class='card'><h3>Sessions by project</h3><div id='sec-proj-sess'></div></div></div>`;

function render_projects() {
  return PROJECTS_HTML;
}

const MODELS_HTML = `<div class='eyebrow'>Models</div>
<div class='card'><h3>Cost share by model (area ∝ cost)</h3><div id='sec-treemap'></div></div>
<div class='grid2'><div class='card'><h3>Sessions by model</h3><div id='sec-model-sessions'></div></div>
<div class='card'><h3>Cost by model</h3><div id='sec-model-cost'></div></div></div>
<div class='card'><h3>Model adoption — cost share by month</h3><div id='sec-share'></div></div>`;

function render_models() {
  return MODELS_HTML;
}

const ROADMAP_HTML = `<div class='eyebrow'>Insights roadmap · what could come next</div>
<div class='card'>{{ROADMAP_BODY}}</div>`;

function render_roadmap() {
  return _fill(ROADMAP_HTML, { ROADMAP_BODY: _render_suggestions(_fetch_roadmap()) });
}

const FOOTER_HTML = `<footer>Generated locally from ~/.agents/.show-insights/state/stats.csv. All session data stays on this machine. Line counts, API time and rate-limit data are captured from the statusline going forward; older sessions show them as 0/—. Tool usage, projects, subagents, skills and compactions are derived from transcripts (retroactive). Run <code>improve.mjs roadmap</code> for the roadmap as text.</footer>`;

function render_footer() {
  return FOOTER_HTML;
}

function render_scripts(sessions) {
  const secs = _build_sessions_json(sessions);
  // Escape < so a crafted field (cwd, tool/skill name from a transcript) can't
  // break out of the <script> context. JSON allows \u escapes inside strings.
  const sessions_json = JSON.stringify(secs).replace(/</g, "\\u003c");
  return "<script>\nvar SESSIONS=" + sessions_json + ";\n" + _source("app.js") + "\n</script>";
}

// ---- render ----

export function render(c) {
  const doc = _fill(_source("base.html"), {
    STYLE: render_style(),
    HERO: render_hero(),
    BREAKDOWN: render_breakdown(),
    TOKEN_ECONOMICS: render_token_economics(),
    EFFICIENCY: render_efficiency(),
    RATE_LIMITS: render_rate_limits(),
    WHEN_YOU_WORK: render_when_you_work(),
    SESSIONS: render_sessions(),
    USAGE_PATTERNS: render_usage_patterns(),
    PROJECTS: render_projects(),
    MODELS: render_models(),
    ROADMAP: render_roadmap(),
    FOOTER: render_footer(),
    SCRIPTS: render_scripts(c.sessions),
  });
  return _inject_jump_nav(doc);
}

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
