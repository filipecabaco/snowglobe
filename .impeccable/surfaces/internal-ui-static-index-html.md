---
version: 1
slug: "internal-ui-static-index-html"
primary_target: "internal/ui/static/index.html"
related_targets: ["internal/ui/static/app.js","internal/ui/static/ui.css"]
---

# snowglobe ui (internal/ui/static)

Mode: Operate. Users: a developer running `snowglobe daemon` on their own machine (or a demo audience
watching one), checking what runs, starting machines, running commands, building images. Constraints:
served by `snowglobe ui` on 127.0.0.1, embedded, no build step, no framework; live data from the daemon
API (/v1/stats, /v1/metrics every 5 s, /v1/events SSE, /v1/builds, attach WebSocket); terminal is
ghostty-web. Inherits DESIGN.md wholesale (paper, ink, one signal for live, Switzer + Fragment Mono,
hairlines, black terminal panels), light and dark.

## Direction contract

THESIS: The daemon's last hour on one time axis: the figures, the events and every machine's life drawn against the same clock. Refuses the admin-template grid of cards and a tab per resource.

OWN-WORLD: White paper, near-black ink, hairline rules; measured figures at figure scale with tabular numerals; charts as 1.5px ink lines on a ruled hour axis; machine lifespans as thin ink bars, the live end of a running one in signal; stopped ones spent grey; the only dark surfaces are terminal and run-output panels.

STORY: The visitor sees at once what runs and what it costs (memory against budget, machines, job latency), sees what happened and when (event ticks, lanes), selects anything to read it and act on it, runs a command on a fresh fork, opens a terminal on a machine, and builds a new image that lands as a new lane.

FIRST VIEWPORT: Masthead (wordmark with live dot, sections: Overview, Fleet, Builds; daemon address and uptime right). Main 8 columns: "The last hour" heading, three ruled metric rows (label and current figure left, line or bar chart across) on one axis with event ticks and hour ticks under them; below, one lane per template with machine bars from up to now and a Graphite caption. Rail 4 columns: the selection (name, its facts as four figures, its actions as pills), then "Run on a fresh fork" with input and black output panel, then Builds with status dots. Primary action: Run (signal pill) in the rail.

FORM: Timeline, position 4 on the ordered list, dealt lead. seed:bd099d60d99dc6ae. Signature interaction: hovering the time axis drives one hairline cursor across every row and lane at once, reading out the figures and machines at that minute; clicking a bar selects that machine in the rail. Motion grammar: new samples slide the series left by one step; a new machine's bar grows from its start; nothing else moves.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
