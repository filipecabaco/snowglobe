// window.snowglobeAgent: commands run in this tab's machine, for an agent. Included only in a site
// built with --agent (or the label snowglobe.agent=true).
//
// A job runs on the guest's serial root shell (ttyS0), which every snowglobe guest has beside its
// app; the app's terminal (hvc0) is the only thing the page shows, so nothing a job prints or types
// reaches it. This is the native job protocol (internal/tools/runtime/src/job.rs), as its
// interactive jobs (`snowglobe sh`, run_command) have it: the command starts in the home directory,
// with its own scratch directory as $EXCLAVE_WORKSPACE. What differs, because a page can't reach
// into the guest's filesystem:
//  - the launcher and the command are typed in, base64 in short lines, each acknowledged before
//    the next (natively the host writes them as files);
//  - the command's output goes straight to the serial line, between a start line and the marker,
//    with the terminal's echo and newline translation off (natively it goes to a file the host
//    reads);
//  - it runs with NO_COLOR=1 and TERM=dumb, and what it reads back has escape sequences stripped,
//    as the output is shown on a page and read by an agent, never painted on a terminal.
// Then, as natively: `sh <launcher>` is typed; the launcher asks for a nonce, which the page types
// with its own time; the command runs in a session of its own; the launcher prints a marker line
// with the nonce and its status, and only that whole line ends the job. Out of time, or
// cancelled, the page types ctrl-c and the launcher kills the command's session, TERM then KILL.
//
// What this can't stop, as natively: a job runs as root in the guest, so it can read the nonce out
// of the launcher's memory and forge its own result. It can only forge its own: the page keeps the
// deadline, and a shell left busy holds up the next job rather than having it typed into it.
(function (root) {
  "use strict";

  const PROTOCOL = "1";
  const DEFAULT_TIMEOUT_S = 300;
  const MAX_TIMEOUT_S = 3600;
  // Output kept per job, in characters: the most recent, with the rest counted as dropped
  const MAX_OUTPUT = 1 << 20;
  // A job's command, in characters
  const MAX_COMMAND = 64 << 10;
  // Results kept for readJob; the oldest finished ones go first
  const MAX_JOBS = 50;
  // How long the guest gets to kill a job once told to, and the shell to answer a sync
  const KILL_GRACE_MS = 10000;
  const SYNC_WAIT_MS = 10000;
  // Typed lines stay well under the line editor's limit (1024 in Alpine's BusyBox)
  const CHUNK = 600;

  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

  function token() {
    const b = new Uint8Array(8);
    (root.crypto ?? globalThis.crypto).getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  }

  function base64Bytes(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }

  function base64(text) {
    return base64Bytes(new TextEncoder().encode(text));
  }

  // A job's files (its workspace's in/): short plain names
  const FILE_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/;
  // A job's files together, in bytes: they are typed in, as base64, line by line
  const MAX_FILES_BYTES = 4 << 20;

  /** The two scripts of a job in workspace `ws`: the launcher and the command with its environment.
   *  The command starts in the home directory, so relative paths mean what they do in the
   *  machine's terminal; `ws` stays the job's own scratch directory, as $EXCLAVE_WORKSPACE. */
  function scripts(id, ws, command) {
    // The app's environment: a login PATH, /etc/profile, the image's ENV
    const cmd =
      "export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/root\n" +
      "[ -f /etc/profile ] && . /etc/profile >/dev/null 2>&1\n" +
      "if [ -f /etc/snowglobe/env ]; then . /etc/snowglobe/env\n" +
      "elif [ -f /usr/local/bin/snowglobe-console ]; then eval \"$(grep '^export ' /usr/local/bin/snowglobe-console)\"; fi\n" +
      `export EXCLAVE_WORKSPACE=${quote(ws)}\n` +
      // Output for a page and an agent to read, not a terminal to paint: no colours, no cursor
      // movement (what still comes, as `ls --color=always` sends, is stripped from what jobs read)
      "export NO_COLOR=1 TERM=dumb\n" +
      "cd \"${HOME:-/root}\" 2>/dev/null || cd /\n" +
      command + "\n";
    // The trap first, as natively. The terminal stops echoing (the nonce isn't printed back) and
    // translating newlines (the output arrives as written) until the marker; the command's output
    // goes to the terminal, after a start line that carries the nonce
    const launcher = `k=0
trap 'k=1' INT TERM HUP
sgtty=$(stty -g 2>/dev/null)
stty -echo -opost 2>/dev/null
printf '\\nSGNONCE_%s\\n' ${id}
read -r n t
# Stopped before it began: nothing runs (the page, seeing no marker, checks the shell answers)
if [ "$k" = 1 ]; then [ -n "$sgtty" ] && stty "$sgtty" 2>/dev/null; exit 130; fi
[ -n "$t" ] && date -s "@$t" >/dev/null 2>&1
cd ${quote(ws)} || exit 1
sg_procs() {
  for p in /proc/[0-9]*; do
    read -r st 2>/dev/null <"$p/stat" || continue
    set -- \${st##*") "}
    if [ "\${p#/proc/}" != "$$" ] && { [ "$3" = "$pg" ] || [ "$4" = "$pg" ]; }; then echo "\${p#/proc/}"; fi
  done
}
sg_kill() {
  kill -"$1" -"$pg" 2>/dev/null
  for q in $(sg_procs); do kill -"$1" "$q" 2>/dev/null; done
}
sg_alive() {
  kill -0 -"$pg" 2>/dev/null || [ -n "$(sg_procs)" ]
}
printf 'SGOUT_%s_%s\\n' ${id} "$n"
if command -v setsid >/dev/null 2>&1; then
  setsid sh .sg/cmd </dev/null 2>&1 &
else
  set -m; sh .sg/cmd </dev/null 2>&1 & set +m
fi
pg=$!
wait "$pg"; s=$?
if [ "$k" = 1 ]; then
  sg_kill TERM
  i=0
  while [ "$i" -lt 30 ] && sg_alive; do
    if sleep 0.1 2>/dev/null; then i=$((i+1)); else sleep 1; i=$((i+10)); fi
  done
  sg_kill KILL
  wait "$pg"; s=$?
fi
sync
printf '\\nSGDONE_%s_%s_%s_%s\\n' ${id} "$n" "$s" "$k"
[ -n "$sgtty" ] && stty "$sgtty" 2>/dev/null
`;
    return { launcher, cmd };
  }

  /** The lines typed into the serial shell to put a job's two scripts in its workspace, and its
   *  files (name: Uint8Array) in its in/, as the native protocol's files are. Each line ends by
   *  printing an acknowledgement the shell computes (its echo can't contain it). */
  function uploadLines(ws, launcher, cmd, ack, files = {}) {
    const names = Object.keys(files);
    const lines = [`mkdir -p ${ws}/.sg ${ws}/in ${ws}/out && : >${ws}/.sg/job.b64 && : >${ws}/.sg/cmd.b64` +
      names.map((n) => ` && : >${ws}/in/${n}.b64`).join("")];
    const parts = [["job.b64", base64(launcher), ".sg"], ["cmd.b64", base64(cmd), ".sg"],
      ...names.map((n) => [`${n}.b64`, base64Bytes(files[n]), "in"])];
    for (const [file, b, dir] of parts) {
      for (let i = 0; i < b.length; i += CHUNK) lines.push(`printf %s ${b.slice(i, i + CHUNK)} >>${ws}/${dir}/${file}`);
    }
    lines.push(`base64 -d ${ws}/.sg/job.b64 >${ws}/.sg/job.sh && base64 -d ${ws}/.sg/cmd.b64 >${ws}/.sg/cmd` +
      names.map((n) => ` && base64 -d ${ws}/in/${n}.b64 >${ws}/in/${n} && rm ${ws}/in/${n}.b64`).join(""));
    return lines.map((line, i) => `${line}; echo SGACK_${ack}_${i}_$?_$((6*7))\n`);
  }

  /** A job's files, checked: { name: Uint8Array }, plain names, MAX_FILES_BYTES in all. */
  function checkFiles(files) {
    if (files === undefined || files === null) return {};
    if (typeof files !== "object") throw new Error("files: { name: bytes }");
    let total = 0;
    const out = {};
    for (const [name, bytes] of Object.entries(files)) {
      if (!FILE_NAME.test(name)) throw new Error(`files: ${JSON.stringify(name)} is not a plain file name`);
      if (!(bytes instanceof Uint8Array)) throw new Error(`files: ${name} is not a Uint8Array`);
      total += bytes.length;
      out[name] = bytes;
    }
    if (total > MAX_FILES_BYTES) throw new Error(`files: at most ${MAX_FILES_BYTES} bytes in all`);
    return out;
  }

  /** The launcher's marker: its status and whether it killed the command. Only a whole line
   *  `SGDONE_<id>_<nonce>_<status>_<0|1>`, after a newline, counts. `from` is where to look. */
  function parseMarker(text, id, nonce, from = 0) {
    const prefix = `\nSGDONE_${id}_${nonce}_`;
    for (let at = text.indexOf(prefix, from); at !== -1; at = text.indexOf(prefix, at + 1)) {
      const end = text.indexOf("\n", at + prefix.length);
      if (end === -1) return null; // not a whole line yet
      const m = /^(-?\d+)_([01])\r?$/.exec(text.slice(at + prefix.length, end));
      if (m) return { status: Number(m[1]), killed: m[2] === "1", at, end: end + 1 };
    }
    return null;
  }

  /** A whole line in `text` that is exactly `line` (a carriage return allowed). */
  function hasLine(text, line) {
    for (let at = text.indexOf(line); at !== -1; at = text.indexOf(line, at + 1)) {
      if (at > 0 && text[at - 1] !== "\n") continue;
      const rest = text.slice(at + line.length, at + line.length + 2);
      if (rest.startsWith("\n") || rest === "\r\n") return true;
    }
    return false;
  }

  // Terminal escape sequences, 7- and 8-bit: CSI (colours, cursor movement), OSC (titles,
  // hyperlinks; ended by BEL or ST, or taken as ended at a newline when it never is), the
  // DCS/SOS/PM/APC strings, charset designations and the two-character ones (ESC =, ESC 7,
  // ESC M...). Then one cut short at the end of the text so far, held back until it is whole
  const ESCAPES = new RegExp([
    "(?:\\x1b\\[|\\x9b)[\\x30-\\x3f]*[\\x20-\\x2f]*[\\x40-\\x7e]",
    "(?:\\x1b\\]|\\x9d)[^\\x07\\x1b\\x9c\\n]*(?:\\x07|\\x1b\\\\|\\x9c|(?=\\n))",
    "(?:\\x1b[PX^_]|[\\x90\\x98\\x9e\\x9f])[^\\x1b\\x9c]*(?:\\x1b\\\\|\\x9c)",
    "\\x1b[\\x20-\\x2f]+[\\x30-\\x7e]",
    "\\x1b(?![[\\]PX^_])[\\x30-\\x7e]",
  ].join("|"), "g");
  const CUT_SHORT = /(?:(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*|(?:\x1b[\]PX^_]|[\x9d\x90\x98\x9e\x9f])[^\x07\x1b\x9c\n]*\x1b?|\x1b[\x20-\x2f]*)$/;

  /** `text` without terminal escape sequences: what a person reads off the screen, less colour. */
  function plain(text) {
    if (!/[\x1b\x90-\x9f]/.test(text)) return text;
    return text.replace(ESCAPES, "").replace(CUT_SHORT, "");
  }

  /** A job's seconds: a number, 0 to MAX_TIMEOUT_S (default DEFAULT_TIMEOUT_S). */
  function timeoutSeconds(v) {
    if (v === undefined || v === null) return DEFAULT_TIMEOUT_S;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new Error("timeoutSeconds: a number of seconds, 0 or more");
    return Math.min(v, MAX_TIMEOUT_S);
  }

  /**
   * One job, as a state machine fed what the serial line prints (`feed`) and the time (`tick`);
   * both return what to type next, if anything. Phases: sync (the shell answers), upload (the
   * scripts typed in), launch (waiting for the launcher to ask for its nonce), running, killing
   * (ctrl-c typed), check (no marker after the kill: does the shell answer?), done.
   */
  class Job {
    constructor({ id, nonce, ack, command, timeoutS, now, clock, maxOutput = MAX_OUTPUT, files, window = 1 }) {
      this.id = id;
      this.nonce = nonce;
      this.ack = ack;
      this.command = command;
      this.timeoutS = timeoutS;
      this.ws = `/sgjob/${id}`;
      this.clock = clock ?? (() => Math.floor(Date.now() / 1000));
      this.maxOutput = maxOutput;
      const { launcher, cmd } = scripts(id, this.ws, command);
      this.lines = uploadLines(this.ws, launcher, cmd, ack, files);
      // Upload lines typed ahead of their acknowledgement: 1 types each after the one before is
      // acknowledged. More keeps the line busier, but what is typed ahead waits in the guest's
      // terminal buffer (4 KiB), so a few at most
      this.window = Math.max(1, Math.min(4, window | 0));
      this.next = 0; // the next line whose acknowledgement is awaited
      this.sent = 0; // lines typed
      this.startedAt = now;
      this.endedAt = null;
      this.state = "running"; // running, exited, timed_out, cancelled, failed
      this.exitStatus = null;
      this.killed = false;
      this.error = null;
      this.scan = ""; // printed since the current step began
      this.out = ""; // the command's output (the most recent maxOutput characters)
      this.dropped = 0;
      this.outFrom = 0;
      this.stopReason = null; // "timeout" or "cancel"
      this.shellBusy = false; // set when the job ends with the shell maybe still busy
      this.phase = "sync";
      this.deadline = now + SYNC_WAIT_MS;
      this.syncTok = token();
    }

    /** What to type to start. */
    start() {
      return `echo SGSYNC_${this.syncTok}_$((6*7))\n`;
    }

    _step(phase, deadline) {
      this.phase = phase;
      this.deadline = deadline;
      this.scan = "";
    }

    _end(state, now, extra = {}) {
      Object.assign(this, extra);
      this.state = state;
      this.phase = "done";
      this.endedAt = now;
      this.deadline = Infinity;
      this.scan = "";
    }

    _fail(message, now, shellBusy) {
      this._end("failed", now, { error: message, shellBusy });
    }

    _append(text) {
      this.out += text;
      if (this.out.length > this.maxOutput + 4096) {
        // Keep enough at the end to find the marker in
        const cut = this.out.length - this.maxOutput;
        // The first cut takes the newline that stands for the start (not output) with it
        this.dropped += this.dropped === 0 ? cut - 1 : cut;
        this.out = this.out.slice(cut);
        this.outFrom = Math.max(0, this.outFrom - cut);
      }
    }

    feed(text, now) {
      if (this.phase === "done") return [];
      if ((this.phase === "running" || this.phase === "killing") && this.started) return this._output(text, now);
      this.scan += text;
      if (this.scan.length > 65536) this.scan = this.scan.slice(-32768);
      switch (this.phase) {
        case "sync":
        case "check":
          if (this.scan.includes(`SGSYNC_${this.syncTok}_42`)) {
            if (this.phase === "check") {
              this._end(this.stopReason === "cancel" ? "cancelled" : "timed_out", now);
              return [];
            }
            this._step("upload", now + SYNC_WAIT_MS);
            this.sent = Math.min(this.window, this.lines.length);
            return this.lines.slice(0, this.sent);
          }
          return [];
        case "upload": {
          const out = [];
          // Acknowledgements come in order; several may have arrived together
          for (;;) {
            const m = new RegExp(`SGACK_${this.ack}_${this.next}_(\\d+)_42`).exec(this.scan);
            if (!m) return out;
            if (m[1] !== "0") {
              this._fail(`the job could not be written into the guest (step ${this.next}, status ${m[1]})`, now, false);
              return [];
            }
            this.next++;
            this.scan = this.scan.slice(m.index + m[0].length);
            this.deadline = now + SYNC_WAIT_MS;
            if (this.next >= this.lines.length) {
              this._step("launch", this.startedAt + this.timeoutS * 1000);
              out.push(`sh ${this.ws}/.sg/job.sh\n`);
              return out;
            }
            if (this.sent < this.lines.length) out.push(this.lines[this.sent++]);
          }
        }
        case "launch":
          if (hasLine(this.scan, `SGNONCE_${this.id}`)) {
            this.phase = "running";
            this.asked = true;
            this.scan = "";
            return [`${this.nonce} ${this.clock()}\n`];
          }
          return [];
        case "running":
        case "killing": {
          // Killed while it waited for its nonce: it gets one, to see it was stopped and leave
          if (!this.asked && hasLine(this.scan, `SGNONCE_${this.id}`)) {
            this.asked = true;
            return [`${this.nonce} ${this.clock()}\n`];
          }
          const m = new RegExp(`(^|\n)SGOUT_${this.id}_${this.nonce}\r?\n`).exec(this.scan);
          if (!m) return [];
          this.started = true;
          const rest = this.scan.slice(m.index + m[0].length);
          this.scan = "";
          // The output begins just after the start line; the marker is preceded by a newline the
          // launcher prints, which `\n` + output stands for
          this.out = "\n";
          this.outFrom = 0;
          return this._output(rest, now);
        }
      }
      return [];
    }

    _output(text, now) {
      this._append(text);
      const m = parseMarker(this.out, this.id, this.nonce, this.outFrom);
      if (!m) {
        // Look again only where a marker could have begun
        this.outFrom = Math.max(0, this.out.length - (this.id.length + this.nonce.length + 40));
        return [];
      }
      this.out = this.out.slice(0, m.at);
      if (m.killed) {
        this._end(this.stopReason === "cancel" ? "cancelled" : "timed_out", now, { killed: true });
      } else {
        // It ended by itself (a ctrl-c sent just after went to the shell's prompt)
        this._end("exited", now, { exitStatus: m.status });
      }
      return [];
    }

    /** Ask the guest to stop it: why is "timeout" or "cancel". */
    stop(why, now) {
      if (this.phase === "done" || this.stopReason) return [];
      this.stopReason = why;
      if (this.phase === "sync" || this.phase === "upload") {
        // Nothing has started: no need to touch the shell (an upload line already typed finishes
        // by itself; its files are left unused)
        this._end(why === "cancel" ? "cancelled" : "timed_out", now);
        return [];
      }
      this.phase = "killing";
      this.deadline = now + KILL_GRACE_MS;
      return ["\x03"];
    }

    tick(now) {
      if (this.phase === "done" || now < this.deadline) return [];
      switch (this.phase) {
        case "sync":
          this._fail("the guest's shell is not answering", now, true);
          return [];
        case "upload":
          this._fail("the guest's shell stopped answering while the job was written", now, true);
          return [];
        case "launch":
        case "running":
          return this.stop("timeout", now);
        case "killing":
          // No marker even after the ctrl-c: does the shell answer?
          this.syncTok = token();
          this._step("check", now + SYNC_WAIT_MS);
          return [this.start()];
        case "check":
          this._end(this.stopReason === "cancel" ? "cancelled" : "timed_out", now, { shellBusy: true });
          return [];
      }
      return [];
    }

    /** The output so far, without a marker line that may be on its way. */
    output() {
      let out = this.dropped === 0 ? this.out.slice(1) : this.out;
      if (this.phase !== "done") {
        const nl = out.lastIndexOf("\n");
        const tail = out.slice(nl + 1);
        const prefix = `SGDONE_${this.id}_${this.nonce}_`;
        if (tail && (prefix.startsWith(tail) || tail.startsWith(prefix))) out = out.slice(0, Math.max(0, nl));
      }
      // At most maxOutput: the most recent
      const over = Math.max(0, out.length - this.maxOutput);
      return { text: out.slice(over), dropped: this.dropped + over };
    }

    view() {
      const out = this.output();
      return {
        jobId: this.id,
        command: this.command,
        state: this.state,
        exitStatus: this.exitStatus,
        killed: this.killed,
        error: this.error,
        // Escape sequences stripped (colours, cursor movement): the text, as a page shows it and an
        // agent reads it. droppedChars counts what was dropped as printed
        output: plain(out.text),
        truncated: out.dropped > 0,
        droppedChars: out.dropped,
        startedAt: this.startedAt,
        endedAt: this.endedAt,
        timeoutSeconds: this.timeoutS,
      };
    }
  }

  /** The text a finished (or running) job reads as, as `snowglobe mcp`'s run_command has it. */
  function jobText(v) {
    let out = v.output;
    if (v.truncated) out = `[${v.droppedChars} earlier characters of output dropped]\n` + out;
    switch (v.state) {
      case "running":
        return `${out}${out && !out.endsWith("\n") ? "\n" : ""}[running]`;
      case "exited":
        return `${out.replace(/\n+$/, "")}\n[exit ${v.exitStatus}]`;
      case "timed_out":
      case "cancelled": {
        let how = v.state === "timed_out" ? "timed out" : "stopped";
        if (v.killed) how += "; everything it started was killed";
        return `${out}\n[${how}]`;
      }
      default:
        return `${out}${out ? "\n" : ""}[failed: ${v.error}]`;
    }
  }

  /**
   * The controller over a page's machine. `machine` is { emulator, cpus, network, buildId,
   * version, state(): "loading" | "ready" | "error" | "stopped", saving(): boolean }.
   */
  class Controller {
    constructor(machine, { now = () => Date.now(), timers = root } = {}) {
      this.m = machine;
      this.now = now;
      this.timers = timers;
      this.jobs = new Map();
      this.requests = new Map();
      this.current = null;
      this.shellBusy = false;
      this.decoder = new TextDecoder();
      this.sessionId = token();
      this.webmcp = { available: false, registered: [], reason: "not attempted" };
      this.finishedListeners = [];
      if (machine.emulator) this.bind(machine.emulator);
    }

    /** Listen to an emulator: the page's first, and each one a wake makes. */
    bind(emulator) {
      if (!emulator || !this.supported()) return;
      this.decoder = new TextDecoder();
      emulator.on("serial", (bytes) => {
        if (emulator === this.m.emulator) this._serial(bytes);
      });
      emulator.on("stop", () => {
        const job = this.current;
        if (emulator === this.m.emulator && job && job.phase !== "done") {
          job._fail("the machine stopped", this.now(), true);
          this._finished();
        }
      });
    }

    supported() {
      return this.m.cpus === 1;
    }

    _unsupportedReason() {
      return `agent jobs need a one-CPU site; this one has ${this.m.cpus} CPUs`;
    }

    capabilities() {
      return {
        protocolVersion: PROTOCOL,
        snowglobeVersion: this.m.version || "",
        buildId: this.m.buildId || "",
        sessionId: this.sessionId,
        execution: "browser-wasm",
        architecture: "arm64",
        cpus: this.m.cpus,
        network: this.m.network === "fetch" ? { mode: "fetch", corsApplies: true } : { mode: "none" },
        supported: this.supported(),
        reason: this.supported() ? null : this._unsupportedReason(),
        maxConcurrentJobs: 1,
        defaultTimeoutSeconds: DEFAULT_TIMEOUT_S,
        maxTimeoutSeconds: MAX_TIMEOUT_S,
        maxOutputChars: MAX_OUTPUT,
        maxCommandChars: MAX_COMMAND,
        features: this.supported() ? ["runCommand", "readJob", "cancelJob", ...(this.m.lifecycle ? ["suspend"] : [])] : [],
        notYet: ["readFile", "writeFile", "cwd", "env", "separate stderr"],
        workingDirectory: "home",
        machine: this.m.lifecycle?.describe() ?? null,
        webmcp: this.webmcp,
      };
    }

    status() {
      if (!this.supported()) return { state: "failed", reason: this._unsupportedReason() };
      const s = this.m.state();
      if (s === "error" || s === "stopped") return { state: "failed", reason: `the machine is ${s === "error" ? "in error" : "stopped"}` };
      // Put away to free memory: the next command wakes it first
      if (s === "suspended" || s === "suspending" || s === "waking") {
        const d = this.m.lifecycle?.describe();
        const r = { state: s, wakeSeconds: d?.wakeSeconds ?? null, note: s === "waking" ? "waking from its saved state" : "the next command wakes it first" };
        if (d?.lastWakeError) r.lastWakeError = d.lastWakeError;
        return r;
      }
      if (s !== "ready") return { state: "booting" };
      if (this.m.saving?.()) return { state: "saving" };
      if (this.current) return { state: "busy", jobId: this.current.id };
      // The last job's command may still hold the serial shell: the next job asks it first
      if (this.shellBusy) return { state: "ready", note: "the last job may have left the guest's shell busy; the next job fails if it doesn't answer" };
      return { state: "ready" };
    }

    /** A runCommand input, checked: { command, timeoutS, requestId, repeat } (repeat: the job a
     *  retry with the same requestId returns). Throws on a bad one. */
    parse(input) {
      if (!input || typeof input !== "object") throw new Error("runCommand: { command, timeoutSeconds?, requestId? }");
      const { command, requestId } = input;
      if (typeof command !== "string" || !command.trim()) throw new Error("command: a non-empty string");
      if (command.length > MAX_COMMAND) throw new Error(`command: at most ${MAX_COMMAND} characters`);
      if (command.includes("\0")) throw new Error("command: no NUL characters");
      const timeoutS = timeoutSeconds(input.timeoutSeconds);
      if (requestId !== undefined && (typeof requestId !== "string" || !/^[\w.:-]{1,128}$/.test(requestId))) {
        throw new Error("requestId: 1 to 128 letters, digits, or _ . : -");
      }
      let repeat = null;
      if (requestId !== undefined && this.requests.has(requestId)) {
        const seen = this.requests.get(requestId);
        if (seen.command !== command || seen.timeoutS !== timeoutS) throw new Error(`requestId ${requestId} was used for a different command`);
        if (this.jobs.has(seen.jobId)) repeat = seen.jobId;
      }
      const files = checkFiles(input.files);
      return { command, timeoutS, requestId, repeat, files };
    }

    /** Start a command; its job id comes back at once. `files` ({ name: Uint8Array }) are put in
     *  its workspace's in/ first ($EXCLAVE_WORKSPACE/in/name). */
    runCommand(input) {
      const { command, timeoutS, requestId, repeat, files } = this.parse(input);
      if (repeat) return { jobId: repeat, repeated: true };
      const st = this.status();
      if (st.state === "busy") throw new Error(`busy: job ${st.jobId} is running; one job at a time (cancel it, or wait)`);
      if (st.state !== "ready") throw new Error(`not ready: the machine is ${st.state}${st.reason ? ` (${st.reason})` : ""}`);

      const now = this.now();
      const job = new Job({ id: token(), nonce: token(), ack: token(), command, timeoutS, now, files,
        window: input.uploadWindow ?? this.uploadWindow ?? 1 });
      this._keep(job);
      if (requestId !== undefined) this.requests.set(requestId, { jobId: job.id, command, timeoutS });
      this.current = job;
      this._type([job.start()]);
      this._schedule();
      return { jobId: job.id };
    }

    readJob(input) {
      const id = typeof input === "string" ? input : input?.jobId;
      const job = this.jobs.get(id);
      if (!job) throw new Error(`no job ${id}`);
      return job.view();
    }

    cancelJob(input) {
      const id = typeof input === "string" ? input : input?.jobId;
      const job = this.jobs.get(id);
      if (!job) throw new Error(`no job ${id}`);
      if (job.phase === "done") return job.view();
      this._type(job.stop("cancel", this.now()));
      if (job.phase === "done") this._finished();
      return job.view();
    }

    _keep(job) {
      this.jobs.set(job.id, job);
      for (const [id, j] of this.jobs) {
        if (this.jobs.size <= MAX_JOBS) break;
        if (j.phase === "done") this.jobs.delete(id);
      }
    }

    _type(lines) {
      for (const line of lines) this.m.emulator.serial_input(line);
    }

    _serial(bytes) {
      const text = this.decoder.decode(bytes, { stream: true });
      const job = this.current;
      if (!job) return;
      this._type(job.feed(text, this.now()));
      if (job.phase === "done") this._finished();
    }

    _schedule() {
      if (this.timer) return;
      this.timer = this.timers.setInterval(() => {
        const job = this.current;
        if (!job) return;
        this._type(job.tick(this.now()));
        if (job.phase === "done") this._finished();
      }, 200);
    }

    _finished() {
      const job = this.current;
      this.current = null;
      if (job) this.shellBusy = job.shellBusy;
      if (this.timer) {
        this.timers.clearInterval(this.timer);
        this.timer = null;
      }
      this.onchange?.(job);
      // A copy: a listener may remove itself
      for (const fn of [...this.finishedListeners]) fn(job);
    }
  }

  /**
   * The controller for a machine, as window.snowglobeAgent. With `machine.lifecycle` (a
   * SnowglobeMachine.Machine), a command wakes a suspended machine first, and the API can
   * suspend it. Each machine gets its own, so a page of several can keep only some awake.
   */
  function attach(machine, opts) {
    const c = new Controller(machine, opts);
    const life = machine.lifecycle;
    // A finished job is activity: the idle clock starts again from its end
    if (life) c.finishedListeners.push(() => life.touch());
    const asleep = () => ["suspended", "suspending", "waking"].includes(life?.state);
    const api = {
      capabilities: async () => c.capabilities(),
      status: async () => c.status(),
      runCommand: async (input) => {
        // A bad command is refused without waking anything; a retry of a job returns it as is
        if (!c.parse(input).repeat && asleep()) await life.wake();
        const r = c.runCommand(input);
        life?.touch();
        return r;
      },
      readJob: async (input) => c.readJob(input),
      cancelJob: async (input) => c.cancelJob(input),
      // Free the machine's memory now (never while a job runs); the next command wakes it
      suspend: async () => (life ? life.suspend("asked") : false),
      wake: async () => life?.wake(),
    };
    Object.defineProperty(api, "_controller", { value: c });
    return api;
  }

  const SnowglobeAgent = { attach, Controller, Job, scripts, uploadLines, checkFiles, parseMarker, hasLine, jobText, timeoutSeconds, plain,
    base64Bytes, quote, token,
    limits: { DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S, MAX_OUTPUT, MAX_COMMAND, MAX_FILES_BYTES, KILL_GRACE_MS, SYNC_WAIT_MS } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeAgent;
  else root.SnowglobeAgent = SnowglobeAgent;
})(typeof window !== "undefined" ? window : globalThis);
