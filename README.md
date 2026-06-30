# samteong-skills

Claude Code agent skills by SamTeong.

## Skills

### insights

- [`show-insights`](skills/insights/show-insights/SKILL.md) — collect, visualize, and estimate from local Claude Code session-cost data. Renders an interactive HTML Insights report from `~/.agents/.show-insights/state/stats.csv`.
- [`improve-insights`](skills/insights/improve-insights/SKILL.md) — audit and improve the insights pipeline end-to-end (collection, schema, aggregation, visualization). Companion to `show-insights`.

## Install

Each skill is self-contained (Node stdlib only; `node` ships with Claude Code). See each skill's `SKILL.md` / `INSTALL.md`.

`show-insights` install (writes the `SessionEnd` hook + creates state dirs):

```
node <skill-dir>/scripts/stats.mjs install
```

`improve-insights` has no hooks of its own — install `show-insights` and the roadmap section works automatically.

## License

MIT