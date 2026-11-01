# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Plain static HTML/CSS/JS, no framework or build step for the site itself (`site/index.html`,
copied into `dist/` by `mise run build`). Deployed to GitHub Pages next to the demo builds.

## Users

Curious developers arriving from a link (Hacker News, social posts, talks) with about a minute of
attention, deciding whether this is a trick or real. Success: they open a demo and type into it.
People who might package their own project with snowglobe are secondary; the repo serves them.

## Product Purpose

snowglobe is a Go CLI that packages a Docker image (arm64 Alpine) into a static website that runs
it in the browser: real Linux on a 64-bit ARM CPU emulated in WebAssembly (armless), restored from a
snapshot taken once the app was ready. The demo page showcases ten such runs, one per language, a shell of ordinary tools and the Supabase stack,
each a small project with a real dependency. The same sites also run outside a browser (in a
container, natively with no Docker, or as one executable) as sandboxes that agents, job runners
and CI drive; that is the repo's story more than the page's, which shows it in "Make your own".

## Positioning

Every demo is a sandboxed run in the visitor's own browser: a whole machine with no server behind
it, whose only way out (when a run opts in) is the visitor's own browser requests, and that the
visitor can break and close. Not a transpiler, not a remote
shell, not a subset runtime: the real program built from a Dockerfile.

## Operating Context

- Demos open in their own browser windows; the index page presents them and the runs.
- Each demo build emits measured data: `warm-report.json` (files read by phase) and the snapshot.
- Demos: Supabase (the CLI's native stack and a notes app on it), Elixir IEx (plain IEx from Alpine packages), PostgreSQL (psql against a Postgres 18 server), Elixir + Postgres (Ecto/Postgrex, PostgreSQL 18 in the guest), Python + Rich, TypeScript + Zod (tsx), Go + Bubble Tea
  (Game of Life), Rust + clap (jtab), Java + Gson (jshell, OpenJDK 21), curl + jq (a shell, network on).
- Repository: https://github.com/filipecabaco/snowglobe. Site: https://filipecabaco.github.io/snowglobe/

## Capabilities and Constraints

- Everything runs emulated on 64-bit ARM (translated to WebAssembly as it runs): slower than native. Cold loads take seconds (a CDN
  cache miss right after a deploy can take ~15 s); commands take tens of milliseconds (Rust) to
  several seconds (Java snippets compile with javac).
- Networking is opt-in per run (`--network fetch`): HTTP(S) and WebSockets leave as the visitor's own
  browser requests (CORS applies); other TCP only to the destinations the site tunnels over
  WebSockets (`--tunnel`), with per-connection tokens so no credential ships with the site;
  otherwise the guest has no network. No snowglobe server exists.
- Guests must be arm64 Alpine images. Sites can have several CPUs (`--cpus`), each in a Web Worker.

## Brand Commitments

Name: snowglobe (lowercase). Runs on armless, which grew out of v86 by Fabian Hemmer and contributors,
which must be credited.
The repo's voice is candid ("this is an experiment"); claims stay honest.

## Evidence on Hand

- The ten live demos, and per-demo measurements produced by the build (`warm-report.json`, run
  metadata). No users, testimonials, stars, adopters or benchmarks against other tools exist; never
  fabricate them.

## Product Principles

1. The run is the argument: get a visitor into a running sandbox fast.
2. Honest about the trade: emulated, slower than native, and the page says so.
3. Show measured facts, not adjectives: every number on the page comes from a build.
4. Sandboxed and local: emphasise that the machine lives entirely in the visitor's tab.
