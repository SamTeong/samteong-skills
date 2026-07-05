# Claude Code Insights — Design System

A living style guide for the Insights report, in the "paper-and-clay" visual language.
The runnable reference is [`design-system.html`](design-system.html) — open it and toggle the
theme (top-right) to see every token and component in both light and dark modes.

> **Source of truth:** the runnable reference above (`design-system.html`) consolidates every
> token and component. Tokens and the carried-over components were lifted verbatim from the
> original Insights report; net-new components are designed to match it.

---

## Design System Audit

### Summary
**Components reviewed:** 21 · **Net-new added:** 12 · **Hardcoded values found:** low (tokenized) · **Score:** 88/100

The original report is already token-driven and internally consistent — a strong base. The gaps were
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
| **Section floating sidebar** ★ | ✅ | collapsed + expanded | ✅ | 9/10 |
| **Metric / ratio card** ★ | ✅ | dual · single+spark · compact trio | ✅ | 9/10 |
| **Grouped stat list** ★ | ✅ | 2-col · 3-col · plain | ✅ | 9/10 |
| **Section header** ★ | ✅ | 6 configs · filter pill · overflow | ✅ | 9/10 |

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

## Component: Section header ★ new

### Description
The one shell every section opens with — so a report of a dozen sections reads as a single document
instead of a dozen ad-hoc layouts. It scales from a bare title up to a title with a wrapping filter
row and a right-aligned toggle, without the pieces ever drifting out of alignment.

### Configurations
| # | Config | Contents |
|---|--------|----------|
| A | Title only | `.shead-title` (`h2` + `.sub`) |
| B | + paragraph | A adds a `.lede` under the title for a sentence of framing |
| C | + filters | A adds a `.shead-controls` with a `.shead-filters` row (no toggle) |
| D | + filters + toggle | C adds a `.shead-toggle` (`.seg`) pinned right |
| E | Overflow | Many filters **wrap** to multiple rows; the toggle holds the top-right line |
| F | Label + ghost toggle | A leading `.shead-flabel` + a single `.fpill.ghost` (the roadmap case) |

### Structure
```html
<header class="shead">
  <div class="shead-title"><h2>Breakdown</h2><span class="sub">cost by day or month</span></div>
  <p class="lede">…optional paragraph…</p>
  <div class="shead-controls">
    <div class="shead-filters">
      <button class="fpill"><i class="fdot" style="background:var(--clay)"></i>claude-opus-4-8</button>
      …
      <button class="fpill on" data-all>all</button>
    </div>
    <div class="shead-toggle"><div class="seg"><button class="on">by day</button><button>by month</button></div></div>
  </div>
</header>
```

### The alignment rule (why it reads with low friction)
- `.shead` sets a single `--ctl-h` (34px). **Both** the filter pills and the segmented-toggle buttons
  are sized to it, so their text sits on the same centre line.
- `.shead-controls` is `flex-wrap:nowrap` with `align-items:flex-start`; `.shead-filters` is
  `flex:1 1 0` and wraps **internally**. Result: filters overflow onto new rows while the toggle
  stays pinned to the top-right, level with the **first** filter row — never pushed below it.
- On ≤640px the controls switch to a column (toggle drops under the filters, full-width).

### Filter pill (`.fpill`) — new sub-component
| Variant | Use | Visual |
|---------|-----|--------|
| Default | A selectable filter | Glass pill, `--card-2`, mono label; optional `.fdot` colour swatch |
| `.on` | Active / "all" reset | Solid `--clay`, white text |
| `.off` | Deselected | Dimmed to 0.42 opacity — still readable, clearly inactive |
| `.ghost` | Low-emphasis single action | Transparent, uppercase; clay on hover (the roadmap "show available") |

Interaction wired in the guide: range groups (`data-single` — "last 7 days" etc.) are exclusive;
model groups toggle `.off` per pill and drop the `[data-all]` pill's `.on` when any is hidden; the
`all` pill resets. The segmented toggle (`.seg`) switches `.on` between its buttons.

### States
| State | Behaviour |
|-------|-----------|
| Default | Title anchors; controls quiet until hovered |
| Hover (pill) | Lifts 1px, ink darkens |
| Active (pill / toggle) | Solid clay with a soft clay glow |
| Overflow | Filters wrap to 2–3 rows; toggle stays aligned to row one |
| Reduced-motion | Lift/colour transitions collapse to instant |

### Tokens used
- Control height `--ctl-h` (34px, local); radius `--r-pill`; surface `--card-2` / `--card-brd`; shadow `--card-shadow`
- Type: `h2` = `--disp`; `.sub`/pills/toggle = `--mono`; paragraph = `--body` via `.lede`
- Accent: `--clay` (active), colour swatches from the shared chart palette

### Accessibility
- Filters and toggles are real `<button>`s — tab-focusable, and the shared `:focus-visible` clay ring applies.
- The colour swatch is paired with the model's text label, so filters aren't colour-only.
- Wrapping preserves DOM/reading order; the toggle stays a sibling of the filters (announced together).

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Use this shell for **every** section, even title-only ones | Hand-roll a one-off header that breaks the rhythm |
| Let filters wrap; keep the toggle pinned top-right | Shrink pills or the toggle to force one row — breaks the shared height |
| Keep the subtitle to a short mono phrase | Put a second sentence in `.sub` — that's what `.lede` is for |
| Pair every colour swatch with a text label | Rely on the swatch colour alone to name a filter |

---

## Component: Grouped stat list ★ new

### Description
A handful of **label → value** rows split into two or three columns — the *Cadence / Delivery /
Cost spread* and *Tool calls / Context / Ecosystem* cards. It's for data that's table-shaped but too
sparse to justify a real `.tbl` (no shared row keys across columns, 1–4 rows each).

### What it fixes (vs. the old layout)
| Problem | Fix |
|---------|-----|
| Column headers set in the **display sans** over monospace rows — read as foreign | Header uses the system's **mono-uppercase** label, matching every other card label |
| Header just floated above the rows | Header is anchored by a `--line` **bottom rule** — a scaled-down table-header treatment |
| Ragged gutters; dividers looked uneven when columns had different row counts | Even gutters (`clamp(20px,3vw,32px)` each side of the divider) and `align-items:stretch` so **every divider is full-column height** regardless of row count |
| Label/value cramped, numbers not aligned | Grid `1fr auto`, values `tabular-nums`, right-aligned |

### Structure
```html
<div class="statgroups cols-3">        <!-- cols-2 | cols-3 ( + .plain ) -->
  <div class="statgroup">
    <div class="gh">Cadence</div>       <!-- mono-uppercase header + rule -->
    <div class="kv"><span class="k">turns / session</span><span class="v">2.3</span></div>
    <div class="kv"><span class="k">tools / session</span><span class="v">17.9</span></div>
  </div>
  …
</div>
```

### Variants
| Variant | Class | Use when |
|---------|-------|----------|
| Two / three columns | `.statgroups.cols-2` / `.cols-3` | 2–3 groups of related rows; sits full-width in the report |
| Ruled (default) | `.statgroups` | Light `--line-soft` hairline between rows — table-lite density |
| Plain | `.statgroups.plain` | Drops row rules; leans on spacing — airier, for shorter lists |
| Muted row | `.kv.muted` | Zero / empty values render in `--ink-faint` so they recede |

### Parts & tokens
| Part | Class | Token |
|------|-------|-------|
| Group header | `.gh` | `--mono` upper, `--ink`; bottom rule `--line` |
| Row label | `.kv .k` | `--mono`, `--ink-faint`; ellipsis if it can't fit |
| Row value | `.kv .v` | `--mono` 700, `--ink`, `tabular-nums`; unit `.u` in `--ink-faint` |
| Column divider | `.statgroup + .statgroup` | `border-left: --line-soft`, full height |
| Row divider | `.kv + .kv` | `border-top: --line-soft` (removed by `.plain`) |

### States
| State | Behaviour |
|-------|-----------|
| Default | Header anchors the column; labels quiet, values are the emphasis |
| Sparse column | Fewer rows than its neighbours — divider still spans the full height |
| Muted | `.kv.muted` dims a zero/empty value without dropping the row |
| Responsive | ≤640px columns stack; vertical dividers become top rules between groups |

### Accessibility
- Real text, selectable and reflowable — labels stay in reading order beside their value.
- Colour isn't load-bearing: muted rows still show the label and figure; the header is bold + ruled, not colour-coded.
- Long labels truncate with an ellipsis rather than breaking the grid — keep labels short, or widen the card.

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Reach for this when a table would have 1–4 rows and no shared columns | Use it for many rows with shared keys — that's the `.tbl` |
| Keep group headers in the mono-uppercase card-label voice | Reintroduce the display-sans header — it breaks the card language |
| Let sparse columns be sparse; the full-height divider holds the grid | Pad a short column with filler rows to "balance" it |
| Use `.plain` for short lists, ruled for denser ones | Mix ruled and plain groups in the same card |

---

## Component: Metric / ratio card ★ new

### Description
For cards where a handful of figures carry the whole story — the **Efficiency ratios** card,
cost-per-unit, throughput, cache multipliers. The number is the hero; every other element earns its
place by giving that number **meaning**. It replaces the old "big number + caption + lots of dead
space" treatment.

### What changed vs. the old card
| Old | New | Why |
|-----|-----|-----|
| Number + tiny unit only | Number + unit **+ eyebrow label** (`Cost / active hour`) | Says *what the ratio measures* without decoding the suffix |
| No sense of movement | Inline **trend delta** (`↘ 6% · 7d`) | A figure means more against its recent baseline |
| Flat captions, empty lower half | One light **micro-visual** — coverage **meter** or **sparkline** | Makes the number scannable, fills space with signal not padding |
| Values in proportional figures | `font-variant-numeric: tabular-nums` | Columns of digits line up across rows |

### Variants
| Variant | Class | Use when |
|---------|-------|----------|
| Dual ratio | `.ratiocard` + 2×`.ratio` | Two related ratios (the Efficiency card); divider between them |
| Single hero + sparkline | `.ratiocard` + `.ratio-spark` | One dominant figure that has a trend worth showing |
| Compact trio | `.ratiocard.compact` | Three tight ratios, label-left / value-right, no dividers |

### Anatomy of a `.ratio`
| Part | Class | Notes |
|------|-------|-------|
| Eyebrow | `.ratio-eyebrow` | Mono, 10px, upper, `--ink-faint` — the metric's name |
| Hero | `.ratio-hero` > `.ratio-val` (`.unit`) | Big mono, `--ink`; unit suffix in `--clay`; delta pushed right |
| Trend | `.delta` (`.up`/`.down`/`.neu`) | `.neu` = neutral grey for cost metrics where a direction isn't "good"/"bad" |
| Context | `.ratio-ctx` (`<b>` = `--ink-soft`) | The supporting counts — kept to one line |
| Meter | `.ratio-meter` > `i[data-w]` | Thin clay progress bar for a %/coverage figure |
| Sparkline | `.ratio-spark[data-h="…"]` | Comma-separated bar heights; last bar `--clay` = current |

### States
| State | Behaviour |
|-------|-----------|
| Default | Number is the visual anchor; supporting text is quiet (`--ink-faint`) |
| Reveal | Meter width and sparkline bars animate up from the baseline (`~1.1s` / `.7s`) |
| Reduced-motion | Meter/spark render at final value with no animation |

### Tokens used
- Surface / line: `.card` contract, `--line-soft` (row divider, meter track)
- Ink: `--ink` (value), `--ink-soft` (context bold), `--ink-faint` (labels)
- Accent: `--clay` (unit suffix, meter fill, current spark bar); `--sage`/`--red` via `.delta`
- Type: `--mono` throughout; `font-variant-numeric: tabular-nums` on values

### Accessibility
- The delta's **colour is backed by its arrow + the `%` text** — never colour alone; `.neu` avoids implying good/bad on cost metrics.
- Meter and sparkline are decorative: every value they encode is already stated in `.ratio-ctx`.
- Honours `prefers-reduced-motion` (no fill animation).

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Give every ratio an eyebrow so the number reads on its own | Rely on a `/unit` suffix alone to convey meaning |
| Use `.delta.neu` when up/down isn't inherently good or bad | Paint a cost increase green just because it points up |
| Keep context to one line; let the number dominate | Stack three visualizations in one card — pick one |
| Use tabular figures so rows align | Mix proportional and tabular numerals in a card |

---

## Component: Section floating sidebar ★ new

### Description
A persistent, edge-anchored navigator for a long single-page report. **Collapsed** it reads as a
slim vertical stadium — one tick per section, the current section in `--clay` (scroll-spy). **On
hover / focus** it opens into the "go to section" menu, where the reader can jump to a section,
**re-order** sections by dragging a row's handle, and **hide** a section with its eye toggle. In
production it lives `position:fixed` against the right edge, vertically centred; the guide places it
inside a `.secnav-stage` so both states are visible at once.

### Anatomy
| Part | Class | Role |
|------|-------|------|
| Rail (collapsed) | `.secnav-rail` > `.secnav-ticks .tick` | Stadium capsule; one tick per section (`.on` = current, `.off` = hidden) |
| Panel (expanded) | `.secnav-panel` | Glass menu card, opens toward the page (`top/right:0`, origin top-right) |
| Top shortcut | `.secnav-top` | "↑ Top" — jump to page start |
| Row | `.secnav-item` (`draggable`) | Grid: **handle · label · eye** |
| Handle | `.secnav-grip` | 6-dot grip, `cursor:grab`; drag to re-order |
| Label | `.secnav-label` | Mono section name; truncates with ellipsis |
| Visibility | `.secnav-eye` (`<button>`) | Eye ⇄ eye-off; toggles `.hidden` on the row |

### States
| State | Trigger | Behaviour |
|-------|---------|-----------|
| Collapsed | default | Rail only; ticks mirror section order + hidden state |
| Expanded | `:hover` / `:focus-within` / `.open` | Panel fades + rises in (`.22s`), rail fades out |
| Row hover | pointer over `.secnav-item` | `--paper-2` wash; grip brightens to `--ink-soft` |
| Dragging | drag a row by its handle | Row at `.5` opacity + shadow; others reflow to the drop point |
| Hidden | click the eye | Label → `--ink-faint` + strike-through; eye→eye-off; matching tick → `.off` (dashed) |

### Behaviour notes
- **Re-order** is HTML5 drag-and-drop scoped to `.secnav-items`; the rail re-syncs on `dragend`.
- **Hide** is a pure toggle — it never removes the row, so it's reversible and the tick still marks the slot.
- The **rail and panel stay in sync**: the collapsed ticks are rebuilt from the live row order and hidden state (`syncRail`).

### Tokens used
- Surface: `--card` (rail), `--card-2` (panel), `--card-brd`, `--card-shadow`, blur `16px`
- Ink / line: `--ink`, `--ink-soft`, `--ink-faint`, `--line`, `--line-soft`; current/active accent `--clay`
- Radius: `--r-pill` (rail), `--r-lg` (panel), `--r-sm` (rows); Type: `--mono` throughout

### Accessibility
- **Role**: panel is `role="menu"`, rows read as controls; eye buttons expose `aria-pressed` + `aria-label` ("Hide {section}").
- **Keyboard**: the rail is focusable and opens the panel on `:focus-within`; Top and eye are real focusable controls. *Open item:* drag-reorder is pointer-only — keyboard reorder (e.g. `⌥↑/↓`) is a documented follow-up.
- **Screen reader**: hidden sections are announced via the eye's pressed state and struck label, not colour alone.
- Honours `prefers-reduced-motion` (open/settle transitions collapse to instant).

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Keep it `fixed` and out of the reading column; open toward the page | Let the panel cover the content it links to |
| Mirror the true section order/visibility in the ticks | Use it as the *only* nav — pair with in-page headings |
| Keep labels to the section's real heading | Hide sections silently — always leave the reversible eye |

---

## Component: Hero ★ new

### Description
The composition every report opens with. The **left column** is a single narrative stack —
eyebrow, a two-line terminal readout, the display headline, then the lead — and the big-number
**flagcard** stands alone in the right column of a `1.35fr / 1fr` grid, top-aligned to the eyebrow
so the two labels (`ZERO TELEMETRY` / `TOTAL SPEND`) rhyme across the gap. Reading the left column
top-to-bottom is the pitch: the terminal ("reading your logs…") is the *preamble* that earns the
headline. It carries the whole first impression, so its rhythm has to read as *intentional* — not a
pile of ad-hoc margins.

### The rhythm rule (why it reads calm)
Every vertical gap resolves to a token on the `--s` scale (`4·8·12·16·22·32·48`), split into two
roles so hierarchy comes through as spacing:

| Role | Tokens | Binds |
|------|--------|-------|
| **Tight pair** — a label to the value it names | `--s1` 4 · `--s2` 8 · `--s3` 12 | eyebrow → terminal · numlbl → flagnum · spark → caption |
| **Block gap** — one stanza from the next | `--s4` 16 · `--s5` 22 | terminal → headline · headline → lead · flagnum → spark · rule → stats |

The terminal reserves **exactly two lines** (`min-height:44px`) — a stable footprint that holds the
top of the column without opening dead space above the headline.

### Anatomy
| Part | Class | Spacing / tokens |
|------|-------|------------------|
| Section padding | `header` | `var(--s6) 0 var(--s2)` (32 top / 8 bottom) |
| Grid | `.hero-grid` | `margin-top:0` (first child after the header padding); `1.35fr / 1fr`; `gap:clamp(24px,4vw,56px)`; `align-items:start` |
| Left column | `.flag` | narrative stack: eyebrow → terminal → headline → lead |
| Eyebrow | `.eyebrow-hero` | mono-upper, `--clay`; no margin (leads the column) |
| Terminal | `.term` | `margin:var(--s3) 0 0`; `min-height:44px` (two lines, no dead space) |
| Headline | `.flag h1.hl` | `--disp`; `margin:var(--s5) 0 0` (terminal → headline block gap) |
| Lead | `.flag .lead` | `margin:var(--s4) 0 0` |
| Flagcard | `.flagcard` | glass card, `padding:var(--s5)` (uniform 22); `align-self:start` top-aligns it to the eyebrow |
| Number label → number | `.numlbl` | `margin-bottom:var(--s2)` |
| Sparkline | `.hero-spark` | `margin-top:var(--s5)`; caption `.sub2` `margin-top:var(--s1)` |
| Stats rule | `.flagstats` | `margin-top:var(--s5)`; `padding-top:var(--s4)`; top rule `--line-soft` |

### States
| State | Behavior | Notes |
|-------|----------|-------|
| Default | Static composition; `.cur` blinks (CSS only — the terminal text is not typed in) | — |
| Loading | Flagcard figures start at `—`, filled from the CSV once parsed | `min-height:44px` gives the terminal a stable two-line footprint so nothing jumps |
| Reveal | Flagcard/sparkline animate up via `.rv` | Guarded by `prefers-reduced-motion` |
| ≤760px | Grid collapses to one column; everything stacks eyebrow → terminal → headline → lead → flagcard | Same token rhythm applies |

### Tokens used
- **Colors:** `--clay` (eyebrow), `--ink`/`--ink-soft`/`--ink-faint` (headline/lead/labels), `--card`+`--card-brd`+`--card-shadow` (flagcard), `--line-soft` (stats rule); flagnum uses the `--ink → --clay-deep` gradient text.
- **Spacing:** `--s1`–`--s6` per the rhythm rule above (no raw pixels except the two-line `min-height`).
- **Typography:** `--disp` headline, `--body` lead, `--mono` for eyebrow / terminal / flagcard figures.

### Accessibility
- **Role:** page `<header>` landmark; headline is the single `<h1>`.
- **Terminal:** decorative readout — the blinking `.cur` collapses to static under `prefers-reduced-motion`; not a live region.
- **Screen reader:** reading order matches the visual left-column stack — eyebrow, terminal, heading, lead — then the flagcard as label/value pairs.

### Do / Don't
| ✅ Do | ❌ Don't |
|------|---------|
| Keep the eyebrow + terminal as the column preamble above the headline | Float the terminal full-width above both columns (breaks the left-column read) |
| Resolve every hero gap to an `--s` token | Reach for a "looks about right" pixel value (36/18/26…) |
| Use tight pairs for label→value, block gaps between stanzas | Space everything evenly — hierarchy disappears |
| Size the terminal `min-height` to its real line count | Leave a fat `min-height` that opens dead space above the headline |

---

## Component inventory

**Carried over from the original report:** topbar, segmented control, status pill, icon button,
hero/terminal, big-number flagcard, delta badge, stat card + sparkline, area chart, radial gauge,
stacked token bar + legend, horizontal bar-list, activity heatmap, data table, roadmap status
cards, footer.

**Added in this pass (★):** pie/donut, multi-column text card, vertical column chart, scatter
plot, calendar heatmap, buttons (primary/secondary/ghost + sizes), chips/badges, tabs, callout/note
(default/info/warn/ok), filterable legend, jump-nav, **section floating sidebar** (collapsed rail +
reorder/hide menu), **metric/ratio card** (eyebrow + trend + meter/sparkline), **grouped stat list**
(mono-header definition columns), **section header** (title + wrapping filter pills + aligned toggle),
**hero** (left-column narrative stack: eyebrow → terminal → headline → lead, with the flagcard alone on the right — token-only spacing rhythm).

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
