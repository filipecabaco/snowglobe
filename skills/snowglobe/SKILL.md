---
name: snowglobe
description: Use when a task mentions snowglobe, snowglobe.toml, or packaging a Docker image into a machine that runs in a browser, natively or hosted. Start here to learn what it is and which snowglobe-* skill to load next.
---

# snowglobe

snowglobe packages a Docker image (64-bit ARM Alpine) into a **site**: a folder holding a snapshot of the machine once its app was ready. One site, one fleet file (`snowglobe.toml`), three places to run them:

| Place | How | Notes |
|---|---|---|
| Native, from the CLI and daemon | `snowglobe run`, `snowglobe daemon`, `snowglobe apply` | No Docker, no KVM needed; the emulator sandboxes itself. Primary interface. |
| Hosted | a server you deploy (snowglobe-hosted) | Accounts, saves, team images. Partly built. |
| A browser tab | the static site, `/agent/`, `/fleet/` | Arm64 emulated in WebAssembly (armless). Same files, same snapshot. |

The CLI and daemon are the main way to work. The browser pages are one more place the same site and fleet files run.

## Which skill

| Task | Load |
|---|---|
| Turn an image, Dockerfile or directory into a site; flags and `LABEL snowglobe.*` | snowglobe-build |
| Run a site: `serve`, `run`, `sh`, `cp`, daemon, `up`, `snowglobe ui`, saving | snowglobe-run |
| Write or operate `snowglobe.toml`: `diff`, `apply`, `down`, `top`, templates, services, links | snowglobe-fleet |
| `--network fetch`, egress, `--tunnel`, links between machines, WebSockets | snowglobe-networking |
| Let an agent drive it: `snowglobe mcp`, the `/agent/` page, WebMCP tools | snowglobe-agents |
| Accounts, saves, team images, `/run/<token>/` | snowglobe-hosted |

## Happy path

```sh
curl -fsSL https://filipecabaco.github.io/snowglobe/install.sh | sh   # or a release binary
snowglobe build ./my-app --out dist/my-app        # Dockerfile directory, or an image reference
snowglobe serve dist/my-app                       # preview in a browser
snowglobe run dist/my-app --runtime native        # a session; ctrl-] quits
snowglobe daemon --detach                         # the orchestrator
snowglobe template add dist/my-app --name app     # restore once
snowglobe up app --name box                       # a machine, forked in tens of milliseconds
snowglobe sh box 'uname -m'                       # run a command on it
snowglobe apply -f snowglobe.toml                 # or: get the daemon to what a fleet file says
snowglobe daemon stop
```

## Rules that always apply

- The guest must be arm64 Alpine (`FROM alpine`, or `arm64v8/alpine`).
- A guest has no network unless built with `--network fetch`.
- Pass `snowglobe sh` its command as one quoted argument.
- Check any flag with `snowglobe --help` before relying on it.

More: https://filipecabaco.github.io/snowglobe/docs/ and https://filipecabaco.github.io/snowglobe/llms.txt
