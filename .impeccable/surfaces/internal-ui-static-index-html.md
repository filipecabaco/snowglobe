---
version: 1
slug: "internal-ui-static-index-html"
primary_target: "internal/ui/static/index.html"
related_targets: ["internal/ui/static/app.js","internal/ui/static/ui.css","internal/ui/static/graph.js","internal/ui/static/fleets.js","internal/ui/static/inspect.js","internal/ui/static/tasks.js"]
---

# snowglobe ui (internal/ui/static)

Mode: Operate. Users: a developer running `snowglobe daemon` on their own machine (or a demo audience
watching one), checking what runs, starting machines, running commands, building images. Constraints:
served by `snowglobe ui` on 127.0.0.1, embedded gzipped (internal/ui/packed, `go generate`), no build
step; Preact + htm vendored by internal/ui/vendor.go (the timeline stays hand-written DOM); live data
from the daemon API (/v1/stats, /v1/metrics every 5 s, /v1/events SSE, /v1/graph, /v1/links,
/v1/fleets, attach WebSocket), the same API the CLI and MCP use; terminal is ghostty-web. Views, one
at a time from the masthead: Overview (the timeline), Network (the graph), Fleets, Machines, Run,
Builds (2026-11-05: the single long page had too much in one place). Inherits DESIGN.md wholesale (paper, ink, one signal for live, Switzer + Fragment Mono,
hairlines, black terminal panels), light and dark.

## Direction contract

THESIS: The daemon's last hour on one time axis: the figures, the events and every machine's life drawn against the same clock. Refuses the admin-template grid of cards and a tab per resource.

OWN-WORLD: White paper, near-black ink, hairline rules; measured figures at figure scale with tabular numerals; charts as 1.5px ink lines on a ruled hour axis; machine lifespans as thin ink bars, the live end of a running one in signal; stopped ones spent grey; the only dark surfaces are terminal and run-output panels.

STORY: The visitor sees at once what runs and what it costs (memory against budget, machines, job latency), sees what happened and when (event ticks, lanes), selects anything to read it and act on it, runs a command on a fresh fork, opens a terminal on a machine, and builds a new image that lands as a new lane.

FIRST VIEWPORT: Masthead (wordmark with live dot, sections: Overview, Fleet, Builds; daemon address and uptime right). Main 8 columns: "The last hour" heading, three ruled metric rows (label and current figure left, line or bar chart across) on one axis with event ticks and hour ticks under them; below, one lane per template with machine bars from up to now and a Graphite caption. Rail 4 columns: the selection (name, its facts as four figures, its actions as pills), then "Run on a fresh fork" with input and black output panel, then Builds with status dots. Primary action: Run (signal pill) in the rail.

FORM: Timeline, position 4 on the ordered list, dealt lead. seed:bd099d60d99dc6ae. Signature interaction: hovering the time axis drives one hairline cursor across every row and lane at once, reading out the figures and machines at that minute; clicking a bar selects that machine in the rail. Motion grammar: new samples slide the series left by one step; a new machine's bar grows from its start; nothing else moves.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Network view (2026-11-05)

What reaches what, read top down: the plan (a strip of templates in columns, the links between them
dotted, labelled with the name they are reached as), then a ruled group per fleet instance (and one
for what no fleet made) with its services and machines in their template's column, solid ink edges
where a machine really reaches another (label chips in mono), and a signal-square tag above each node
for the host port it opens. A fleet's steps still to apply are dashed ghosts with their own Apply.
Selecting fades everything unrelated; a handle on machines and templates drags a link onto a target.
Under 720px it becomes a list per group with the same facts in words.
