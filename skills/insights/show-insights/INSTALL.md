# Installing show-insights (cross-machine)

Interactive HTML Claude Code Insights report (cost, tokens, efficiency, usage patterns) from `~/.agents/.show-insights/state/stats.csv` + session transcripts. Node stdlib only, all data local.

## Prerequisites

- **Claude Code** (provides `~/.claude/projects/*/*.jsonl` transcripts + statusline JSON payload).
- **Node** on PATH (ships with Claude Code, guaranteed).
- This skill at `~/.agents/skills/show-insights/` (or anywhere — paths resolve relative to the script, install location not hard-coded).

## Install

```
node <SKILL_DIR>/scripts/stats.mjs install
```

Idempotently writes the `SessionEnd` hook into `~/.claude/settings.json` (`node "<abs>/stats.mjs" record` — refuses to overwrite a record-hook pointing at a *different* stats.mjs unless `--force`) and creates `~/.agents/.show-insights/state/cost-state/` + `~/.agents/.show-insights/reports/`.

Flags:
- `--dry-run` — print planned changes, write nothing.
- `--force` — replace a foreign SessionEnd record-hook.
- `--with-statusline` — also install the reference statusline (`scripts/statusline.mjs`) into `~/.claude/` and wire `statusLine` to `node "<path>"`. Skipped if you already have a `statusLine` command (add the contract write to your own statusline instead — see below).

## Capture contract (statusline)

Live cost/duration/lines/rate-limit/context capture needs your statusline to write the raw statusline JSON (the stdin it receives) to `~/.agents/.show-insights/state/cost-state/<session_id>.json` on each render — last write per session wins. Reference statusline at `<SKILL_DIR>/scripts/statusline.mjs`; `install --with-statusline` wires it. **Optional**: without it the report renders from transcripts only (cost/duration/lines/rate-limits blank, populated once a statusline is wired).

## Generate a report

```
node <SKILL_DIR>/scripts/stats.mjs report
```

`report` refreshes stats.csv from all transcripts + any lingering cost-state snapshots (excluding the active session) before rendering — no manual backfill needed. Use `backfill` only as a manual escape hatch (e.g. after migration; run while no session is active).

Report opens in your OS default browser (`INSIGHTS_BROWSER=firefox|chrome|...` to override). Path: `~/.agents/.show-insights/reports/report-<timestamp>.html`.

## Uninstall

- Remove the `SessionEnd` hook from `~/.claude/settings.json` (command ends with `stats.mjs" record`).
- Optionally delete `~/.agents/.show-insights/state/` and `~/.agents/.show-insights/reports/`.
- If you installed the reference statusline, restore your prior `statusLine` setting.

## improve-insights (companion)

The report's roadmap comes from the sibling `improve-insights` skill, resolved next to this one (no hardcoded path). No hooks of its own — install show-insights and the roadmap works automatically; section omitted gracefully if improve-insights is absent.