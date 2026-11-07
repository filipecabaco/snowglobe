# Browser agents: a Snowglobe tab as an agent's workspace (first milestone done)

Status: the first slice is built (below), with the accessible UI (the agent panel); files and
persistence are still to come. Why: normal chat agents could run whatever they need from the client's own browser,
delegating compute to the visitor's browser instead of servers.

## What the first milestone implements

Commands, with WebMCP as the way agents reach them. Opt-in: `snowglobe build --agent` (or the
label `snowglobe.agent="true"`); without it the page carries none of it.

- `internal/site/agent.js`: `window.snowglobeAgent` with `capabilities()`, `status()` (booting,
  ready, busy, saving, failed), `runCommand({command, timeoutSeconds, requestId})`,
  `readJob(jobId)` and `cancelJob(jobId)`. One job at a time; a repeated `requestId` returns the
  same job, and one reused for a different command is refused. Output keeps the most recent
  1 MiB and counts what it dropped. Default timeout 300 s, at most 3600.
- `internal/site/agent-webmcp.js`: `run_command`, `job_status` and `cancel_job`, registered with
  `document.modelContext.registerTool(tool, {signal, exposedTo})` (`navigator.modelContext` as a
  fallback). Nothing is registered without one. `exposedTo` is empty unless the site is built with
  `--agent-exposed-to`. The first run asks the person at the page: through the client's
  `requestUserInteraction` when it passes one, else a modal `<dialog>`. Where only the first
  drafts' `provideContext({tools})` is there (older polyfills), that is used instead. A model
  context added after the page starts (an extension, a polyfill loaded late) is looked for every
  250 ms for 15 s; `capabilities().webmcp` says what happened. A browser that refuses `exposedTo`
  still gets the tools, for the page's own origin.
- `internal/site/agent-panel.js`: the agent panel, for agents that drive the page's UI rather than
  call tools. In November 2026 that is most of them: ChatGPT's site tools (its WebMCP) work only in
  the ChatGPT desktop app's built-in browser, not in its agent's cloud browser or through its
  Chrome extension, and Chrome has WebMCP only behind a flag or an origin-trial token. A
  disclosure above the terminal, "Agent commands" (open at once when the address ends `#agent`):
  a "Shell command" box, Run and Cancel, a status line (`role=status`), and a "Result" section
  with the exit status and a "Command output" `<pre>` that ends as `job_status` does. Same job
  runner, and the same one question per page load: the panel and the tools share it.
- On several CPUs, only in a cross-origin isolated page (the agent page and the site's own are,
  through their service workers); elsewhere nothing is registered and `status()` says why.

The control channel is the guest's serial line (ttyS0), not a new device. Every snowglobe guest
has a root shell there beside the app (the boot layer's inittab), and the page only shows the
virtio console (hvc0), so nothing a job does reaches the terminal. The job protocol is the native
one (`internal/tools/runtime/src/job.rs`): launcher, nonce, the `SGDONE_<id>_<nonce>_<status>_<killed>`
marker, ctrl-c and a kill of the command's whole session. Two changes, because a page can't write
into the guest's filesystem: the launcher and the command are typed in as base64, in short lines,
each acknowledged by a value the shell computes; and the command's output goes straight to the
serial line (with echo and newline translation off) between a start line carrying the nonce and
the marker, rather than to a file. stdout and stderr are therefore one stream.

Not yet: `readFile` and `writeFile` (typing base64 works for small files; larger ones want a
transfer channel), `cwd` and `env`, separate stderr, saving only between
jobs, and session ids that change on restore. A save taken mid-job and restored later leaves the
serial shell busy: the next job's sync then fails with "the guest's shell is not answering" until
the old command ends, rather than being typed into it.

## Watching an agent build, on /agent/

`supabase` and `web` come up connected: Supabase's stack with a `notes` table under row level
security, and a React app (Vite 8, React 19, supabase-js) in web's `/root/app` that signs up, logs
in and keeps notes there. Each machine is its own Web Worker. The page shows the app in its
preview and, beside it, what the agent changes (`internal/site/builder.js`).

- Live reload without WebSockets. The preview bridge carries HTTP/1.1 only, so Vite's dev server
  and hot reload are out. From its boot, web runs `serve --watch dist 4173`: one Node process that
  runs Vite's build in watch mode (its JavaScript API, so the project's own vite.config.js is
  used and nothing in it has to cooperate) and serves `dist/`, answering `GET /__build` with
  `{version, state, error, ms}`. While a preview is open the page reads it through the same bridge
  (`previewGet`, never waking a machine): every 0.5 s for 45 s after a command, copy or write in
  the previewed machine, every 5 s otherwise, and not while the tab is hidden. A new version
  reloads the frame where it is; a failed build goes to the feed and the frame keeps the last good
  page. Why not reload after the job: the rebuild lands after the job ends, at a time the page
  can't know. Why not WebSockets in the bridge: a bigger change to the service worker and the TCP
  relay, for a reload that a poll does well. A server with no `/__build` gets a reload after each
  command in its machine instead.
- What changed. A runtime labelled `snowglobe.agent-watch=<dir>` runs each command inside a
  wrapper (the command itself goes in as a job file and runs unchanged): before it, a copy of
  `<dir>` is taken if there is none; after it, every file that differs is reported with BusyBox's
  `diff -U 2` (no git in the image), and the copy is updated. The report sits at the end of the
  job's output between lines with a nonce of the job's own; the orchestrator takes it out, so
  `job_status` shows the command's output plus one `[changed in <dir>: ...]` line, and `readJob`
  gives `changes`. Diffs run inside the same job, so they never hold the machine's one job slot
  after the agent's command (a separate job would make the agent's next `run_command` busy).
- `write_file {runtime, path, content}`: a text file written as a job whose content is a job file
  (no heredocs, no quoting), returning once written, with its changes.
- The feed: every run, copy, write, build and preview event in every machine, newest first,
  filterable by machine; each changed file is a disclosure with its diff in the page's one dark
  surface. "Watch an agent build" replays three edits through the same API (rename, a `done`
  column with an update policy on Supabase and its checkbox, a filter), each step waiting for its
  rebuild.

## The studio: an agent changes all of the app

The page's top is a studio laid out as AI app builders (Lovable, v0, Bolt) are, with the honest
difference that it has no model: the agent is the person's own, over WebMCP or the page's
controls. The preview is the stage (desktop, tablet and phone widths, address, reload, new tab, a
hairline while web builds, a failed build's error over the last good page); Code and Database are
tabs beside it; the agent's steps run down the left as a conversation (`builder.js`'s feed, titled
by `stepOf`: "Edited src/App.jsx", "Ran SQL on supabase", "Build 8 failed"); the machines and every
form are below. `studio.js` holds the pure parts: the tree, a tokenizer of a dozen regular
expressions for JS/TS/JSX, CSS, HTML, JSON and SQL (no highlighter library), the tables query, the
prompt to give an agent.

What an agent needed to change anything in the app, and what does it now:

- See the project: `list_files` (one job: `find` and `stat`, `node_modules`/`dist`/`.git` not
  entered) and `read_file` (one job for up to 20 files, each as base64 between frame lines, as
  `transfer.js` frames slices). Neither goes through the change wrapper, so a read costs no copy.
- Change many files: `write_files` (one wrapped job; contents as job files; each written to
  `<path>.sgnew` then all renamed together, so the watcher builds once), with `move` and `delete`.
  It reads `/__build` before and after and returns the build's result, so a syntax error reaches
  the agent in the same call. `build_status` reads it on demand.
- Back out: the wrapper keeps the copy from before the first command (`<copy>.base`) and the one
  from before each of the last 20 changing commands (`<copy>.history/<n>`). `revert_changes`
  restores one of them as an ordinary wrapped command, so its diff shows like any other change.
- Schema: `run_sql` (psql with `ON_ERROR_STOP` on a job file, then `notify pgrst`); migrations are
  kept in web's project so they show and undo with the code.
- Packages: the registry allows plain GETs from any origin but answers no preflight, so npm's own
  headers fail in the tab. `serve --registry 4874` relays to it with only `Accept`, and
  `/root/.npmrc` points npm there; `replace-registry-host` (npm's default) sends tarballs the same
  way. No page change was needed. The libraries an app usually adds (Tailwind v4, React Router,
  Zustand, clsx, TypeScript and React's types) are installed rather than cached: npm's cache keeps
  each package's whole metadata and its peers' (measured 6 to 130 MB a package), while installed
  they cost 44 MB of `node_modules`, read only when imported.

---

Enable AI agents to open a Snowglobe URL and use the Linux machine running inside that browser tab as a programmable workspace. Agents should be able to execute commands, read and write files, inspect results, cancel work, and save or restore progress through a documented interface accessible to browser automation tools.

The website delivers the runtime, filesystem and prepared machine snapshot as static assets. Computation happens inside the browser using Snowglobe’s WASM emulator, without requiring a native Snowglobe installation or an execution server. Access remains subject to browser permissions, resource limits and networking restrictions.

The implementation should add a **browser control layer over Snowglobe’s existing machine**, with a structured API and an accessible UI backed by the same operations.

The interfaces below are proposed additions. Snowglobe’s [existing agent tools](https://filipecabaco.github.io/snowglobe/docs/agents/) provide a useful model, but their documented implementation runs natively.

**1. Define a small, versioned control contract**

Expose one browser-side controller:

```ts
interface SnowglobeAgent {
  capabilities(): Promise<{
    protocolVersion: "1";
    buildId: string;
    sessionId: string;
    features: string[];
  }>;

  status(): Promise<{
    state: "loading" | "ready" | "busy" | "stopped" | "error";
  }>;

  runCommand(input: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeoutMs?: number;
    requestId: string;
  }): Promise<{ jobId: string }>;

  readJob(input: {
    jobId: string;
    cursor?: string;
    maxBytes?: number;
  }): Promise<{
    state: "queued" | "running" | "finished" | "cancelled" | "failed";
    stdout: string;
    stderr: string;
    nextCursor: string;
    exitCode: number | null;
    truncated: boolean;
  }>;

  cancelJob(jobId: string): Promise<void>;

  readFile(input: {
    path: string;
    offset?: number;
    maxBytes?: number;
    encoding: "utf8" | "base64";
  }): Promise<{ data: string; nextOffset: number; eof: boolean }>;

  writeFile(input: {
    path: string;
    data: string;
    encoding: "utf8" | "base64";
  }): Promise<void>;
}
```

Return JSON-serializable values. Keep binary assets and large outputs inside the browser; transfer them in bounded chunks when needed.

Make `requestId` idempotent within a session: retrying the same request must return the original job rather than execute the command twice. Reject reuse of an ID with different arguments.

**2. Add a dedicated guest control channel**

Avoid making shell-prompt recognition the execution protocol.

The intended structure is:

```mermaid
flowchart TD
    A["Agent browser tool"] --> B["Accessible control UI"]
    A --> C["Page API, when permitted"]
    B --> D["Browser controller"]
    C --> D
    D --> E["Emulator control channel"]
    E --> F["Guest command and file service"]
```

Inspect Snowglobe’s existing native command and file implementation first, then reuse the guest-side mechanisms where possible.

If the browser runtime does not expose a suitable channel, add a dedicated virtual serial device or equivalent emulator-supported transport. Keep it separate from the interactive terminal.

Use framed messages containing:

```ts
type Message = {
  version: 1;
  sessionId: string;
  requestId: string;
  operation: string;
  payload: unknown;
};
```

Use length-prefixed frames, bounded message sizes and explicit responses. File bytes and command output must not be mistaken for control messages.

The guest service should:

- Launch commands with explicit working directory and environment.
- Capture stdout and stderr separately.
- Report completion and exit status.
- Read and write files without interpolating their contents into shell commands.
- Track running jobs for cancellation.

A command runs inside the guest and can change that guest. Root-level guest code can interfere with the guest service, so its responses should not be treated as independently trustworthy security attestations.

**3. Keep job execution asynchronous**

`runCommand()` should return a job ID immediately. Browser automation then polls `readJob()`.

This avoids holding a browser tool call open while compilation, package installation or tests run.

For the first version:

- Allow one running job per machine.
- Bound retained output and report truncation explicitly.
- Apply a default timeout and a maximum permitted timeout.
- Preserve completed job results until reset or explicit removal.
- Reject commands until the machine is ready.

Enforce deadlines from the browser controller as well as inside the guest. First request graceful termination; if the guest stops responding, provide a hard stop that terminates the emulator worker or workers.

**A hard stop ends the whole machine.** Surface that distinction in the result instead of claiming that only one process was cancelled.

**4. Provide a browser-tool-compatible UI**

The UI should be a first-class adapter to the controller:

| Control | Purpose |
|---|---|
| Machine status | Show loading, ready, running and errors |
| Command textbox | Enter a shell command |
| Working-directory field | Set execution location |
| Run button | Submit a job |
| Job result panel | Show job ID, status, exit code and output |
| Cancel button | Stop the selected job |
| File editor | Read and write text files |
| Import/export controls | Transfer binary files |
| Save/reset controls | Manage machine state |

Use semantic HTML, accessible labels and ordinary text output, such as `<pre>` elements. Keep the graphical terminal for interactive use, but ensure an agent can complete the basic workflow without interpreting terminal screenshots.

Where a browser integration explicitly permits page API calls, expose the controller as:

```js
window.snowglobeAgent
```

Do not assume every browser integration permits arbitrary JavaScript calls. **The visible UI must support the core workflow independently.**

**5. Integrate persistence with existing saves**

Snowglobe already documents [whole-machine browser saves and backup files](https://filipecabaco.github.io/snowglobe/docs/saving/). Reuse that machinery.

For the first version:

- Support explicit save and restore through the control UI.
- Save only while no agent job is running.
- Associate saves with the site’s build identity.
- Generate a new session ID after restore or reset.
- Invalidate previous job handles after the session changes.

Saving only between jobs simplifies consistency: restoring a machine should not accidentally resume an old command while the controller believes the machine is idle.

**6. Preserve explicit resource and network boundaries**

Publish capabilities with the site so the agent can inspect what is available:

```json
{
  "protocolVersion": "1",
  "execution": "browser-wasm",
  "architecture": "arm64",
  "workspace": "/workspace",
  "maxConcurrentJobs": 1,
  "maxCommandTimeoutMs": 300000,
  "maxOutputBytes": 1048576,
  "network": {
    "mode": "fetch",
    "corsApplies": true
  }
}
```

These values should reflect the actual build and controller configuration.

Keep Snowglobe’s [existing networking model](https://filipecabaco.github.io/snowglobe/docs/networking/): networking must be enabled, browser CORS applies, and other TCP destinations require configured tunnels.

Do not place secrets in publicly served snapshots. If exposing cross-frame messaging later, validate both the sender window and its exact origin.

**7. Implement and verify in this order**

1. **Runtime bridge:** start a command inside the browser guest and retrieve structured output and exit status.
2. **Job lifecycle:** add polling, timeout, cancellation and duplicate-request handling.
3. **Files:** support text and binary round trips, with bounded transfers.
4. **Accessible UI:** expose those operations through labelled controls.
5. **Persistence:** connect save, restore and session invalidation.
6. **Browser automation test:** complete a real coding task through the UI.

The acceptance test should be concrete:

> An agent opens a published Snowglobe URL, waits for readiness, writes `/workspace/main.py`, runs it, reads its output and exit code, modifies the file, reruns it, and exports a generated artifact—all inside the browser, without invoking native Snowglobe or an execution backend.

Also test a timed-out command, a duplicated submission, excessive output, a binary file round trip, and restoration of a saved workspace.

**The first milestone is one complete browser-driven coding loop.** Once that works reliably, the same controller can support richer tool adapters without changing how the guest executes programs.
