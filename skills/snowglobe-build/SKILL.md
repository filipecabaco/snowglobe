---
name: snowglobe-build
description: Use when running `snowglobe build`, writing a Dockerfile for snowglobe, or setting `LABEL snowglobe.*` (ready, exercise, memory, cpus, network, tunnels, agent). Covers producing a site and what is in it; running it is snowglobe-run, networking is snowglobe-networking.
---

# Building a site

```sh
snowglobe build <dir with a Dockerfile | image ref | image archive> [flags]   # output: dist/ by default
snowglobe build ./my-app --out dist/my-app --ready '>>> '
snowglobe build python:3.13-alpine --builder native --ready '>>> '            # no Docker
docker save my-app:latest -o my-app.tar && snowglobe build my-app.tar --builder native
```

The image must be 64-bit ARM Alpine. Docker is the default builder; `--builder native` (or `SNOWGLOBE_BUILDER=native`) pulls from a registry or reads a `docker save` / OCI archive. On an x86 host, Docker builds need QEMU binfmt handlers for arm64 (Docker Desktop has them).

## Flags and the labels that set them (flags win)

| Flag | Label | Meaning |
|---|---|---|
| `--cmd CMD` | | Program to run (default: image ENTRYPOINT + CMD). Drops the image's ready and exercise labels. |
| `--ready TEXT` | `snowglobe.ready` | Console text that means "snapshot now". Default: 5 s of quiet. |
| `--exercise CMD` (repeat) | `snowglobe.exercise` (JSON array) | Commands typed after the snapshot; files they read are preloaded. |
| `--warm REGEX` | `snowglobe.warm` | Extra guest paths to preload. |
| `--title TEXT` | `snowglobe.title` | Page title. |
| `--memory MB` | `snowglobe.memory` | Guest RAM, default 512. |
| `--cpus N` | `snowglobe.cpus` | 1 to 8, default 1. |
| `--build-cpus N` | `snowglobe.build-cpus` | CPUs for boot and warm-up, default max(`--cpus`, 4). |
| `--network fetch` | `snowglobe.network` | Give the guest a network (default `none`). See snowglobe-networking. |
| `--tunnel [HOST:]PORT=URL` | `snowglobe.tunnels` (JSON array) | Raw TCP over a WebSocket. |
| `--tunnel-token URL` | `snowglobe.tunnel-token` | Token endpoint for `{token}` in tunnel URLs. |
| `--allow-private` | | Build snapshot may reach loopback and private addresses. |
| `--agent` | `snowglobe.agent="true"` | Make it a machine on the agent page. See snowglobe-agents. |
| `--sandbox` | | Snapshot for native runs and `bundle` (keeps the guest's file cache). |
| `--no-chunks` | | Do not split files of 2 MiB and more into content-defined chunks. |
| `--builder docker\|native` | | Builder. |

```dockerfile
FROM alpine:3.24.2
RUN apk add --no-cache python3
CMD ["python3"]
LABEL snowglobe.title="Python" snowglobe.ready=">>> " \
      snowglobe.exercise='["import json, re"]'
```

## Gotchas

- The guest boots with BusyBox init and no service manager: OpenRC services do not start. Start servers from the command.
- Do slow one-time setup (`initdb`, migrations) in a Dockerfile `RUN`, where it runs at native speed, not in emulation.
- More than one CPU needs `--cpus`; in a browser the page then makes itself cross-origin isolated with a service worker.
- Everything the guest knows ships in the snapshot, including passwords in its environment.
- Each build writes `warm-report.json`; read it to see what was preloaded.

## What a built site contains

`index.html`, `system/state.bin.zst` (the snapshot), `system/filesystem.json` plus blobs (root filesystem), `system/warm.pack`, `warm-report.json`, `run.json`, `transcript.json`.

## After the build

| Command | Does |
|---|---|
| `snowglobe pool <dir>` | Sites under `dir` share one blob store. Run before `pwa`. |
| `snowglobe pwa <site> [--name N] [--short-name N]` | Installable, offline once run. |
| `snowglobe pack <site> [-o site.tar.gz]` | One tarball (.tar.gz or .tar.zst) for a CDN. |
| `snowglobe bundle <dir\|url> [-o FILE] [--target linux\|darwin]` | One executable that runs the site. |
| `snowglobe warm <dir> <reads.json ...>` | Add files recorded by `run --record-reads`. |
| `snowglobe agent-pages <dir>` | See snowglobe-agents. |

More: https://filipecabaco.github.io/snowglobe/docs/building/ and the "Build flags" section of https://filipecabaco.github.io/snowglobe/llms.txt
