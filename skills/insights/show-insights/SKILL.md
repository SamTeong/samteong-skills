---
name: show-insights
description: Collect, visualize, and estimate from local Claude Code session-cost data. Renders an interactive HTML Insights report of session cost, token usage, efficiency and usage patterns from the local stats.csv, and estimates the cost of a pre-execution op by category. Use whenever the user invokes /show-insights, asks for "my stats", "my insights", "cost report", "token usage report", "how much did I spend on Claude", "usage report", "show my Claude Code stats/insights", wants to see cost/token/efficiency trends by day or month, or wants a pre-op cost estimate (`stats.mjs estimate <category>`). Reads ~/.agents/.show-insights/state/stats.csv; writes a self-contained HTML report to ~/.agents/.show-insights/reports/. Stdlib only, runs locally.
metadata:
  version: 1.0.0
---

# show-insights

Interactive HTML "Claude Code Insights" report of session cost, token usage, efficiency
and usage patterns, read from `~/.agents/.show-insights/state/stats.csv`. Columns: timestamp, session_id,
total_cost_usd, last_model, input_tokens, output_tokens, cache_read_tokens,
cache_creation_tokens, model_id, model_display_name, duration_ms, api_duration_ms,
lines_added, lines_removed, rl_5h_pct, rl_7d_pct, context_pct, context_window_size,
turns, tool_calls, start_epoch. The trailing statusline-fed columns are captured going
forward (forward-only; 0/blank for older rows); duration/turns/tool_calls backfill from
transcripts. Self-contained HTML, no external libs, persisted at
`~/.agents/.show-insights/reports/report-<timestamp>.html` (mode 0600). Day/Month toggle.

`SKILL_DIR` = this skill's directory. Runs via `node` (ships with Claude Code, on PATH).
On a fresh machine, install first:
`node <SKILL_DIR>/scripts/stats.mjs install` (writes the SessionEnd hook + creates dirs;
see INSTALL.md).

## Steps

1. If `~/.agents/.show-insights/state/stats.csv` is missing or stale (e.g. first run after migration, or
   new transcripts not yet captured), rebuild it from all historical transcripts:
   `node <SKILL_DIR>/scripts/stats.mjs backfill`
   This overwrites stats.csv newest-first. Run while no Claude Code session is active.

2. Render the report:
   `node <SKILL_DIR>/scripts/stats.mjs report`

3. The script writes the report, prints its absolute path, and auto-opens it in the
   OS default browser (set `INSIGHTS_BROWSER=firefox|chrome|...` to override). No manual
   open step needed. If the browser fails to launch, the path is still printed — open it
   manually.

### Pre-op cost estimate

`node <SKILL_DIR>/scripts/stats.mjs estimate <category>` (planning|execution|verification|
orchestration|other; prefix ok) prints historical p50/p90/mean cost + typical turns/output
for that op category, derived from recorded `total_cost_usd` redistributed across transcript
ops. Priors cache to `~/.agents/.show-insights/state/priors.json` and lazy-rebuild when stale
(>7d or a newer transcript landed); `stats.mjs priors` forces a rebuild. With a live statusline
snapshot it also adds a context re-read floor for the current op.

Live capture happens automatically via the SessionEnd hook (`stats.mjs record`), which reads
the full statusline JSON snapshot from `~/.agents/.show-insights/state/cost-state/<sid>.json`
(written verbatim by your statusline — last write per session) for
cost/duration/lines/rate-limits/context, plus tokens + turns + tool_calls + last_model +
transcript facets (tool mix, errors, subagents, skills, project cwd/branch, compactions →
`facets_json`) from the session's transcript JSONL. It also appends the raw statusline JSON
to `~/.agents/.show-insights/state/sessions.jsonl` (archive for future metrics) and deletes the cost-state file.
No manual step needed for new sessions.

## Capture contract (statusline)

The only hard requirement for live cost/duration/lines/rate-limit/context capture: **your
statusline must write the raw statusline JSON payload (the stdin it receives) to
`~/.agents/.show-insights/state/cost-state/<session_id>.json` on each render** — last write
per session wins (≈ final snapshot). A single cross-platform statusline ships at
`<SKILL_DIR>/statusline/statusline.mjs` (model, context-usage bar, cost, rate limits, dir,
worktree, git status). `install --with-statusline` copies it into `~/.claude/` and wires
the `statusLine` setting to `node "<path>"` (skipped if you already have a statusLine command
— add the file write to your own statusline instead). `node` ships with Claude Code
(guaranteed on PATH). The statusline is **optional**: without it, `record`
exits early and the report renders from transcripts only (cost/duration/lines/rate-limits
blank, populated once a statusline is wired).

## Conventions

- **Token-legend pills** (Token Economics) filter the bar chart with **solo/deselect** semantic, not independent per-pill hide/show: empty `TOK_ACTIVE` = all series visible; click a pill → solos that series (only it visible); click again → drops it, back to all when set empties; `All` button resets. `tokVis()` returns `Array.from(TOK_ACTIVE)` (or all keys when empty) — must be an array, not a Set (`tokenBars` calls `.indexOf`). Do not change to independent-toggle without an explicit ask.
- **$/hour** has no per-session duration cap — legit sessions can exceed 8h; only the `$0`-cost filter drops idle/hung sessions.
- **$/line** gated at 5% line-coverage (`LINE_COV=0.05`); below it shows `—`.
- **Rate-limit panel** (5h/7d utilization) is forward-only from the statusline `rate_limits` field (Claude Code v2.1.80+, Claude.ai Pro/Max only — absent for API-key/Bedrock/Vertex and some Max 20x oauth users). Shows an empty-state notice when no rl-bearing sessions; `rl_5h_pct`/`rl_7d_pct` are floats, read with `_fnum` (not `_inum`), displayed `toFixed(1)`. Capped check uses `>=99.5` (float noise), near-cap `>=80`.
- All rendering is client-side: report embeds `var SESSIONS=[...]` JSON + a JS IIFE that aggregates and renders every section; date-range controls re-filter → re-aggregate → re-render.

## Scope & the improve-insights skill

This skill's job: **collect, visualize, and estimate** from local session-cost data
(record + backfill stats.csv, render the HTML report, and `estimate`/`priors` for pre-op
cost prediction — estimation derives from the same recorded cost + transcripts, so it lives
here with the data layer). Deciding *what new insights to add* and *how to improve the
report* belongs to the sibling **`improve-insights`** skill. The report's
"Insights roadmap" section is sourced from it: `report` shells out to the sibling
`improve-insights/scripts/improve.mjs roadmap --json` (resolved next to this skill; no
hardcoded install path) and embeds the result (section is omitted gracefully if that skill
is absent). For suggestions or to add a metric/chart,
invoke `/improve-insights`.