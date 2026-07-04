---
name: improve-usage-report
description: Audit and improve the Claude Code Insights pipeline end-to-end — collection, CSV schema, aggregation, usage-report report/visualizations. Use when the user invokes /improve-usage-report, asks to improve/audit the insights report, or wants new metrics/charts. Produces a prioritized roadmap; implements chosen items by editing usage-report' stats.mjs. Read-only until approved. Node stdlib only, runs locally.
---

# improve-usage-report

Companion to `usage-report` (single responsibility: that skill *collects*/*visualizes*; this skill *improves* the whole pipeline). Two modes: **advise** (default — prioritized roadmap) and **implement** (on request — make the change).

`SKILL_DIR` = this skill's directory. Runs via `node` (ships with Claude Code, on PATH). usage-report is a sibling — its `scripts/stats.mjs` is resolved next to this skill (no hardcoded install path) and read as the data layer. No hooks of its own; only reads usage-report' data, invoked by usage-report' report.

## Pipeline it covers (audit each layer)

1. **Collection** — statusline stashes full statusline JSON to `~/.agents/.usage-report/state/cost-state/<sid>.json` (see usage-report' capture contract; reference statusline at `usage-report/scripts/statusline.mjs`); SessionEnd hook `stats.mjs record` projects it + transcript-derived fields into `stats.csv` and archives raw JSON to `~/.agents/.usage-report/state/sessions.jsonl`.
2. **Schema/storage** — `stats.csv` columns + the `facets_json` blob (tools, errors, agents, skills, cwd/branch, compactions).
3. **Aggregation** — `_load_stats()` single-pass reader → days/months/per_model/totals/usage/projects.
4. **Visualization** — `report` renders the self-contained HTML (KPIs, charts, heatmaps, tables).

## Steps

### Advise (default)
1. Generate the roadmap (introspects local data + current coverage): `node <SKILL_DIR>/scripts/improve.mjs roadmap` (`--json` for machine-readable output — what `usage-report` calls to embed its "Insights roadmap" section).
2. Read the output. Each item tagged:
   - `available` — data on disk, not yet charted (highest leverage).
   - `partial` — captured forward-only; coverage grows as sessions record.
   - `idea` — viz/UX improvement.
3. Present roadmap grouped by pipeline layer; recommend top 2–3 by value-for-effort. Look beyond the script's catalog — inspect `stats.mjs` and a freshly rendered report for concrete gaps (missing axis labels, dense sections, slow queries).

### Implement (only when the user picks items)
4. For each chosen item, edit the relevant layer in `usage-report`:
   - new transcript metric → extend `parse_transcript` + `_merge_facets` (retroactive via backfill).
   - new statusline field → `_extract_state` + the user's statusline (forward-only; reference at `usage-report/scripts/statusline.mjs`).
   - new column → `HEADER`/`COLS` + both row builders.
   - new chart/stat → add a `svg*`/`*Bars`/`barChart`/aggregator in `sources/app.js` + wire into its client-side `render()`; add the section shell + any new embedded field in `render.mjs`.
   - update the roadmap catalog in `improve.mjs` so the item flips to "done"/drops off.
5. Verify end-to-end (back up `stats.csv` first):
   - `cp ~/.agents/.usage-report/state/stats.csv <scratch>/stats.csv.bak`
   - `node <usage-report>/scripts/stats.mjs backfill` → confirm `with_cost` count preserved.
   - `node <usage-report>/scripts/stats.mjs report` → confirm new output renders, light+dark.
   - Node smoke-test embedded JS if touched.

## Notes
- Read-only until the user approves an edit. Never run `backfill` without backing up `stats.csv` first (it rewrites the file; a join bug can drop live-recorded cost).
- Keep `usage-report` lean — implementation edits land in its files, not new responsibilities here.