---
name: snowglobe-networking
description: Use when a snowglobe guest needs the network: `--network fetch`, `--tunnel`, `--tunnel-token`, `--allow-private`, egress, `[links.*]` and `as`/`as_port`, ports 80 and 443 on a link, WebSockets, CORS 502s. Covers what leaves a machine and what is refused; fleet syntax is snowglobe-fleet.
---

# Networking

A guest has no network by default (`--network none`). The same rules hold in a browser tab, natively and in a container, except where noted.

## Out to the internet

```sh
snowglobe build ./app --network fetch                      # or LABEL snowglobe.network="fetch"
snowglobe build ./app --network fetch --tunnel db.internal:5432=wss://db-proxy.example.com/
```

| Traffic | Browser | `snowglobe run` / daemon |
|---|---|---|
| HTTP (port 80) | page's `fetch()`; CORS applies, servers without it answer 502 | leaves from the host or container (honours `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`) |
| HTTPS (443) | TLS ends in the machine with a per-build CA only the guest trusts, replayed with `fetch("https://...")` | same as above |
| WebSocket `ws://`, `wss://` | a browser WebSocket to the same URL | direct |
| Other TCP | only to a tunnel's name, over a WebSocket | made directly; private addresses refused unless `--allow-private` |
| UDP | goes nowhere | |

## Tunnels (raw TCP in a browser)

- `--tunnel [HOST:]PORT=URL` (repeatable; needs `--network fetch`) carries TCP to HOST:PORT over a WebSocket as binary messages (websockify, websocat, Neon's wsproxy in front of the service).
- Natively a tunnel URL may be `tcp://HOST:PORT`, with no proxy: `snowglobe run dist/app --tunnel db.internal:5432=tcp://127.0.0.1:5432 --allow-private`. `--tunnel` on `run` replaces the site's tunnels.
- Never bake a credential into the guest: it ships in the snapshot to every visitor. Put `{token}` in the URL and give `--tunnel-token URL` (a GET answering with a token, asked per connection in a browser, once per boot natively); a gateway behind the tunnel holds the real credentials.
- Builds and `run` refuse loopback and private addresses. `--allow-private` lifts that for your own machine in development.

## Egress (native, daemon, fleets)

Egress says where a machine's own connections may go: `none` (default in fleets: only links and forwarded ports), `internet`, `private` (also loopback and private). In a fleet: `egress = "none"` on a template (snowglobe-fleet). snowglobe-vm and bundles take `--egress`.

## Links between machines

Machines in the daemon reach each other only through links. A guest connects to `as:as_port` and gets the target's `port`.

```toml
[links.app-db]
from = "app"          # a template, service or machine of the file
to = "db"
port = 5432           # the target's guest port
as = "db.internal"    # name the source uses
# as_port = 15432     # port the source connects to (default: port)
```

- Each source machine gets its own Unix socket per link: no host TCP port opens, and links work under egress `none`.
- The guest's ports 80 and 443 are HTTP and HTTPS (the machine ends them itself), not raw TCP: a link whose `as_port` (default `port`) is 80 or 443 carries HTTP requests. For raw TCP to the target's port 80, set `as_port` to another number. The fleet page prints this as a note.
- Other ports are raw TCP bytes both ways.
- Outside a file, links exist only through the daemon API, `snowglobe ui` (drag one node onto another) and the MCP tools `link`, `unlink`, `list_links`, `graph`.

## WebSockets

- Native and daemon: ordinary; a guest speaks them over TCP.
- Browser tab with `--network fetch`: the guest's `ws://` and `wss://` open browser WebSockets.
- Browser fleet page: on any port except 80 and 443 the guest speaks WebSocket over the raw TCP link; `ws://<link name>/` on 80 or 443 works too (no permessage-deflate); a page in the preview can open `new WebSocket("<page>/preview/<machine>/<port>/...")` (up to 32 at once, while the preview is open).
- Browser agent page preview: HTTP/1.1 for the app's requests, plus WebSockets (up to 32); Vite's dev server and hot reload are untested there, so use a build in watch mode (snowglobe-agents).

## Refused or not carried

UDP; raw TCP in a browser except through a tunnel or link; loopback and private addresses without `--allow-private`; CORS-less servers from a browser.

More: https://filipecabaco.github.io/snowglobe/docs/networking/ and the "Networking" and "The fleet page" sections of https://filipecabaco.github.io/snowglobe/llms.txt
