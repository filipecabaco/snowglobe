---
name: snowglobe-fleet
description: Use when writing, reading or applying a `snowglobe.toml` fleet file: `snowglobe diff`, `apply`, `down`, `top`, templates, snapshots, services, machines, `[links.*]`, `[network]` modes, instances, and running the same file in a browser at /fleet/. Link and egress semantics are in snowglobe-networking.
---

# Fleet files (`snowglobe.toml`)

One file describes what to run. The daemon applies it natively; the `/fleet/` page runs the same file in a browser tab. Relative paths in it are from the file's directory.

```sh
snowglobe daemon --detach
snowglobe diff  -f snowglobe.toml    # what apply would do
snowglobe apply -f snowglobe.toml
snowglobe top                        # live: memory, templates, services, machines, events
snowglobe down  -f snowglobe.toml    # remove everything of the fleet (or: down --name NAME)
```

Changed entries are replaced along with everything made from them; entries gone from the file are removed. Everything a fleet makes carries labels `snowglobe.fleet` and `snowglobe.spec`. Names something else uses are refused.

## Keys

| Table | Keys |
|---|---|
| (top) | `name` (default: the file's directory) |
| `[templates.N]` | exactly one source: `site` (a site or URL), `build` (a Dockerfile directory, built first), or `snapshot` (a `[snapshots.*]` name); also `network` (`fetch`), `idle`, `max_machines`, `egress` (`none` default, `internet`, `private`), `allow_private` (same as `egress = "private"`; a conflicting `egress` is an error), `expose` (guest ports others reach under mode `all`) |
| `[snapshots.N]` | `template`, `run` (commands that must succeed), `ready` (command retried until it succeeds), `timeout` (default 2m). Saved once ready. |
| `[services.N]` | `template`, `ports` (`"HOST:GUEST"`), `min`, `max`, `idle`, `concurrency`, `state` (`discard` or `keep`), `labels` |
| `[machines.N]` | `template`, `count`, `ports`, `ttl`, `labels` (named N, or N-1 to N-count) |
| `[links.N]` | `from`, `to` (a template, service or machine of the file), `port`, `as`, `as_port` |
| `[network]` | `mode` = `exclusive` (default), `inclusive`, `all` |

Network modes: `exclusive` keeps each instance to itself (app#2 reaches db#2); `inclusive` lets every machine of a template reach any machine of the target's template across instances; `all` is inclusive plus every template reaching every other's `expose`d ports by its name.

## A small fleet

```toml
name = "live-data"
[templates.py]
build = "../python"
network = "fetch"
[snapshots.feed]
template = "py"
run = ["cd /srv && python3 feed.py >/dev/null 2>&1 &"]
ready = "python3 -c \"import socket; socket.create_connection(('127.0.0.1', 9100), 2).close()\""
[templates.feed]
snapshot = "feed"
[machines.feed]
template = "feed"
[templates.viewer]
site = "../dist/viewer"     # a site built earlier
network = "fetch"
[services.viewer]
template = "viewer"
ports = ["8080:8080"]
min = 0               # scale to zero; the first request wakes it
idle = "5m"
[links.viewer-feed]
from = "viewer"
to = "feed"
port = 9100
as = "feed.internal"
```

Full examples: `examples/fleet/snowglobe.toml` (a Supabase database that inserts a row a second, and a node viewer that subscribes to it with Supabase Realtime over a link; also runs at /fleet/) and `examples/todo-fleet/snowglobe.toml` (Elixir app and Postgres as `db.internal:5432`, egress none).

## Instances

A fleet runs as instances, like `docker compose -p`: templates and snapshots are shared; services, machines and links are made per instance (label `snowglobe.instance`). `main` keeps the file's names; another gets `-ID` names and host ports the system picks. Start and stop them in `snowglobe ui` (Fleets), the MCP tools `start_instance` and `stop_instance`, or the API (`POST /v1/fleets/{name}/instances`). `snowglobe ui` and the MCP tools `fleet_plan` and `fleet_apply` (with one `step`) apply one step at a time.

## The same file at /fleet/ (a browser tab)

https://filipecabaco.github.io/snowglobe/fleet/ reads the file in the page and turns it into steps, each with its own Run, or Run all: a snapshot's `run` and `ready`, a link, a machine wake, a service opened in a frame. Stop ends the run and sends the machines back to their image; a graph shows the machines and links. A `run` command can be a multi-line string (three single quotes; heredoc terminators at column 0). Small fleets to try: `examples/fleet/templates/`.

| File | In the tab |
|---|---|
| `build = "../python"` | the page's `python` machine: a template must name a site the page has |
| one site | ONE machine: every entry on that site shares its files and processes |
| `[links.*]` | real; both ends need a network; a machine reads its links when it wakes |
| `[services.*]` ports | first guest port only, shown in a frame; the host port is not opened |
| `min`, `max`, `idle`, `concurrency`; `ttl`; `egress`; `network.mode` | read, not applied (one instance; a machine's network is what its site was built with) |

- A link from a machine to itself, or between two entries on the same site, is refused.
- The page prints a note for each key it reads but does not apply; read them before trusting a result.
- Link transport in the tab (HTTP on 80/443, raw TCP and WebSockets elsewhere): snowglobe-networking.
- Natively, none of those limits apply: scale, ttl, egress and modes are enforced by the daemon.

More: https://filipecabaco.github.io/snowglobe/docs/orchestration/ and the "Fleets" and "The fleet page" sections of https://filipecabaco.github.io/snowglobe/llms.txt
