---
name: snowglobe-run
description: Use when running a built site with `snowglobe serve`, `snowglobe run`, `sh`, `cp`, `exec`, `attach`, `stop`, `ps`, or the daemon (`daemon`, `template add`, `up`, `snapshot save`, `submit`, `snowglobe ui`). Covers where state lives and how saving works; fleet files are snowglobe-fleet.
---

# Running a site

A site can be a directory, a tarball, a tarball URL or a deployed site's URL (fetched and cached first; the sandbox stays offline).

## One instance

```sh
snowglobe serve dist/app [--port 8000]                  # preview in a browser
snowglobe run dist/app                                  # session in a terminal; ctrl-] quits
printf 'Enum.sum(1..100)\n' | snowglobe run dist/elixir # piped: each line typed in, output printed
snowglobe run dist/app --name pg --detach --runtime native
snowglobe exec pg 'sql "SELECT 1"'    # type into the app, print only what it printed
snowglobe sh pg 'ls /root'            # shell command on the root shell, whatever the app is
snowglobe sh pg --json --timeout 60 'ls /nope'   # {"exit","output","timed_out","killed"}
snowglobe cp ./project pg:/root/project          # name:/path on one side; either direction
snowglobe attach pg    # ctrl-] detaches
snowglobe ps
snowglobe stop pg
```

- `--runtime docker` (default): unprivileged, read-only, memory-capped container. `--runtime native` (or `SNOWGLOBE_RUNTIME=native`, or no Docker): snowglobe-vm sandboxes itself (Landlock and seccomp on Linux, Seatbelt on macOS).
- `sh` takes its command as ONE quoted argument. Default timeout 300 s, then everything it started is killed (exit 124).
- `-p HOST:GUEST` forwards a port (127.0.0.1 unless `IP:HOST:GUEST`); the site needs `--network fetch`.
- `--max-runtime 30m` ends the run (exit 124); `--stop-file PATH` ends it when PATH exists (exit 143).
- `--log-dir DIR` keeps `console.log`, `serial.log`, `events.jsonl`. Named native instances log to the cache's `snowglobe/logs/<name>`.
- `--fork` (with `--detach --name`, native): every `sh` runs on a fresh copy, forked in milliseconds. Only `sh` works on it; `cp`, `exec`, `attach`, `mcp` need a machine that lasts.
- `--record-reads FILE` records files the guest reads; feed it to `snowglobe warm`.
- One executable: `snowglobe bundle dist/app -o app`, no Docker or hypervisor.

## The daemon: templates and machines

```sh
snowglobe daemon --detach [--memory 8G] [--wait 30s]    # log in daemon.log beside the socket
snowglobe template add dist/api --name api [--max-machines N] [--idle 30m]
snowglobe up api --name web -p 8080:8000 --label app=web [--ttl 1h]
snowglobe sh web 'python3 -m http.server 8000 &'
snowglobe submit api 'python3 report.py' --env DAY=mon --timeout 600   # prints a run id
snowglobe runs <id> --wait                              # output; exits with its status
snowglobe ps; snowglobe ports; snowglobe ports check 8080
snowglobe events; snowglobe top --once
snowglobe template rm api                               # and its machines
snowglobe daemon stop                                   # and everything it started
snowglobe ui [--port 7777] [--no-open] [--start-daemon] # the daemon in a browser, 127.0.0.1 only
```

- `sh`, `cp`, `exec`, `attach`, `stop`, `ps` reach daemon machines like instances.
- Nothing the daemon starts outlives it. Restarted, it restores templates and services' replicas; machines are not brought back.
- `--memory` caps templates and machines together: a machine that does not fit waits `--wait`, then is refused (429). macOS counts shared pages in full, so the cap bites sooner.
- Another daemon: `SNOWGLOBE_DAEMON=http://HOST:PORT` with `SNOWGLOBE_DAEMON_TOKEN`; serve one with `daemon --listen ADDR --token-file F`.

## Saving and resuming

```sh
snowglobe snapshot save web --name ready      # memory, processes, files written
snowglobe up api --name again --snapshot ready
snowglobe template add --snapshot ready --name api-ready   # every machine starts there
snowglobe snapshot ls; snowglobe snapshot rm ready
```

- Instances start fresh from the site's snapshot; native instances of one site share its memory image copy-on-write (a restore takes milliseconds).
- A machine keeps what it writes until stopped. Save it to keep it past that.
- In a browser tab, saves are local (browser storage, a `.snowglobe` backup file, or a folder), tied to the exact site build; backups are unencrypted. See https://filipecabaco.github.io/snowglobe/docs/saving/.

More: https://filipecabaco.github.io/snowglobe/docs/running/ and https://filipecabaco.github.io/snowglobe/docs/orchestration/
