---
name: snowglobe
description: Real programs, sandboxed in your browser; a Swiss spec sheet where the measured facts are the design.
colors:
  signal: "#d6300c"
  signal-tint: "#ffd9cd"
  ink: "#0d0d0d"
  ink-2: "#5a5a57"
  rule: "#dedede"
  spent: "#c9c9c5"
  soft: "#f3f3f0"
  paper: "#ffffff"
  panel: "#0b0b0c"
  panel-ink: "#e9e9e4"
  panel-dim: "#8d8d88"
  pending: "#c48a1e"
typography:
  display:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(2.75rem, 4.3vw, 4rem)"
    fontWeight: 620
    lineHeight: 0.95
    letterSpacing: "-0.035em"
  headline:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(2.4rem, 4.6vw, 4.25rem)"
    fontWeight: 620
    lineHeight: 0.98
    letterSpacing: "-0.035em"
  run-title:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(2rem, 3.4vw, 3rem)"
    fontWeight: 600
    lineHeight: 1
    letterSpacing: "-0.03em"
  figure:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(32px, 3.4vw, 48px)"
    fontWeight: 560
    lineHeight: 1
    letterSpacing: "-0.035em"
    fontFeature: "tnum"
  title:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "24px"
    fontWeight: 600
    letterSpacing: "-0.02em"
  lede:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "clamp(19px, 1.7vw, 22px)"
    fontWeight: 400
    lineHeight: 1.45
  body:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "17px"
    fontWeight: 400
    lineHeight: 1.55
    fontFeature: "tnum"
  label:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "13px"
    fontWeight: 400
  button:
    fontFamily: "Switzer, ui-sans-serif, system-ui, -apple-system, Segoe UI, sans-serif"
    fontSize: "15px"
    fontWeight: 550
    lineHeight: 1
  mono:
    fontFamily: "Fragment Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.6
  terminal:
    fontFamily: "Fragment Mono, ui-monospace, Menlo, Consolas, monospace"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1
rounded:
  hairline: "2px"
  panel: "6px"
  pill: "999px"
spacing:
  gap: "24px"
  rail-gap: "48px"
  page-pad: "clamp(20px, 4vw, 64px)"
  run-top: "40px"
  run-bottom: "72px"
  section-top: "clamp(72px, 9vw, 120px)"
components:
  button-run:
    backgroundColor: "{colors.signal}"
    textColor: "{colors.paper}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    height: "44px"
  button-run-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-run-pressed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  button-outline:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.pill}"
    padding: "0 18px"
    height: "44px"
  button-outline-hover:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
  terminal-panel:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.panel-ink}"
    typography: "{typography.terminal}"
    rounded: "{rounded.panel}"
    padding: "40px 20px 18px"
    height: "460px"
  code-block:
    backgroundColor: "{colors.soft}"
    textColor: "{colors.ink}"
    typography: "{typography.mono}"
    rounded: "{rounded.panel}"
    padding: "18px 20px"
  spec-figure:
    textColor: "{colors.ink}"
    typography: "{typography.figure}"
  ledger-action:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    padding: "4px 0"
  ledger-action-hover:
    textColor: "{colors.signal}"
---

# Design System: snowglobe

## Overview

**Creative North Star: "The Measured Spec Sheet"**

snowglobe's demo page is a modern Swiss spec sheet for ten sandboxed machines. White paper, near-black ink, one signal orange-red. Switzer sits large and tight on a strict two-zone grid (an 8-column main column of runs, a 4-column rail holding the live "Your runs" ledger). The numbers the build measured, like snapshot size, ready time, preloaded and on-demand bytes, are set at headline scale. They are the decoration. Nothing else is.

The page is quiet until something runs. Each run's terminal is a crisp black inset panel. At rest it shows the transcript recorded at build time, and "Run here" swaps in the live machine in the same footprint. Signal colour appears only on the run control and on live state: the pulsing ledger dot, the restore progress bar, and the masthead dot, which lights up only while a run is live. Structure comes from hairlines. Full-ink 1px rules open each major block, and pale 1px rules divide rows.

The world rejects both the dark dev-tool landing page and any retro or nostalgic framing. There are no CRT effects, no ornament, no gradients beyond the transcript's bottom fade into the panel.

**Key Characteristics:**
- White page, near-black ink, one reserved signal colour
- Neo-grotesk display set tight (negative tracking, sub-1 line-height), tabular numerals everywhere
- Measured figures at headline scale in spec rows ruled from above
- Black terminal panels as the only dark surfaces
- Hairline rules instead of cards, boxes or shadows
- Pill-shaped controls: one filled signal pill per run, all others outlined in ink

## Colors

A near-monochrome paper-and-ink palette with a single hot signal reserved for live state.

### Primary
- **Signal Vermilion** (`signal`): the "Run here" control, the restore progress bar, the live ledger dot and its pulse ring, the masthead dot while any run is live, the focus outline, the text caret, and ledger-action hover. Its pale companion **Signal Blush** (`signal-tint`) is used only for text selection.

### Neutral
- **Press Black** (`ink`): all body and display text, the 1px rules that open each block (masthead, run, ledger, spec cells, steps, table head, footer), outline-button borders, and the hover fill for every button.
- **Graphite** (`ink-2`): secondary text such as stack lines, spec labels, ledger states, section intros, table headers, and the dimmed comments in code.
- **Hairline Grey** (`rule`): pale row dividers in tables, steps and ledger rows.
- **Spent Grey** (`spent`): the dot for closed or lost runs, and the page scrollbar thumb.
- **Bone** (`soft`): the background of static code blocks (CLI steps). It is the only tinted light surface.
- **Paper** (`paper`): the page, plus the mobile ledger sheet.
- **Panel Black** (`panel`) with **Panel Ink** (`panel-ink`) and **Panel Dim** (`panel-dim`): the terminal panel, its text, and its small "recorded at build" or "live in this tab" label.
- **Restoring Amber** (`pending`): the ledger dot while a run is loading its snapshot. It is the only state colour besides signal.

The xterm transcript theme carries its own ANSI palette (for example red `#ff6b4a`, green `#7fd18b`). That palette lives inside the panel only and is not part of the page palette.

### Named Rules
**The Live Signal Rule.** Signal Vermilion means "this runs" or "this is running". It goes on the run control, live state and focus, and nowhere else. It is never used for headings, links or decoration. At rest, the masthead dot stays ink.

**The One Dark Surface Rule.** The terminal panel is the page's only dark surface. Static code is set on Bone, never on black, so dark always means a machine.

## Typography

**Display Font:** Switzer variable (100–900), self-hosted, falls back to `ui-sans-serif, system-ui`
**Body Font:** Switzer
**Label/Mono Font:** Fragment Mono (400), self-hosted, falls back to `ui-monospace, SFMono-Regular, Menlo, Consolas`

**Character:** A neutral neo-grotesk used at odd, precise weights (550, 560, 600, 620) and pulled tight at large sizes, paired with a narrow, clean mono for anything a machine says. The surface brief named Geist Mono. The build swapped it for Fragment Mono after the design detector flagged Geist Mono as an overused face. Fragment Mono is the system's mono.

### Hierarchy
- **Display** (620, clamp 2.75–4rem, 0.95, −0.035em): the hero headline only. Balanced wrap, max 26ch.
- **Headline** (620, clamp 2.4–4.25rem, 0.98, −0.035em): section heads ("Compare the runs", "Make your own"). Max 14ch.
- **Run title** (600, clamp 2–3rem, 1, −0.03em): each run's name.
- **Figure** (560, clamp 32–48px, 1, −0.035em, tabular): measured values in spec rows. The unit sits beside it at 15px/400 in Graphite.
- **Title** (600, 24px, −0.02em): CLI step names. The ledger heading is a smaller sibling (600, 20px).
- **Lede** (400, clamp 19–22px, 1.45): the hero paragraph, max 36em.
- **Body** (400, 17px / 16px under 720px, 1.55): running text, max 38–40em. Section intros use 18px in Graphite.
- **Label** (400, 13px, Graphite): spec labels and table column heads. These are sentence case, never uppercase or tracked.
- **Mono** (Fragment Mono 400, 13.5px, 1.6): code blocks and option-table flags. Inline code sits at 0.86em. Terminals use 12.5px with line-height 1 so box-drawing characters join.

### Named Rules
**The Tabular Rule.** `font-variant-numeric: tabular-nums` is set on the body. Every figure on the page lines up.

**The Machine Voice Rule.** Mono appears only where a machine speaks: commands, flags, labels and paths, transcripts and terminals. Prose and headings are always Switzer.

## Layout

The page is centred to 1440px with fluid side padding (`page-pad`, 20–64px). The hero runs the full width (headline, lede, the install line). The runs follow as one block opened by a full-ink rule. On the left (3fr) is the list of runs, a vertical tablist of ruled rows: the name, its snapshot size and a one-line description, with a 2px ink bar marking the selected one and a status dot when it is live. Under the list sits the "Your runs" ledger. On the right (9fr) is one panel, the selected run: its head (title and stack line on the left, the controls on the right), the 460px terminal, the four-up spec row and the command strip. The address keeps which run is open (`#python`). "Compare the runs" stays a single table. "Make your own" is a strip of underlined tabs (Install … Orchestrate) showing one step at a time; without the script every step shows in turn. Vertical rhythm: 72–120px above each section.

Responsive behaviour:
- **≤1080px:** one column. The ledger moves above the runs and stops being sticky.
- **≤720px:** the run head stacks and the controls wrap. The panel drops to 380px. Spec rows become 2-up. CLI steps stack. The options table and the comparison table reflow into labelled blocks so nothing clips at rest. The ledger becomes a fixed bottom sheet with a 56px toggle row (count on the right) that opens to at most 62vh. The body reserves bottom padding for it. Only the last nav link (GitHub) stays in the masthead.
- Code keeps its columns. Code blocks scroll sideways and never re-wrap. Terminals never render narrower than 90 columns and scroll sideways on phones.

## Elevation & Depth

The system is flat. Depth comes from contrast and hairlines: the black panel inset into white paper, and 1px ink rules that open each block. There are no card shadows.

### Shadow Vocabulary
- **Sheet lift** (`box-shadow: 0 -12px 32px -18px rgb(0 0 0 / .25)`): only on the mobile ledger sheet, to separate it from content scrolling underneath.
- **Live pulse** (`box-shadow` ring from 0 to 7px of signal at 50% → 0): the animated halo on a running ledger dot. This is state, not elevation.

### Named Rules
**The Hairline Rule.** Blocks open with a full-ink 1px top rule, and rows divide with 1px Hairline Grey. Use a rule wherever another system would reach for a card or a shadow.

## Shapes

Corners are nearly square. Panels and code blocks use a 6px radius. Every button is a full pill (999px), which is the only round form besides the 8px status dots and the masthead dot. The focus outline is 2px signal at a 3px offset with a 2px radius. Borders are always 1px. Icons are drawn inline as 1.5px-stroke SVG at 14px (the "new window" arrow).

## Components

### Buttons
Pill controls with confident fills and a single colour change on hover.
- **Shape:** full pill (999px), 44px tall, 0 18px padding, Switzer 550 at 15px.
- **Run (primary):** Signal Vermilion fill and border with white text: "Run here", one per run. A run on
  several CPUs can't play inline (it needs a cross-origin isolated page of its own), so it has no
  "Run here": its "New window" takes the signal fill instead, keeping one filled pill per run.
- **Outline (secondary):** transparent with a 1px ink border and ink text. Used for "New window" (with a trailing 14px arrow icon) and the live bar's "Stop".
- **Hover:** both variants fill with ink and switch to white text, with a 0.2s `cubic-bezier(.2,.8,.2,1)` colour transition.
- **Pressed:** a running "Run here" becomes "Stop" with `aria-pressed="true"` and an ink fill.

### Terminal Panel (signature)
A black 460px panel (6px radius) that holds a recorded xterm transcript rendered at 12.5px Fragment Mono. The transcript fades out over its bottom 72px into Panel Black. A small mono label (12px, Panel Dim) sits top-right with "recorded at build" or "screen at snapshot". Pressing "Run here" swaps the transcript for a live iframe in the same footprint. The swap is a 0.5s View Transition named `live-panel` that powers on from 10px blur and opacity 0. While it restores, a mono status line ("Restoring snapshot… n%") and a 180×2px progress bar filled with signal sit bottom-left. Once the run is live, the label hides so the terminal is unobstructed.

### Spec Row
Four measured figures (Snapshot to restore, Ready at build, Preloaded, On demand). Each cell opens with a 1px ink rule, then a 13px Graphite label and a Figure-scale value with a small Graphite unit. A Graphite line follows with the command in ink mono, plus "· N MB RAM · no network · no server".

### Ledger ("Your runs")
A ruled list under the runs list. Each row is a grid: an 8px status dot, the name (550) with a Graphite "· here" or "· window", a state line in 14px Graphite ("Restoring n%", "Running · mm:ss", "Stopped · ran for …"), and text-button actions on the right. Dots are Amber while restoring, a pulsing Signal while running, and Spent Grey (with the row text dimmed) once closed or lost. Actions ("Show", "Stop") are underlined text buttons that turn signal on hover. New rows enter with a 0.5s fade and a 6px drop.

### Code Blocks
Bone background, 6px radius, 18px 20px padding, ink Fragment Mono at 13.5px/1.6. Comments are dimmed to Graphite. Blocks never wrap.

### Tables
Full width, 15px, right-aligned numerals with a left-aligned first column. The header row is 13px/500 in Graphite over an ink rule. Body rows divide with Hairline Grey. There are no fills and no zebra striping.

### Navigation
The masthead has the lowercase "snowglobe" wordmark (650, 20px, −0.02em) followed by a small round dot, and 15px text links on the right. A 1px ink rule runs underneath. Links are underlined with 1px thickness at a 4px offset, thickening to 2px on hover.

### Docs Pages (Read surface)
The docs are one page per area: Getting started at `/docs/`, then building, networking, running,
agents, orchestration, isolation, saving, how it works and the CLI reference, each under
`/docs/<area>/`. They share `docs.css` and `docs.js` with `base.css` and `theme.js`. Prose sits in
the 8-column main column at a 40em measure. A page's heading (its one `h1`) is set a step below
the index's display size, opened by the full-ink rule; its sections are `h2`, set like the old
subsections. Previous and next links close the page.

The 4-column rail is sticky and holds two things. First, a search field that searches every
page's headings and the first column of its tables (commands, flags, settings, labels); "/" or
⌘K opens it, and results list in a ruled box. Second, the contents: every page, the current one in
650 weight and opened to its sections, the section in view in 600 (never signal: signal means
live). Every code block carries a small outlined "Copy" pill.

Under 1080px the rail moves above the text, and the contents become a "Pages" menu that opens in
place. Under 720px, option tables reflow into one block per row and the isolation comparison into
labelled rows, so no table scrolls sideways. A link to the old single page (`docs/#section`) is
sent to its section's page.

### Orchestration UI (Operate surface)
`snowglobe ui` (`internal/ui/static/`) shows a running daemon in a browser, in the same world. It
embeds copies of `base.css`, `theme.js` and the fonts (a test keeps them identical to `site/`). Its
layout is a timeline: the main column opens on one time axis spanning what the daemon has lived (10
minutes to an hour). Ruled series rows hold memory against the budget (dashed), machines and jobs:
a label, a figure-scale value, and a 1.5px ink line or ink bars. Under them come event ticks,
round-minute labels, and the daemon's start marked in ink. A lane per template follows, with each
machine's life as a 6px ink bar whose live end is signal and whose stopped bars are spent grey.
A hairline cursor crosses every row and lane, and its readout leads with the minute at figure
scale. The rail holds the selection (four figures, outlined pill actions), "Run on a fresh fork"
(the one signal pill "Run", an outlined "Run in background", the output on a black panel, and
submitted runs below), then events.

Dots carry state: signal for live, amber for building or running, grey for idle or at zero, a
solid ink dot for a run that succeeded, and a hollow ink ring for one that failed. The machine
terminal is ghostty-web on the black panel (460px). Tables are the system's ruled tables, and on
phones each row becomes a block. Under 1080px the page is one column: the timeline, then the rail,
then Ports, Fleet and Builds. Every position is set through the CSSOM, because the page's CSP
refuses style attributes.

### Run Window Strip (minor surface)
A run opened in its own window (`internal/site/index.html.tmpl`) shows a one-line strip above a full-bleed black terminal: the title, "sandboxed in this tab · no server · no network", and a status with a dot. The strip is hidden when the run is embedded (`?embed`). It uses the system's tokens: white ground, ink text and rule, graphite secondary text, the amber restoring dot and the signal live dot; its type is the platform mono, since the template ships with every snowglobe site and carries no web fonts.

## Do's and Don'ts

### Do:
- **Do** reserve Signal Vermilion (#d6300c) for the run control, live state, progress and focus.
- **Do** set every measured number in Switzer with tabular numerals, at Figure scale when it is the point of the block.
- **Do** open blocks with a 1px ink rule and divide rows with 1px Hairline Grey (#dedede).
- **Do** keep terminals as black 6px-radius panels and put recorded and live output in the same footprint.
- **Do** use Fragment Mono only for commands, flags, paths, labels and terminals.
- **Do** keep code and terminals at their recorded column width and let them scroll sideways on narrow screens.
- **Do** honour `prefers-reduced-motion`. The ledger entry animation, live pulse and View Transitions all switch off.

### Don't:
- **Don't** use signal for headings, links, decoration or emphasis in prose.
- **Don't** put static code on a dark surface. Dark means a running machine.
- **Don't** add card shadows, boxed cards, gradients or ornament. Depth is hairlines and the panel.
- **Don't** introduce retro, CRT or nostalgic terminal styling, or a dark dev-tool page theme.
- **Don't** use uppercase tracked labels. Labels are sentence-case 13px Graphite.
- **Don't** swap Fragment Mono back to Geist Mono, which was replaced as an overused face.

## Dark Mode

The page follows the visitor's system theme by default, and a text toggle in the masthead
("Dark" / "Light") pins the other one, remembered in `localStorage` and applied before first paint.
Dark is the same system inverted, not a separate world: every colour is a token on `:root`, and
dark overrides only the tokens.

| Token | Light | Dark |
|-------|-------|------|
| `--bg` (page ground) | #ffffff | #0d0d0c |
| `--ink` | #0d0d0d | #ecece8 |
| `--ink-2` (secondary text) | #5a5a57 | #a2a29c |
| `--rule` | #dedede | #2b2b29 |
| `--soft` (code blocks) | #f3f3f0 | #171716 |
| `--panel` (terminals) | #0b0b0c | #050505, edged by a 1px `--panel-edge` (#2b2b29) |
| `--signal` | #d6300c | #ff5a2e |
| `--on-signal` (run button text) | #ffffff | #0b0b0c |
| `--restoring` dot | #c48a1e | #e0a640 |
| `--select` (text selection) | #ffd9cd | #5a2a1e |

The restore progress bar's track is a fixed `#2a2a2a` in both themes: it sits on the panel, which is
black in both.

- The terminals stay the darkest surface in both themes; in dark they gain a hairline edge so
  they still read as panels against the near-black ground.
- The signal brightens in dark to keep its contrast against the ground, and the run button flips
  to dark text on it.
- The run window's strip follows the system theme through `prefers-color-scheme`.

## Mobile

- **A live run takes the screen.** On phones (≤720px) "Run here" lifts the panel into a full-screen
  machine under a 56px bar (run name with the live dot, Stop). The page behind it stops scrolling.
- **Follow the visual viewport.** The full-screen panel and the run page size themselves to
  `visualViewport` (`--vvh`, `--vvt`), so the on-screen keyboard shrinks the terminal instead of
  covering the prompt.
- **The terminal fits the screen.** It is sized to the screen before the restored output is
  written, so that output wraps at the visitor's width, and the guest is told the size, so what
  the app prints next wraps too and full-screen apps redraw. Startup banners stay unboxed with
  short lines for the same reason. Terminal type drops to 13px under 640px.
- **The key bar.** On coarse pointers, a dark bar under the terminal carries the keys phone
  keyboards lack: esc, tab, a sticky ctrl (signal colour while armed), ^C, and arrows (drawn SVG
  chevrons, sent in the cursor mode the app asked for). Keys act on pointerdown and never take focus.
- **Touch targets.** Text links keep their look but get a 44px-tall hit area under `pointer: coarse`.
