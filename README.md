# samteong-skills

Claude Code agent skills by SamTeong.

## Skills

### insights

- [`usage-report`](skills/insights/usage-report/SKILL.md) — collect, visualize, and estimate from local Claude Code session-cost data. Renders an interactive HTML Insights report from `~/.agents/.usage-report/state/stats.csv`.
- [`improve-usage-report`](skills/insights/improve-usage-report/SKILL.md) — audit and improve the insights pipeline end-to-end (collection, schema, aggregation, visualization). Companion to `usage-report`.

## Install

Each skill is self-contained (Node stdlib only; `node` ships with Claude Code). See each skill's `SKILL.md` / `INSTALL.md`.

`usage-report` install (writes the `SessionEnd` hook + creates state dirs):

```
node <skill-dir>/scripts/stats.mjs install
```

`improve-usage-report` has no hooks of its own — install `usage-report` and the roadmap section works automatically.

## License

MIT