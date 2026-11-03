# snowglobe

**Package a Docker image into a website that runs it in the browser.** snowglobe boots your
image on real Linux inside [armless](https://github.com/filipecabaco/armless), a 64-bit ARM
machine compiled to WebAssembly, snapshots it once your app is ready, and writes a folder of
static files. Visitors get your program running in their tab in about a second, with no server
behind it. The same site also runs headlessly, as one executable, and as a sandbox an agent drives.

**[▶ Try the demos](https://filipecabaco.github.io/snowglobe/)**: Supabase (its native stack and a small app on it), Elixir IEx, PostgreSQL, Elixir + Postgres, Python + Rich, TypeScript + Zod,
Go + Bubble Tea, Rust + clap, Java + Gson, and curl + jq (plain Alpine tools, online through your browser), each a small
project in [`examples/`](examples) running in the browser.

**[📖 Read the docs](https://filipecabaco.github.io/snowglobe/docs/)**: getting started, building,
networking, running headlessly, driving it from agents and programs, isolation, and the CLI
reference.

[![CI and Pages](https://github.com/filipecabaco/snowglobe/actions/workflows/pages.yml/badge.svg)](https://github.com/filipecabaco/snowglobe/actions/workflows/pages.yml)

```sh
go install github.com/filipecabaco/snowglobe/cmd/snowglobe@latest   # or a binary from the releases
snowglobe build ./my-app          # a directory with a Dockerfile, or any image reference
snowglobe serve dist              # preview at http://localhost:8000, then deploy dist/ anywhere
snowglobe run dist                # or run it in your terminal, sandboxed
```

> [!NOTE]
> This is an experiment. Everything runs on an emulated 64-bit ARM CPU (translated to WebAssembly as
> it runs), so expect it to be slower than native. Images must be arm64 Alpine.

## Documentation

The docs live on the site, written for people using snowglobe:
[filipecabaco.github.io/snowglobe/docs](https://filipecabaco.github.io/snowglobe/docs/)
(source: [`site/docs/index.html`](site/docs/index.html)).

- [Getting started](https://filipecabaco.github.io/snowglobe/docs/#start): what you need, install, your first site
- [Building a site](https://filipecabaco.github.io/snowglobe/docs/#build): labels and flags, readiness, exercises and the warm pack, CPUs, building without Docker
- [Networking](https://filipecabaco.github.io/snowglobe/docs/#network): HTTP(S) and WebSockets through the browser, tunnels for other TCP, credentials
- [Running outside a browser](https://filipecabaco.github.io/snowglobe/docs/#run): sessions, instances, sites from a URL, one executable, jobs
- [For agents and programs](https://filipecabaco.github.io/snowglobe/docs/#agents): `sh`, `cp`, MCP, limits, stop files and logs
- [Isolation](https://filipecabaco.github.io/snowglobe/docs/#security): what each of the browser, native and Docker guards against
- [CLI reference](https://filipecabaco.github.io/snowglobe/docs/#reference): every command, flag, label and environment variable

For agents, the site also serves a plain-text summary of the CLI at
[llms.txt](https://filipecabaco.github.io/snowglobe/llms.txt).

## Share a run as a post

Every demo has an X player card at `card/<demo>/` (e.g.
[filipecabaco.github.io/snowglobe/card/elixir/](https://filipecabaco.github.io/snowglobe/card/elixir/)):
shared on X, the post itself boots the run in a 480×480 frame, and the link opens the demo page.
`elixir assets/cards.exs` writes the card pages and poster sources from `assets/cards.json`, where
each poster's lines are real output from that run; capture each poster at 480×480 into
`site/card/<demo>/poster.png`. X caches cards for about a week, so re-share with a new query string
after changing one.

The frame inside a post can't be cross-origin isolated, so a card can only boot a one-CPU run. A
demo on several CPUs gets a one-CPU build for its card: `supabase-1cpu` in `DEMOS` is
`examples/supabase` built with `--cpus 1` (any `<example>-<n>cpu` works), and the card's `player`
in `assets/cards.json` names it.

## Development checks

Run `go test ./...`, `node --test internal/site/sessions.test.cjs` and `node --test
bench/lib.test.mjs bench/server.test.mjs` (Node 22+; no npm packages needed), or `mise run test`.
`snowglobe-vm` has its own tests: `cargo test` in `internal/tools/runtime` (the job launcher's run
on a pty and killed with ctrl-c on Linux only; CI runs them under dash and BusyBox ash). The
end-to-end suite drives the CLI against a built site, natively and in Docker (jobs, kills,
timeouts, `--max-runtime`, `--stop-file`, the logs, MCP, bundles):

```sh
SNOWGLOBE_E2E_SITE=dist/curl go test ./cmd/snowglobe -run TestE2E -v
```

(`SNOWGLOBE_E2E_DOCKER=0` skips the Docker runs; `SNOWGLOBE_VM` names a snowglobe-vm where there is
no release for this system.) CI runs it against the curl site. To exercise real IndexedDB transactions, Web Locks and filesystem
writable streams, serve the repository on localhost and open
`internal/site/sessions.browser.html` in a visible tab; its results are displayed on the page.
The automatic-saving check requires the tab to remain visible, just like the demos. Full session
restore should also be checked against a built demo, since storage tests do not verify the VM.

## Benchmarks

`bench/` measures built sites end to end in Chromium (Playwright), the way visitors use them:

- **cold**: a first visit, in a fresh browser profile: the page opened until the terminal is live
  (the snapshot downloaded and restored, the screen replayed)
- **warm**: a repeat visit in the same profile, served by the service worker (saved workspaces
  are cleared first, so it restores the site's snapshot, not a save)
- **4G cold**: a first visit over a slower link (9 Mbit/s, +75 ms per request)
- **workload**: on the warm visit, each of the site's `exercise` commands typed in, timed until it
  has finished printing (its `ready` prompt is back, or the guest has gone quiet)

with what each visit downloaded, its requests and the page's JS heap. A local server stands in
for GitHub Pages (its caching headers; the throttling is done there, so the service worker's and
the CPU workers' requests are slowed too).

```sh
snowglobe build examples/python --out dist/python
snowglobe pwa dist/python          # the service worker the live demos have (warm visits use it)
(cd bench && npm ci)               # Playwright; then `npx playwright install chromium` once
node bench/run.mjs dist/python     # --reps 3 by default; bench-results/python.json + summary.md
```

Its options (repetitions, scenarios, the link's speed) are listed at the top of `bench/run.mjs`.
`node bench/report.mjs bench-results --baseline FILE` compares results with an earlier run's
(`node bench/report.mjs DIR --combine FILE` makes one).

In CI every site job benchmarks its site, and the `bench-report` job of the same run turns the
results into one report: in the run's summary and, on a pull request, in one comment updated by
each run. It leads with a verdict, then a table per demo of cold, warm, 4G cold and workload
(medians), with downloads, requests, each metric's min–max and per-command times folded
underneath, the commit measured and a link to the run.

Every run is also kept as a file on `refs/snowglobe/bench` (outside `refs/heads`, like the blob
store): `pr/<number>/<commit>.json` for a pull request, `main/<commit>.json` and
`main/latest.json` for main. The comment lists the pull request's earlier runs (each commit's
medians, per demo), and once main has a run, compares with main's latest: a change is flagged only
when no visit of the run overlaps main's (its min–max is clear of main's) and the medians differ
by 15% or more for times, 10% for counts and sizes. Two shared runners differ by up to ~13% on the
same build (every command a little slower on one), so read smaller changes as noise. To read the files:
`git fetch origin refs/snowglobe/bench && git show FETCH_HEAD:pr/16/<commit>.json`.

The numbers never fail CI; only a harness that can't measure does. A pull request from a fork has a
read-only token: its report stays in the run's summary, and its results aren't kept.

To measure an armless change, run "CI and Pages" by hand with `armless_ref` (a branch, tag or full
commit of armless): the tools image is built on it ([`bench/use-armless.sh`](bench/use-armless.sh):
snowglobe-vm and the browser runtime both from that commit), every site is rebuilt and
re-snapshotted on it, benchmarked and compared with main's latest, and nothing is deployed or kept.
Rebuilding matters: a snapshot carries the machine it was taken on (the guest reads the CPU's
features once, at boot), so swapping only armless.wasm under an old snapshot would not measure the
new one.

## Develop

```sh
mise install       # Go, pinned in mise.toml
mise run test
mise run build     # build all ten demos into dist/ (a few minutes)
mise run serve
```

Pushing to `main` runs the tests and the same build in GitHub Actions, and deploys `dist/` to
GitHub Pages.

To release, change [`VERSION`](VERSION) in a pull request (`0.3.0`, or `0.3.0-rc.1` for a
prerelease). Once it's on `main`, [`release.yml`](.github/workflows/release.yml) runs the same
checks, tags `v<VERSION>` on that commit, publishes the tools image and puts the binaries on a
GitHub release. A version that is tagged already releases nothing; pushing a tag by hand still
releases it as before.

```
cmd/snowglobe/        the CLI (and its end-to-end tests)
internal/build/       a build: image → boot layer → 9p filesystem → snapshot → site
internal/rootfs/      tar stream → 9p filesystem + warm pack
internal/boot/        the boot layer written on top of your image: the prebuilt kernel and BusyBox init
internal/oci/         images: registries, docker save and OCI layouts, layers flattened
internal/tools/       build container: snowglobe-vm (runtime/, Rust on armless) + armless.js and
                      xterm.js (pinned)
internal/native/      finding snowglobe-vm for running natively
internal/instance/    run, exec, attach, ps, stop, sh, cp: in a container or natively
internal/daemon/      the orchestrator: templates, machines forked from them, snapshots, services
                      that scale to zero, and its HTTP/JSON API (snowglobe daemon)
internal/control/     snowglobe-vm's control sockets: jobs, spawn, save, connect
internal/bundle/      a site and snowglobe-vm in one executable
internal/mcp/         the MCP server
internal/site/        each built site's run page (the terminal, saves, the service worker)
internal/pool/        shared blob store for several sites
internal/pwa/         installable sites
internal/pack/, internal/remote/
                      one-tarball sites, and sites run from a URL
bench/                end-to-end benchmarks of built sites (Playwright); bench/machines/: as a
                      machine runtime, against Firecracker too
docs/design/          designs, and what of them is built
examples/             one Dockerfile per demo language
site/                 the demo index page and the docs (site/docs/)
```

## Credits

The machine is [armless](https://github.com/filipecabaco/armless), which started as a fork of
[v86](https://github.com/copy/v86) by Fabian Hemmer and contributors. snowglobe was built on v86
first, and its 9p filesystem format is v86's. The idea and early setup came from
[snaplet/postgres-wasm](https://github.com/snaplet/postgres-wasm) and
[iximiuz/docker-to-linux](https://github.com/iximiuz/docker-to-linux).
