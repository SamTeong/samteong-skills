# Installing show-insights (cross-machine)

Generates an interactive HTML Claude Code Insights report (cost, tokens, efficiency,
usage patterns) from `~/.agents/.show-insights/state/stats.csv` and session transcripts.
Node stdlib only, all data local.

## Prerequisites

- **Claude Code** installed (provides `~/.claude/projects/*/*.jsonl` transcripts + the
  statusline JSON payload).
- **Node** on PATH. Node ships with Claude Code (guaranteed on PATH).
- This skill at `~/.agents/skills/show-insights/` (or anywhere — paths resolve relative
  to the script, so the install location is not hard-coded).

## Install

```
node <SKILL_DIR>/scripts/stats.mjs install
```

What it does:
- Idempotently writes the `SessionEnd` hook into `~/.claude/settings.json`:
  `node "<abs>/stats.mjs" record` — refuses to overwrite a record-hook pointing at a
  *different* stats.mjs unless you pass `--force`.
- Creates `~/.agents/.show-insights/state/cost-state/` and `~/.agents/.show-insights/reports/`.

Flags:
- `--dry-run` — print planned changes, write nothing.
- `--force` — replace a foreign SessionEnd record-hook.
- `--with-statusline` — also install the cross-platform reference statusline
  (`statusline.mjs`) into `~/.claude/` and wire the `statusLine` setting to `node "<path>"`.
  Skipped if you already have a `statusLine` command (add the contract write to your own
  statusline instead — see below). `node` ships with Claude Code (guaranteed on PATH).

## Capture contract (statusline)

Live cost/duration/lines/rate-limit/context capture needs your statusline to write the
raw statusline JSON (the stdin it receives) to
`~/.agents/.show-insights/state/cost-state/<session_id>.json` on each render — last write
per session wins. The reference statusline ships at
`<SKILL_DIR>/statusline/statusline.mjs`; `install --with-statusline` wires it for you. The statusline
is **optional**: without it the report still renders from transcripts only
(cost/duration/lines/rate-limits blank, populated once a statusline is wired).

## Generate a report

```
node <SKILL_DIR>/scripts/stats.mjs backfill   # first run, or to refresh from transcripts
node <SKILL_DIR>/scripts/stats.mjs report
```

The report opens in your OS default browser. Set `INSIGHTS_BROWSER=firefox|chrome|...`
to override. Report path: `~/.agents/.show-insights/reports/report-<timestamp>.html`.

## Uninstall

- Remove the `SessionEnd` hook entry from `~/.claude/settings.json` (the one whose
  command ends with `stats.mjs" record`).
- Optionally delete `~/.agents/.show-insights/state/` and `~/.agents/.show-insights/reports/`.
- If you installed the reference statusline, restore your prior `statusLine` setting.

## improve-insights (companion)

The roadmap embedded in the report comes from the sibling `improve-insights` skill,
resolved next to this one (no hardcoded path). It has no hooks of its own — install
show-insights and the roadmap works automatically; the section is omitted gracefully if
improve-insights is absent.