---
version: 1
slug: "site-index-html"
primary_target: "site/index.html"
related_targets: []
---

## Scope

The snowglobe demo index (`site/index.html`, served at the site root). Mode: Persuade, for curious
developers arriving from a link; success is opening a demo and typing into it. Runs play inline
("run here") or in their own window; the page also shows how to use the CLI.

## Direction contract

THESIS: Ten sandboxed runs in your browser, presented as a modern Swiss spec sheet where the measured facts are the design; it refuses both the dark dev-tool landing and any retro or nostalgic framing.

OWN-WORLD: White page, near-black ink, one signal orange-red reserved for live state and the run control; Switzer neo-grotesk set large and tight on a strict 12-column grid with generous whitespace; Geist Mono only for commands, data and terminals; terminals as crisp black inset panels; hairline rules, no ornament.

STORY: The visitor learns each run is a whole machine in their tab (no server; a network only when a run opts in), compares runs by their real numbers and recorded transcripts, starts one inline or in a window, watches the ledger track it live, then sees exactly how the CLI produced it.

FIRST VIEWPORT: Left 8 columns: a two-line headline at display size and a short paragraph; right 4 columns: the live "your runs" ledger as a quiet spec block; the first run row (name, run here / new window, terminal panel top) begins above the fold.

FORM: Swiss spec sheet (user-chosen over process monitor and browser-native); signature interaction: run here swaps the recorded transcript for the live machine in the same footprint via a View Transition; user-steered, no concept-seed roll.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
