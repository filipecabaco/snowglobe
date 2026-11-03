# snowglobe orchestration

Goal: snowglobe as one self-contained tool that packages (`build`), runs (`run`) and orchestrates
(`daemon`, `service`, and later `apply`) Linux machines, with no Docker, KVM or root at run time:
Firecracker plus a small control plane, on Linux and macOS alike, with sites that also run in a
browser. Measured against Firecracker in `bench/machines/README.md`.

## Built

| PR | What |
|---|---|
| #37 | `run --fork`: an instance whose every `sh` runs on a fresh fork of one restore |
| #38 | The fork server compiles the site's JIT profile once, before forking (armless 0.7.0) |
| #39 | Persistent forks: a fork server's `spawn` makes a lasting machine; `connect` on control sockets |
| #40 | `snowglobe daemon`, `template`, `up`, and the HTTP/JSON API |
| #41 | Snapshots of running machines: `snapshot save`, `up --snapshot`, `template add --snapshot` |
| #42 | Services: replicas on demand behind ports the daemon holds, scale to zero |
| #44 | Ports only on templates whose guest has a network |
| next | Memory budget with a queue, machine TTL, templates that sleep when idle |

### The primitive: machines forked from one restore

A template is a site restored once by a fork server (`snowglobe-vm run SITE --serve SOCK
--jobs-root DIR`), whose JIT has compiled the site's profile before any fork. Its socket takes:

- `{"mode": "job", ...}`: one job on a fresh fork, which ends with it.
- `{"mode": "spawn", "name": N, "state": PATH?}`: a fork that lasts as a machine, serving its own
  control socket `N.sock` beside the server's; from a saved state under the jobs root when given.
  Machines count against `--max-machines`, apart from jobs' `--max-jobs`.

A machine's control socket (also any `run --detached` instance's) takes `exec`, `attach`, `job`,
`save` (the whole machine, zstd, to a path its sandbox may write) and `connect` (the socket becomes
a connection to a guest port). A fork's sandbox (Landlock and seccomp, or Seatbelt) binds no TCP
port of its own, so whoever holds the host's port forwards it in through `connect`.

A fork shares the template's memory copy-on-write: ~20 ms and ~15 MB a machine on Linux.

### The daemon

One process per host (`snowglobe daemon`) keeps templates, machines, snapshots and services in
`state.json` under the user cache (`$SNOWGLOBE_DAEMON_DIR`), and serves the API on a 0600 Unix
socket there, and over TCP to requests bearing a token (`--listen ADDR --token-file F`). Template
servers run in sessions of their own, so templates and machines outlive the daemon: one started
again takes back what still runs (ports included), and forgets what stopped.

```
GET    /v1/health
GET    /v1/templates                 POST /v1/templates {site, name?, max_machines?, snapshot?}
DELETE /v1/templates/{t}             (its machines too; refused while a service runs on it)
POST   /v1/templates/{t}/jobs        a job on a fresh fork
GET    /v1/machines?label=k=v        POST /v1/machines {template, name?, ports?, labels?, snapshot?}
GET    /v1/machines/{m}              DELETE /v1/machines/{m}
POST   /v1/machines/{m}/jobs         {cmd, env?, files?, timeout?} → {status, output, out, ...}
POST   /v1/machines/{m}/snapshots    {name?} → snapshot
GET    /v1/snapshots                 DELETE /v1/snapshots/{s}
GET    /v1/services                  POST /v1/services {name, template, ports?, min, max, idle,
                                                        concurrency, state, labels?}
GET    /v1/services/{s}              DELETE /v1/services/{s}
POST   /v1/services/{s}/jobs         a job on one of its replicas (started if at zero)
```

The CLI reaches it automatically: `sh`, `cp`, `mcp`, `exec`, `attach`, `ps` and `stop` find the
daemon's machines (and `sh` its services) when there is no instance of that name;
`SNOWGLOBE_DAEMON=http://HOST:PORT` with `SNOWGLOBE_DAEMON_TOKEN` points it at another daemon.

### Snapshots

A snapshot is the whole machine: memory, running processes, and the files its guest wrote (armless
saves the 9p filesystem's written contents). The machine writes it under its template's jobs root
(all its sandbox writes) and the daemon moves it into its own `snapshots/`; a machine started from
it reads it through a link placed in its template's jobs root. A snapshot goes only onto templates
of its own site. A template of a snapshot (`--state FILE` to the fork server) serves that state
in place of the site's: set a machine up once, then fork it already set up.

### Services and scale to zero

A service holds host ports; each connection (or job) goes to the least busy replica under
`--concurrency`, else a new one up to `--max`, else the least busy. Replicas with no connection or
job for `--idle` stop, down to `--min`; with `--min 0` the next request forks one again (~20 ms
to an answer when the template is a snapshot with its server listening). `--state keep` (one
replica) saves the replica before it stops and starts the next one from that save; `discard`
starts each from the template.

### Limits and lifecycle

- **Memory budget** (`daemon --memory`, none by default): template servers' and machines' memory
  (Linux: each process's PSS; macOS: RSS, which counts shared pages in full) plus a new machine's
  estimate (the median of its template's machines, else 64 MB) must fit. Admissions go one at a
  time, each held until its machine is up; one that doesn't fit waits up to `--wait` (30 s), then
  is refused with a 429 saying what is used, the budget, and the estimate.
- **Time to live** (`up --ttl`): the machine is stopped when it is up, whatever it is doing.
- **Templates that sleep** (`template add --idle`, off by default): with no machine and no job for
  that long, the server stops (asleep in `template ls`); the next `up`, job or replica restores it
  first (~1.4 s for the curl example, prewarm included). A snapshot a template is made of can't be
  removed under it.

## Not built yet

1. **Visibility.** `GET /v1/events` (server-sent events: created, up, stopped, crashed, reaped,
   scaled) and `snowglobe top`.
2. **Declarative fleets.** `snowglobe apply|diff|down [-f snowglobe.toml]`: templates (a site, a
   URL, or a Dockerfile directory built first), snapshots and services with the fields above, and
   the daemon converging to them.
3. Later: several hosts (a daemon per host, one scheduling), per-machine networks, metrics.

## Decisions

- API on a Unix socket and over TCP with a bearer token (`--listen` refuses to start without one).
- The CLI goes through the daemon by itself when one runs; standalone instances work as before.
- Snapshots are whole machine states (zstd), not deltas over the template: simple, and 10–20 MB
  for the python example.
- Scale to zero applies to services (not to plain machines or template servers yet); its state is
  per service, `discard` or `keep`.
