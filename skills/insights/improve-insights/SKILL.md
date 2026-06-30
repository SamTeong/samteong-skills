---
name: improve-insights
description: Audit and improve the Claude Code Insights pipeline end-to-end — metrics collection (statusline + transcripts), CSV schema, aggregation, and the show-insights HTML report/visualizations. Use whenever the user invokes /improve-insights, asks "improve my insights/stats report", "what other insights can I add", "what's missing from the insights report", "make the insights report better", "audit the insights pipeline", or wants new metrics/charts added. Produces a prioritized roadmap (data you have but don't chart, capture gaps, viz/UX ideas) and, on request, implements chosen items by editing show-insights' stats.mjs / statusline.mjs. Read-only until you approve an edit. Node stdlib only, runs locally.
metadata:
  version: 1.0.0
---

# improve-insights

Companion to the `show-insights` skill (single responsibility: that skill *collects* and
*visualizes*; this skill *improves* the whole pipeline). Two modes: **advise** (default —
produce a prioritized roadmap) and **implement** (on request — make the change).

`SKILL_DIR` = this skill's directory. Runs via `node` (ships with Claude Code, on PATH).
show-insights is a sibling skill — its `scripts/stats.mjs` is
resolved next to this skill (no hardcoded install path) and read as the data layer. No
hooks of its own; it only reads show-insights' data and is invoked by show-insights' report.

## Pipeline it covers (audit each layer)

1. **Collection** — your statusline stashes the full statusline JSON to `~/.agents/.show-insights/state/cost-state/<sid>.json`
   (see show-insights' capture contract; reference statuslines ship in show-insights'
   `statusline/` dir); SessionEnd hook `stats.mjs record` projects it + transcript-derived
   fields into `stats.csv` and archives the raw JSON to `~/.agents/.show-insights/state/sessions.jsonl`.
2. **Schema/storage** — `stats.csv` columns + the `facets_json` blob (tools, errors, agents,
   skills, cwd/branch, compactions).
3. **Aggregation** — `_load_stats()` single-pass reader → days/months/per_model/totals/usage/projects.
4. **Visualization** — `report` renders the self-contained HTML (KPIs, charts, heatmaps, tables).

## Steps

### Advise (default)
1. Generate the roadmap (introspects local data + current coverage):
   `node <SKILL_DIR>/scripts/improve.mjs roadmap`
   (`--json` for machine-readable output; this is what `show-insights` calls to embed the
   "Insights roadmap" section in its report.)
2. Read the output. Each item is tagged:
   - `available` — data already on disk, not yet charted (highest leverage).
   - `partial` — captured forward-only; coverage grows as sessions record.
   - `idea` — viz/UX improvement.
3. Present the roadmap to the user grouped by pipeline layer; recommend the top 2–3 by
   value-for-effort. Look beyond the script's catalog — inspect `stats.mjs` and a freshly
   rendered report for concrete gaps (missing axis labels, dense sections, slow queries).

### Implement (only when the user picks items)
4. For each chosen item, edit the relevant layer in `show-insights`:
   - new transcript metric → extend `parse_transcript` + `_merge_facets` (retroactive via backfill).
   - new statusline field → `_extract_state` + the user's statusline (forward-only; the reference is the cross-platform `show-insights/statusline/statusline.mjs`).
   - new column → `HEADER`/`COLS` + both row builders.
   - new chart/stat → add a `_svg_*`/`_*_bars`/aggregator + wire into `_render`.
   - update the roadmap catalog in `improve.mjs` so the item flips to "done"/drops off.
5. Verify end-to-end (back up `stats.csv` first):
   - `cp ~/.agents/.show-insights/state/stats.csv <scratch>/stats.csv.bak`
   - `node <show-insights>/scripts/stats.mjs backfill` → confirm `with_cost` count is preserved.
   - `node <show-insights>/scripts/stats.mjs report` → confirm the new output renders, light+dark.
   - Node smoke-test embedded JS if you touched it.

## Notes
- Read-only until the user approves an edit. Never run `backfill` without backing up `stats.csv`
  first (it rewrites the file; a join bug can drop live-recorded cost).
- Keep `show-insights` lean — implementation edits land in its files, not new responsibilities here.
