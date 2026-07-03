# Claude Code Insights — Design System

A living style guide for the Insights report, in the "paper-and-clay" visual language.
The runnable reference is [`design-system.html`](design-system.html) — open it and toggle the
theme (top-right) to see every token and component in both light and dark modes.

> **Source of truth:** tokens and existing components are lifted verbatim from
> [`original.html`](original.html). New components are designed to match it — they do **not**
> copy `original-report.html`, which was used only to spot which components were missing.

---

## Design System Audit

### Summary
**Components reviewed:** 17 · **Net-new added:** 8 · **Hardcoded values found:** low (tokenized) · **Score:** 88/100

`original.html` is already token-driven and internally consistent — a strong base. The gaps were
coverage, not quality: no part-to-whole chart, no long-form text container, and no interactive
primitives (buttons, tabs, chips) for sections that need them.

### Token Coverage
| Category | Defined | Notes |
|----------|---------|-------|
| Colors | 20+ vars, both themes | ✅ All component colors reference vars; no stray hex in components |
| Typography | 3 families, fluid `clamp()` sizes | ✅ Consistent; no ad-hoc font stacks |
| Spacing | Implicit in original → **formalized** here (`--s1..--s7`) | ⚠️ Original used literal px; scale now documented |
| Radius | **Formalized** here (`--r-sm..--r-pill`) | ⚠️ Same — values were consistent but unnamed |
| Shadow / elevation | 1 card shadow + 3-step ramp shown | ✅ |

### Component Completeness (after this pass)
| Component | States | Variants | Theme-aware | Score |
|-----------|--------|----------|-------------|-------|
| Card / stat card | ✅ | ✅ | ✅ | 10/10 |
| Bar-list, gauge, area, heatmap | ✅ | — | ✅ | 9/10 |
| Table, roadmap card | ✅ | ✅ | ✅ | 9/10 |
| **Pie / donut** ★ | ✅ | pie + donut | ✅ | 9/10 |
| **Multi-column text** ★ | ✅ | editorial + structured | ✅ | 9/10 |
| Column chart / scatter / calendar ★ | ✅ | — | ✅ | 8/10 |
| Buttons / chips / tabs / notes ★ | ✅ | 3 each | ✅ | 9/10 |

### Priority Actions (done in this pass)
1. ✅ Added **pie/donut**, **multi-column text card** (the two explicit requests).
2. ✅ Filled chart gaps flagged by the report: column chart, scatter, calendar heatmap.
3. ✅ Added interaction primitives (buttons, tabs, chips, callouts) so future interactive sections stay on-language.
4. ▫️ *Future:* extract the CSS into a shared stylesheet once a second page consumes it (currently inlined per the report's single-file convention).

---

## Tokens (reference)

All are theme-aware CSS custom properties on `:root` / `[data-theme="dark"]`.

| Group | Tokens |
|-------|--------|
| Surface | `--paper`, `--paper-2`, `--paper-3`, `--card`, `--card-2`, `--card-brd` |
| Ink | `--ink`, `--ink-soft`, `--ink-faint` |
| Line | `--line`, `--line-soft` |
| Accent | `--clay`, `--clay-deep`, `--amber`, `--sage`, `--azure`, `--red` |
| Semantic | `--pos` (=sage), `--neg` (=red) |
| Type | `--disp` Bricolage Grotesque, `--body` Inter, `--mono` JetBrains Mono |
| Spacing | `--s1`4 · `--s2`8 · `--s3`12 · `--s4`16 · `--s5`22 · `--s6`32 · `--s7`48 |
| Radius | `--r-sm`7 · `--r-md`12 · `--r-lg`16 · `--r-xl`22 · `--r-pill`999 |
| Effects | `--card-shadow`, `--glow-a/b/c`, `--grain` |

**Chart palette order** (fixed, so series colours stay stable across charts):
`--clay → --amber → --sage → --azure → --ink-soft`.

---

## Component: Pie / Donut ★ new

### Description
Part-to-whole composition — token mix, tool mix, cost share by model. Prefer the **donut**
(default): its hole carries the total. Use the **pie** (dense variant) only when the hole would
waste space or you're showing many small slices.

### Variants
| Variant | Use when | Render |
|---------|----------|--------|
| Donut | You have a meaningful total to show in the centre | `drawDonut(id, legendId, data, {centerVal, centerSub})` |
| Pie | Dense breakdown, no centre label needed | `drawPie(id, legendId, data)` |

### Data shape
```js
[{ k: 'cache read', v: 88, c: '--sage' }, …]   // v = raw value; % is computed
```

### States & behaviour
| State | Behaviour |
|-------|-----------|
| Default | Segments in palette order, 1.5px paper-coloured gap between wedges |
| Reveal | `opacity 0→1` + slight `rotate/scale` settle (0.9s), skipped under reduced-motion |
| Legend | Swatch · label · computed percentage, one row per slice |

### Accessibility
- Each wedge/segment carries a `<title>` for hover; legend restates every value as text.
- Colour is never the only signal — the legend labels each slice.
- Honours `prefers-reduced-motion` (renders final state, no animation).

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Keep to ≤6 slices; group the tail into "other" | Use for time series — reach for the area or column chart |
| Use the donut centre for the grand total | Recolour slices outside the shared palette |

---

## Component: Multi-column text card ★ new

### Description
Long-form copy that lives inside the card system — executive summaries, methodology, changelogs.

### Variants
| Variant | Class | Use when |
|---------|-------|----------|
| Editorial | `.coltext` | One continuous narrative; balanced columns + drop-cap |
| Structured | `.colcards` | Parallel points; numbered, headed columns with dividers |

### States
| State | Behaviour |
|-------|-----------|
| Default | Editorial: `column-count:3` with `column-rule`. Structured: 3-col grid with right-dividers |
| Responsive | ≤900px → 2 cols (editorial) / stacked with bottom-dividers (structured); ≤640px → 1 col |

### Accessibility
- Real flowing text (selectable, reflows, screen-reader friendly) — not images.
- Drop-cap is decorative `::first-letter`; reading order is unaffected.

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Use editorial for prose, structured for parallel points | Put tables or charts inside `column-count` (they'll split) |
| Keep structured to 3 columns max | Nest cards inside cards |

---

## Component inventory

**Carried over from `original.html`:** topbar, segmented control, status pill, icon button,
hero/terminal, big-number flagcard, delta badge, stat card + sparkline, area chart, radial gauge,
stacked token bar + legend, horizontal bar-list, activity heatmap, data table, roadmap status
cards, footer.

**Added in this pass (★):** pie/donut, multi-column text card, vertical column chart, scatter
plot, calendar heatmap, buttons (primary/secondary/ghost + sizes), chips/badges, tabs, callout/note
(default/info/warn/ok), filterable legend, jump-nav.

---

## Extending the system

1. **Start from a token.** Never introduce a raw hex, px radius, or font stack — reference a
   variable so both themes and the grain/glow stay coherent.
2. **Match the card contract.** New panels use `.card` (glass, blur, `--card-shadow`, `22px` radius)
   with a `.card > h3` mono uppercase label.
3. **Numbers are monospace.** Every figure uses `--mono`; prose uses `--body`; headings use `--disp`.
4. **Colour charts from the shared palette** in fixed order; pair every chart with a text legend.
5. **Animate on reveal, degrade gracefully.** Use the `.rv` reveal pattern and guard animations
   behind `prefers-reduced-motion`.
6. **Verify in both themes** before shipping — toggle the guide and check contrast.
