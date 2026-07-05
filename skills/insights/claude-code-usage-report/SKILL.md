---
name: claude-code-usage-report
description: Generates interactive HTML report of Claude Code session cost, token usage, and efficiency from local data. Use when the user invokes /claude-code-usage-report, asks for stats/insights/cost/token-usage trends. Stdlib only, runs locally.
metadata:
  version: 1.0.0
---

# claude-code-usage-report

Interactive HTML "Claude Code Usage Report" — session cost, token usage, efficiency, usage patterns — read from `~/.agents/.claude-code-usage-report/state/stats.csv`. Self-contained HTML, no external libs, persisted at `~/.agents/.claude-code-usage-report/reports/report-<timestamp>.html` (mode 0600 on POSIX; a no-op on Windows/NTFS). Day/Month toggle. Full column list lives in `stats.mjs`; trailing statusline-fed columns are forward-only (0/blank for older rows), duration/turns/tool_calls backfill from transcripts.

`SKILL_DIR` = this skill's directory. Runs via `node` (ships with Claude Code, on PATH). Fresh machine: install first — `node <SKILL_DIR>/scripts/stats.mjs install` (writes SessionEnd hook + creates dirs; see INSTALL.md).

## Steps

1. Render: `node <SKILL_DIR>/scripts/stats.mjs report`. The command first refreshes stats.csv from all transcripts + any lingering cost-state snapshots (excluding the active session), then renders — no manual backfill needed. The mid-flight active session is skipped (its transcript/cost-state are incomplete); everything else is brought current.
2. Script writes the report, prints its absolute path, and auto-opens it in the OS default browser (`USAGE_REPORT_BROWSER=firefox|chrome|...` to override). If browser launch fails, the path is still printed — open manually.
3. Manual `backfill` rebuilds from all transcripts unconditionally — escape hatch for after migration or a corrupted stats.csv. Run while no Claude Code session is active.

### Pre-op cost estimate

`node <SKILL_DIR>/scripts/stats.mjs estimate <category>` (planning|execution|verification|orchestration|other; prefix ok) prints historical p50/p90/mean cost + typical turns/output for that op category, derived from recorded `total_cost_usd` redistributed across transcript ops. Priors cache to `~/.agents/.claude-code-usage-report/state/priors.json`, lazy-rebuild when stale (>7d or a newer transcript landed); `stats.mjs priors` forces a rebuild. With a live statusline snapshot it also adds a context re-read floor for the current op.

Live capture is automatic via the SessionEnd hook (`stats.mjs record`): reads the full statusline JSON snapshot from `~/.agents/.claude-code-usage-report/state/cost-state/<sid>.json` (written verbatim by your statusline — last write per session wins) for cost/duration/lines/rate-limits/context, plus tokens/turns/tool_calls/last_model + transcript facets (tool mix, errors, subagents, skills, project cwd/branch, compactions → `facets_json`) from the session transcript JSONL. Also appends raw statusline JSON to `~/.agents/.claude-code-usage-report/state/sessions.jsonl` (archive) and deletes the cost-state file. No manual step for new sessions.

## Capture contract (statusline)

Hard requirement for live cost/duration/lines/rate-limit/context capture: **your statusline must write the raw statusline JSON payload (the stdin it receives) to `~/.agents/.claude-code-usage-report/state/cost-state/<session_id>.json` on each render** — last write per session wins (≈ final snapshot). A cross-platform statusline ships at `<SKILL_DIR>/scripts/statusline.mjs` (model, context-usage bar, cost, rate limits, dir, worktree, git status). `install --with-statusline` copies it into `~/.claude/` and wires the `statusLine` setting to `node "<path>"` (skipped if you already have a statusLine command — add the file write to your own statusline instead). Optional: without it, `record` exits early and the report renders from transcripts only (cost/duration/lines/rate-limits blank, populated once a statusline is wired).

## Conventions

- **Token-legend pills** (Token Economics) filter the bar chart with **solo/deselect** semantic, not independent per-pill hide/show: empty `TOK_ACTIVE` = all series visible; click a pill → solos that series; click again → drops it, back to all when set empties; `All` resets. `tokVis()` returns `Array.from(TOK_ACTIVE)` (or all keys when empty) — must be an array, not a Set (`tokenBars` calls `.indexOf`). Do not change to independent-toggle without an explicit ask.
- **$/hour** — no per-session duration cap (legit sessions can exceed 8h); only the `$0`-cost filter drops idle/hung sessions.
- **$/line** gated at 5% line-coverage (`LINE_COV=0.05`); below shows `—`.
- **Rate-limit panel** (5h/7d) is forward-only from the statusline `rate_limits` field (Claude Code v2.1.80+, Claude.ai Pro/Max only — absent for API-key/Bedrock/Vertex and some Max 20x oauth users). Empty-state notice when no rl-bearing sessions; `rl_5h_pct`/`rl_7d_pct` are floats, read with `_fnum` (not `_inum`), displayed `toFixed(1)`. Capped `>=99.5` (float noise), near-cap `>=80`.
- All rendering client-side: report embeds `var SESSIONS=[...]` JSON + a JS IIFE that aggregates and renders every section; date-range controls re-filter → re-aggregate → re-render.

## Scope & the claude-code-usage-report-suggestions skill

This skill: **collect, visualize, estimate** from local session-cost data (record + backfill stats.csv, render the HTML report, `estimate`/`priors` for pre-op cost prediction — estimation derives from the same recorded cost + transcripts, so it lives here with the data layer). Deciding *what new insights to add* and *how to improve the report* belongs to the sibling **`claude-code-usage-report-suggestions`** skill. The report's "Usage roadmap" section is sourced from it: `report` shells out to `claude-code-usage-report-suggestions/scripts/improve.mjs roadmap --json` (resolved next to this skill; no hardcoded install path) and embeds the result (section omitted gracefully if that skill is absent). To add a metric/chart, invoke `/claude-code-usage-report-suggestions`.