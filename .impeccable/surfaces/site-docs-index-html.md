---
version: 1
slug: "site-docs-index-html"
primary_target: "site/docs/index.html"
related_targets: ["site/base.css", "site/theme.js"]
---

## Scope

The snowglobe docs (`site/docs/index.html`, served at `/docs/`). Mode: Read, for developers who
decided to try snowglobe and need to build, run or drive a site; success is finding the command or
flag they need and using it. It is the source of truth for usage: the README links into it.

## Direction contract

THESIS: The same Swiss spec sheet as the index, read rather than browsed: one column of prose at a
reading measure, every command copyable, every flag in a table.

OWN-WORLD: The index's world unchanged (see DESIGN.md): white paper, near-black ink, Switzer for
prose, Fragment Mono only where a machine speaks, hairline rules, code on Bone. Signal stays
reserved for live state; the docs have none, so they carry no signal colour.

STRUCTURE: Getting started, building, networking, running outside a browser, agents and programs,
isolation, saving work, how it works (with troubleshooting), CLI reference. One page, anchors per
section, a sticky contents rail.
