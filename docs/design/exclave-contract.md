# exclave ↔ snowglobe daemon contract

exclave (a multi-tenant service that runs untrusted scripts) delegates execution and builds to
`snowglobe daemon`. This is the interface both sides build against. Everything here extends the
daemon's **existing** API (`internal/daemon`, `internal/control`); nothing existing changes
meaning, and every new field is optional with today's behaviour as its default.

The invariant behind every choice: **a machine is never shared between teams**, and nothing one
job writes is visible to another job.

## Connection

The daemon's Unix socket (default location, or `SNOWGLOBE_DAEMON=/path/to.sock`), or a remote
daemon started with `--listen` (`SNOWGLOBE_DAEMON=https://host:port` + `SNOWGLOBE_DAEMON_TOKEN`,
bearer token) — exactly what the snowglobe CLI uses. HTTP/JSON. `[]byte` fields are base64 (Go's
encoding/json).

## Toolkit templates (provisioned by the operator, or by exclave via `POST /v1/builds`)

One template per toolkit, named `exclave-<toolkit>` (e.g. `exclave-jq`, `exclave-python`),
optionally labelled `exclave.toolkit=<toolkit>`: exclave matches toolkit templates by name.
exclave lists `GET /v1/templates` and treats a toolkit as runnable here iff its template exists. Built with `--network fetch` when it has to serve builds
or egress-granted runs, and with **`--memory-limits`** (`"memory_limits": true` on `POST /v1/builds`),
since exclave sends `memory_limit_mb` with every run: without it the guest boots with its kernel's
memory controller off (fork-heavy jobs ~5% faster) and such a job fails with an `error` saying so.
Team templates made from a build machine's snapshot inherit the toolkit template's guest.

**Warm-up**: `"warm": ["cmd", …]` (and `"warm_runs"`, default 3) on `POST /v1/templates` (or
`POST /v1/builds`; `snowglobe template add --warm CMD`) runs each command on the site that many
times before its server starts, as one-shot runs of their own (no network, an empty workspace,
for no team). The site's JIT profile learns what they compiled; the server compiles that before
it forks a job, so jobs start with it instead of interpreting until it gets hot. These are the
operator's commands — the only runs a shared profile learns from; jobs only read it. A failing
warm-up fails the add (422); a template of a snapshot (one team's) can't be warmed (400). exclave
toolkit templates are added with a representative command of their toolkit (`jq -n 1`, say).

## Running a job: `POST /v1/templates/{name}/jobs` (a job on a fresh fork)

Request — `control.JobRequest`, extended:

| field | type | meaning |
|---|---|---|
| `files` | map path → bytes | existing: written into the job's working directory before it runs |
| `cmd` | string | existing: run with `sh -c` in the working directory, stdin `/dev/null`, stderr merged into stdout |
| `env` | map | existing |
| `timeout` | seconds | existing |
| **`workdir`** | string | NEW. Absolute guest path the job runs in, its `files` land in and its `out/` is read from (default: today's per-job dir). Lets a run fork from a build snapshot whose workspace already sits at e.g. `/workspace`. A fork is copy-on-write, so writing there is private to the job. |
| **`memory_limit_mb`** | int | guest cgroup v2 `memory.max` (+ `memory.swap.max` 0) for the command. OOM → `oom: true`, `status` 137. Needs a template built with `--memory-limits` |
| **`cpus_limit`** | number | guest `cpu.max` quota, may be fractional |
| **`pids_limit`** | int | guest `pids.max` |
| **`disk_limit_mb`** | int | budget on what the guest's file writes hold in host memory → guest sees ENOSPC; `disk_full: true` |
| **`max_rss_mb`** | int | host-side cap on the forked job's own resident memory → job ends, `oom: true`, `status` 137 |
| **`cpu_time_s`** | number | host CPU time of the forked job (all emulator threads) → `cpu_time_exceeded: true` |
| **`output_limit`** | bytes | job killed past it, output cut there, `output_truncated: true` |
| **`copy_limit_mb`** | int | cap on files copied in and on `out/` copied back, each |
| **`egress`** | string | `none` \| `https` (TCP 443 + DNS only, private/loopback/link-local refused) \| `internet` \| `private`; at most what the template's network allows |
| **`read_only_in`** | bool | the working directory's `in/` is read-only in the guest |
| **`labels`** | map | recorded on the job/fork (exclave sends `exclave.team`, `exclave.execution`): in the fork's log and a `job.ended` event carrying them. Not in metrics (`exclave.execution` is unique per run: unbounded label cardinality) |

A limit that can't be enforced (a guest kernel without cgroup v2, `memory_limit_mb` on a template
built without `--memory-limits`, a template without network for
an egress request) **fails the job with an `error` saying so** — never runs it unenforced. Such a
job-level failure is answered **200 with a `JobResult` whose `error` says why** (`status` null).
Non-2xx is kept for API errors: 400 for a malformed request, 404 for an unknown template or
machine, 429 for admission (`500 {"error"}` remains possible for daemon-side faults).

Result — `control.JobResult`, extended:

| field | meaning |
|---|---|
| `status`, `output`, `out`, `timed_out`, `cancelled`, `killed`, `ms`, `error`, `output_cut`, `out_cut` | existing |
| **`oom`**, **`disk_full`**, **`output_truncated`**, **`cpu_time_exceeded`** | NEW booleans, as above |

On timeout or kill the job still returns what it printed and its `out/` (bounded). `max_rss_mb`
past its limit reports `status` 137 with `oom: true`; `cpu_time_s` reports `status` null with
`cpu_time_exceeded: true`.

**With `workdir`**, the job's `files` are copied into it by the guest (`cp -a`) before the command
starts, and `out/` is read from `<workdir>/out`: only files the job created or changed there come
back (what a build left in `out/` is not the run's result). A workdir must be absolute and not
`/`, `/proc`, `/sys`, `/dev` or `/sgjob`.

**Cancel**: the client closing its connection ends the job and its fork promptly (the daemon must
notice the disconnect) and frees its admission slot and memory; nothing is answered (the
connection is gone). For `/v1/runs` (async), a run whose job was stopped reports
`cancelled: true`. No separate verb needed for synchronous jobs.

**Capacity**: when the memory budget (`daemon --memory`) refuses admission the daemon answers
`429` (existing); exclave treats that as "no capacity" and retries within its own queue wait.

**Isolation of a forked job**: before it starts a thread, each fork restricts its own
filesystem access (Landlock) to its own job state, so a job escaping the emulator can't reach
another job's files, env or output. A job (and a machine) also can't open a Unix socket
(seccomp; on macOS Seatbelt refuses connecting one), so it can't reach its template server's or
another machine's control socket. Nothing a template server shares between jobs (so between
teams) is writable by a job: the JIT profile the server compiled from is read only and never
learns from its jobs (so one team's runs can't shape, or be timed from, another's: it learns only
from the operator's warm-up), and the server's log handles are closed in each fork before guest
code runs, its stdout and stderr (the template's log, under the daemon) pointed at `/dev/null`:
a job's output, the guest's stdout and stderr merged, is what its answer carries and nothing
else, whatever it writes to the guest's consoles. Template servers keep no
`--log-dir`; the per-job record is the daemon's `job.ended` event with the job's labels. macOS is
a development platform, not a multi-tenant one: run other teams' jobs on Linux. A
machine (`POST /v1/machines`) gets a directory of its own under its template's jobs root
(`.machines/<name>`), the only part of the root it can touch once it has read its starting state;
its snapshots are written there.

**Jobs on a machine** (`POST /v1/machines/{m}/jobs`) take the same fields. Its network is fixed
when it starts (Up's `egress`), so a job's `egress` must be absent or equal to the machine's —
a different one is a job error (200 + `error`). `max_rss_mb` there counts the machine's process
(at its peak), `cpu_time_s` from the job's start; past either the job is killed and the machine
goes on.

## Builds as snapshots (one per team and template version)

1. `POST /v1/machines` (Up) from `exclave-<toolkit>` with `labels {exclave.team, exclave.build}`,
   `ttl` (build timeout + 10 min) and **NEW `egress`** (`https`) — the machine's network for the
   build (at most its template's; 400 if the template's site has no network).
2. `POST /v1/machines/{m}/jobs` with `workdir: "/workspace"`, the project `files`, the build
   `cmd`, `timeout`, and the limits above. No secrets.
3. `POST /v1/machines/{m}/snapshots` → snapshot `exclave-<team>-<version_hash>` with the same labels.
4. `POST /v1/templates` from that snapshot → template `exclave-<team>-<version_hash>`; `DELETE` the build machine.
5. Runs: `POST /v1/templates/exclave-<team>-<version_hash>/jobs` with `workdir: "/workspace"`,
   only the per-run files (`assigns.json`, `in/…`).

Names: the daemon's 63-character name limit stands. exclave names team templates and
snapshots `exclave-<team id, no dashes>-<first 22 hex of the version hash>` and puts the full
values in the labels `exclave.team` and `exclave.build`.

**NEW**: `GET /v1/snapshots` and `GET /v1/templates` report `size_bytes` (what the snapshot holds
on disk; `bytes` is kept on snapshots too) so exclave can apply its per-team storage quota. A
template made of a snapshot reports that snapshot's bytes (the same bytes, not more: a snapshot
can't be removed while a template uses it); a template of a site reports the site's directory.
`DELETE` of both exists already. `GET /v1/templates?label=k=v` and `GET /v1/snapshots?label=k=v`
filter by label (repeatable: all must match).

A team's dependencies only ever exist in that team's templates; toolkit templates carry nothing
of any team.
