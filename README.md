# samteong-skills

Claude Code agent skills by SamTeong.

## Skills

### insights

- [`claude-code-usage-report`](skills/insights/claude-code-usage-report/SKILL.md) — collect, visualize, and estimate from local Claude Code session-cost data. Renders an interactive HTML usage report from `~/.agents/.claude-code-usage-report/state/stats.csv`.
- [`claude-code-usage-report-suggestions`](skills/insights/claude-code-usage-report-suggestions/SKILL.md) — audit and improve the insights pipeline end-to-end (collection, schema, aggregation, visualization). Companion to `claude-code-usage-report`.

## Design system

[`design-system/`](design-system/DESIGN-SYSTEM.md) is the shared "paper-and-clay" visual language for the Insights report — tokens, components, and usage rules. [`design-system.html`](design-system/design-system.html) is the runnable reference (open it, toggle the theme). The report renderer (`claude-code-usage-report/scripts/sources/`) implements it; code comments cite it by component name.

## Install

Each skill is self-contained (Node stdlib only; `node` ships with Claude Code). See each skill's `SKILL.md` / `INSTALL.md`.

`claude-code-usage-report` install (writes the `SessionEnd` hook + creates state dirs):

```
node <skill-dir>/scripts/stats.mjs install
```

`claude-code-usage-report-suggestions` has no hooks of its own — install `claude-code-usage-report` and the roadmap section works automatically.

## License

MIT