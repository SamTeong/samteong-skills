// HTML report renderer for show-insights: render(c) -> full self-contained document,
// in the "paper-and-clay" design language (see design-system/DESIGN-SYSTEM.md).
// The page layout lives in sources/base.html ({{PLACEHOLDER}} slots) and the larger
// hero/header block in sources/hero.html; short section markup is inlined as
// constants below, each returned by its render_<section>() function. Client-side
// chart code is sources/app.js, page CSS is sources/style.css + sources/fonts.css
// (base64-inlined woff2 from fetch-fonts.mjs), including the jump-nav/topbar
// chrome, and the reveal + ambient-glow scripts are sources/motion.html. The
// whole document is fully self-contained — zero external requests at view time.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { JUMP_JS, jumpNavHtml } from "./report_chrome.mjs";

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
  const badge = { available: "st-ok", partial: "st-part", idea: "st-idea" };
  const rows = sg
    .map(
      (s) =>
        `<div class='sg rv' data-st='${esc(s.status)}'><span class='sg-b ${badge[s.status] || "st-idea"}'>` +
        `${esc(s.status)}</span><span class='sg-a'>${esc(s.area)}</span>` +
        `<span class='sg-t'>${esc(s.text)}</span></div>`
    )
    .join("");
  const hasAvail = sg.some((s) => s.status === "available");
  const filter = hasAvail
    ? "<div class='filter-bar'><span class='filter-lbl'>Roadmap</span>" +
      "<button id='road-filter' class='lg-all' type='button' aria-pressed='true'>Show available</button></div>"
    : "";
  const gridCls = hasAvail ? "sgs hide-avail" : "sgs";
  return `${filter}<div class='${gridCls}' id='road-sgs'>${rows}</div>`;
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
  // fonts.css carries the base64-inlined woff2 faces (self-hosted, generated by
  // fetch-fonts.mjs) so the report loads zero external resources.
  return _source("fonts.css") + "\n" + _source("style.css");
}

// hero.html carries the page <header>, opens the main .wrap container (closed
// by base.html after the last section), and includes the spend-over-time cards.
function render_hero() {
  return _fill(_source("hero.html"), { GENERATED: esc(fmtLocal(new Date())) });
}

const BREAKDOWN_HTML = `<div class='eyebrow' id='sec-breakdown'>Breakdown<span class='n'>cost by day or month, filterable by model</span></div>
<div class='ctl-row'><div id='model-filter' class='legend'></div><div class='toggle'><button id='btn-day' class='active' onclick="show('day')">By Day</button><button id='btn-month' onclick="show('month')">By Month</button></div></div>
<section id='day-view'><div class='card rv'><h3>Cost by day</h3><div id='day-chart'></div></div><div class='scroll' id='day-table'></div></section>
<section id='month-view' style='display:none'><div class='card rv'><h3>Cost by month</h3><div id='month-chart'></div></div><div class='scroll' id='month-table'></div></section>`;

function render_breakdown() {
  return BREAKDOWN_HTML;
}

const TOKEN_ECONOMICS_HTML = `<div class='eyebrow' id='sec-token-economics'>Token economics<span class='n'>where the tokens go and what the cache saves</span></div>
<div class='ctl-row'><div id='tok-legend' class='legend'></div><div class='toggle'><button id='tbtn-day' class='active' onclick="showTok('day')">By Day</button><button id='tbtn-month' onclick="showTok('month')">By Month</button></div></div>
<div id='tok-day'><div class='card rv'><h3>Token composition by day</h3><div id='tok-day-bars'></div></div></div>
<div id='tok-month' style='display:none'><div class='card rv'><h3>Token composition by month</h3><div id='tok-month-bars'></div></div></div>
<div class='grid12'><div class='card rv'><h3>Token mix</h3><div id='tok-mix'></div></div>
<div class='card rv'><h3>Cache-creation / cache-read ratio by day</h3><div id='cc-ratio'></div></div></div>`;

function render_token_economics() {
  return TOKEN_ECONOMICS_HTML;
}

const EFFICIENCY_HTML = `<div class='eyebrow' id='sec-efficiency'>Efficiency<span class='n'>what a session costs in tokens, time, and lines</span></div>
<h3 class='subhead'>Per-model efficiency</h3>
<div id='sec-eff-models' class='rv'></div>
<div class='card rv'><div id='sec-throughput'></div></div>`;

function render_efficiency() {
  return EFFICIENCY_HTML;
}

const RATE_LIMITS_HTML = `<div class='eyebrow' id='sec-rate-limit-utilization-5h-7d'>Rate-limit utilization · 5h &amp; 7d<span class='n'>how close you run to the usage caps</span></div>
<div class='card rv'><h3>5h / 7d usage-limit efficiency</h3><div id='sec-ratelimits'></div></div>`;

function render_rate_limits() {
  return RATE_LIMITS_HTML;
}

const WHEN_YOU_WORK_HTML = `<div class='eyebrow' id='sec-when-you-work'>When you work<span class='n'>spend by weekday and hour</span></div>
<div class='card flush2 rv'><h3>Spend by day-of-week × hour</h3><div id='sec-dayhour'></div></div>`;

function render_when_you_work() {
  return WHEN_YOU_WORK_HTML;
}

const SESSIONS_HTML = `<div class='eyebrow' id='sec-sessions'>Sessions<span class='n'>the runs that carry the bill</span></div>
<div class='grid2'><div class='card rv'><h3>Cost vs tokens (per session)</h3><div id='sec-scatter'></div></div>
<div class='card rv'><h3 id='sec-pareto-title'></h3><div id='sec-pareto'></div></div></div>
<div class='scroll' id='sec-toptable'></div>`;

function render_sessions() {
  return SESSIONS_HTML;
}

const USAGE_PATTERNS_HTML = `<div class='eyebrow' id='sec-usage-patterns'>Usage patterns<span class='n'>tools, subagents, and skills in play</span></div>
<div class='card rv'><div id='sec-usage-stats'></div></div>
<div class='grid2'><div class='card rv'><h3>Tool mix (top 12)</h3><div id='sec-tools'></div></div>
<div class='card rv'><h3>Subagent types</h3><div id='sec-agents'></div></div></div>
<div class='card rv'><h3>Skills invoked</h3><div id='sec-skills'></div></div>`;

function render_usage_patterns() {
  return USAGE_PATTERNS_HTML;
}

const PROJECTS_HTML = `<div class='eyebrow' id='sec-by-project'>By project<span class='n'>which repos spend the budget</span></div>
<div class='grid2'><div class='card rv'><h3>Cost by project</h3><div id='sec-proj-cost'></div></div>
<div class='card rv'><h3>Sessions by project</h3><div id='sec-proj-sess'></div></div></div>`;

function render_projects() {
  return PROJECTS_HTML;
}

const MODELS_HTML = `<div class='eyebrow' id='sec-models'>Models<span class='n'>cost share and adoption over time</span></div>
<div class='card rv'><h3>Cost share by model (area ∝ cost)</h3><div id='sec-treemap'></div></div>
<div class='grid2'><div class='card rv'><h3>Sessions by model</h3><div id='sec-model-sessions'></div></div>
<div class='card rv'><h3>Cost by model</h3><div id='sec-model-cost'></div></div></div>
<div class='card rv'><h3>Model adoption — cost share by month</h3><div id='sec-share'></div></div>`;

function render_models() {
  return MODELS_HTML;
}

const ROADMAP_HTML = `<div class='eyebrow' id='sec-insights-roadmap-what-could-come-next'>Insights roadmap<span class='n'>what could come next</span></div>
{{ROADMAP_BODY}}`;

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
  return (
    "<script>\nvar SESSIONS=" + sessions_json + ";\n" + _source("app.js") +
    "\n" + JUMP_JS + "</script>"
  );
}

// IntersectionObserver reveal-on-scroll + 2D-canvas ambient glow + flagcard
// updater — no external libs; every effect no-ops under prefers-reduced-motion.
function render_motion() {
  return _source("motion.html");
}

// Build the fixed "Go to section" nav from the eyebrows already present in the
// composed document (each carries its anchor id statically).
function _jump_nav(doc) {
  const items = [["top", "↑ Top"]];
  const re = /<div class='eyebrow' id='([^']+)'>([\s\S]*?)<span class='n'>/g;
  let m;
  while ((m = re.exec(doc))) items.push([m[1], htmlUnescape(m[2])]);
  return jumpNavHtml(items);
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
    MOTION: render_motion(),
  });
  // Second pass: the nav is derived from the section markup composed above.
  return _fill(doc, { JUMP_NAV: _jump_nav(doc) });
}
