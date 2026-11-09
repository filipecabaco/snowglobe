---
name: snowglobe-agents
description: Use when an agent drives snowglobe machines: `snowglobe mcp <site|url>`, `snowglobe mcp --daemon`, `snowglobe sh` as a sandbox, `--agent` sites, the /agent/ page and its WebMCP tools (run_command, write_files, run_sql, open_preview, preview_snapshot, preview_interact), awake limit, building a React app on Supabase.
---

# Agents

Two ways in, same machines. The CLI and daemon are the primary one.

## MCP servers (native, over stdio)

```sh
claude mcp add sandbox -- snowglobe mcp https://filipecabaco.github.io/snowglobe/python/
claude mcp add snowglobe -- snowglobe mcp --daemon
```

- `snowglobe mcp <dir|url> [--name N] [--keep] [--log-dir DIR]`: one isolated Linux machine with tools `run_command` (with `timeout_seconds`), `write_file`, `read_file`. No Docker, KVM or privileges. Stops when the agent goes; `--keep` leaves it.
- `snowglobe mcp --daemon`: the daemon's tools: `status`, `list_templates`, `add_template`, `remove_template`, `list_machines`, `up`, `stop_machine`, `run_command` (on a `machine`, a fresh fork of a `template`, or a `service` replica), `write_file`, `read_file`, `snapshot_machine`, `list_snapshots`, `remove_snapshot`, `list_services`, `add_service`, `remove_service`, `build`, `build_status`, `list_builds`, `cancel_build`, `submit_run`, `run_status`, `list_runs`, `list_ports`, `check_port`, `recent_events`, `fleet_diff`, `fleet_plan`, `fleet_apply`, `graph`, `list_links`, `link`, `unlink`, `list_fleets`, `add_fleet`, `write_fleet`, `read_fleet`, `apply_fleet`, `start_instance`, `stop_instance`, `forget_fleet`. `SNOWGLOBE_DAEMON` points it at another daemon.
- Without MCP: `snowglobe run <site> --name box --detach --runtime native`, then `snowglobe sh box '<cmd>'`, `snowglobe cp`. Add `--fork` for a fresh machine per `sh` (untrusted code). See snowglobe-run.

## The agent page, `/agent/` (the same machines in a browser tab)

https://filipecabaco.github.io/snowglobe/agent/ holds every `--agent` site of a deployment, each a Linux machine in its own Web Worker. Nothing runs on a server; the page has no AI of its own.

```sh
snowglobe build examples/duckdb --agent --out dist/duckdb   # or LABEL snowglobe.agent="true"
snowglobe pool dist; snowglobe pwa dist/duckdb
snowglobe agent-pages dist          # dist/agent/runtimes.json, scripts, service worker
```

Labels: `snowglobe.agent-purpose` (one line), `snowglobe.agent-sample` (a command to try), `snowglobe.agent-watch=DIR` (page shows files each command changed, with diffs), `snowglobe.agent-name`, `snowglobe.agent-exposed-to` (JSON array of https origins that may also use the WebMCP tools; default none).

Runtimes today: `web` (React on Supabase in `/root/app`), `supabase` (Postgres, Auth, Data API on port 54321), `python` (pip install works), `duckdb`, `postgres`, `conduit`.

## WebMCP tools (registered where the browser has `document.modelContext`)

| Tool | Does |
|---|---|
| `list_runtimes` | machines, state, `awake_limit`, `preview_base`, open `preview` |
| `run_command {runtime, command, timeout_seconds, request_id}` | start a job, returns a job id |
| `job_status {job_id}`, `cancel_job {job_id}` | output ending `[running]`, `[exit N]`, `[timed out]` or `[stopped]` |
| `write_file`, `write_files {runtime, files, move, delete, wait_for_build}` | text files (1 MiB each); `write_files` is one atomic change and waits for web's rebuild |
| `list_files`, `read_file {runtime, path \| paths}` | tree; up to 20 files per call |
| `revert_changes {runtime, to: "previous" \| "start"}` | undo the last change (last 20 kept) or go to the starter |
| `build_status {runtime, port}` | web's last build |
| `run_sql {sql, runtime}` | SQL on `supabase` (default) or `postgres`, then reloads the Data API schema |
| `copy_file {from_runtime, from_path, to_runtime, to_path}` | one file, at most 8 MiB, sha256-checked; slow (tens of KiB/s) |
| `open_preview {runtime, port, path}`, `close_preview` | show a machine's web server in the page |
| `preview_snapshot {maxChars}` | outline with refs like `e3`, text, console errors, failed requests |
| `preview_interact {actions, maxChars}` | `click`, `type`, `press`, `select`, `check`, `scroll`, `wait_for` with real DOM events |
| `set_awake_limit {count}` | 1 to 8 for this page load |

Exact current names and schemas live in `internal/site/agent-webmcp.js`; the page also exposes `window.snowglobeAgent` and a plain form.

## Build an app on Supabase (web + supabase)

1. `open_preview {runtime: "web", port: 4173}`.
2. `list_files {runtime: "web"}`, then `read_file`.
3. `write_files {runtime: "web", files: [...]}` with whole-file text; it returns `[build N ok in S s]` or `[build N FAILED: <error>]`.
4. Schema: `run_sql`, and keep the migration in `/root/app/supabase/migrations/<timestamp>_<name>.sql`. Every new table needs row level security and policies for `authenticated`.
5. Check it like a person: `preview_snapshot {}`, then `preview_interact {actions: [...]}`.
6. `revert_changes {runtime: "web", to: "previous"}` to undo; "Revert to starter" in the page asks the person.

## Gotchas

- No dialog: the machines run in the tab, so runs, copies and previews start at once. Only "Start fresh" and "Revert to starter" confirm, as they delete work.
- A server must listen on `0.0.0.0`, not localhost, to be previewed. Preview carries HTTP/1.1 and WebSockets (up to 32); Vite's dev server and hot reload are untested there, use `serve --watch dist 4173`.
- Jobs: one at a time per machine, as root from `/root`, default timeout 300 s (max 3600); timed out or cancelled kills everything started.
- Few machines awake at once (2 by default, about 540 to 740 MB each); the least recently used idle one suspends. A machine with a job, copy or open preview is never suspended.
- Only a suspended machine's state survives a reload. Awake work since the last suspend is lost.
- The page refuses to run inside another page's frame and needs the network.

More: https://filipecabaco.github.io/snowglobe/docs/agents/ and the "The agent page" section of https://filipecabaco.github.io/snowglobe/llms.txt
