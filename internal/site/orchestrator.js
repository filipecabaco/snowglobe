// The agent page (/agent/): every agent runtime of the site in one page, and what coordinates
// them. It reads runtimes.json (written when the site is assembled: snowglobe
// agent-pages), and then, all in the browser:
//  - makes each machine lazily, on its first use, each in a Web Worker of its own;
//  - keeps a few awake at once (scheduler.js: 2 unless changed for this page load), suspending the
//    least recently used idle one, one capture or boot at a time, never one that is busy;
//  - saves each machine's state when it is suspended, in IndexedDB under a scope of its own
//    (/agent/<runtime>): what a suspended machine has is kept across a reload, but what an awake one
//    did since its last suspend is not (the page warns before it unloads, `unsaved()`);
//  - runs commands in any machine, and copies files between machines (transfer.js), one operation
//    at a time in each machine, in the order asked;
//  - offers all of it as one form for agents that click and type, as window.snowglobeAgent, and as
//    one set of WebMCP tools; asking the person at the page once, before anything runs;
//  - shows a machine's web server in the page (preview.js): an open preview keeps its machine, and
//    every machine its page reaches through the preview, awake (busy) until it is closed.
// A machine on several CPUs needs the page cross-origin isolated (its service worker makes it one);
// where it isn't, that machine is refused with the reason, and the others run as ever.
// A machine that fails (its worker crashed, it powered off, a capture hung) is ended at once: its
// worker terminated, its job finished as failed, nothing left holding its memory.
// Nothing runs because of the address: ?runtime=<name> only preselects a machine.
(function (root) {
  "use strict";

  const S = () => root.SnowglobeSessions;
  const MAX_TAPE = 256 << 10; // console output kept per machine, for its terminal
  const SAVE_ID = "machine";
  // How long the preview (a request through it, or open_preview) waits for an awake slot when
  // every awake machine is busy with something other than the preview, before it gives up
  const PREVIEW_WAIT_MS = 30000;

  /** One machine's save: one checkpoint in IndexedDB, in a scope of its own, held by one tab. */
  class SaveSlot {
    constructor(scope, config, name) {
      this.scope = scope;
      this.config = config;
      this.name = name;
      this.store = null;
      this.error = null;
      this.opened = null;
      this.saved = null; // the save's metadata, if there is one
    }

    /** The store, opened once; one that failed to open (another tab holds its lock, say) is tried
     *  again the next time it is needed: at the next suspend. */
    open() {
      this.opened ??= (async () => {
        try {
          this.release ??= await S().acquireLock(this.scope);
          this.store = await S().BrowserStore.open(this.scope);
          const list = await this.store.list();
          this.saved = list.find((c) => c.id === SAVE_ID && S().compatible(c, this.config)) ?? null;
          this.error = null;
        } catch (e) {
          this.store = null;
          this.error = String(e?.message ?? e);
          this.opened = null;
        }
      })();
      return this.opened;
    }

    async load() {
      await this.open();
      if (!this.store || !this.saved) return null;
      const c = await this.store.get(SAVE_ID);
      return c && S().compatible(c, this.config) ? c : null;
    }

    async save(packed) {
      await this.open();
      if (!this.store) throw new Error(this.error ?? "no storage");
      const c = { version: 1, id: SAVE_ID, name: this.name, config: this.config, savedAt: Date.now(),
        encoding: packed.encoding, state: packed.state, console: new Blob([]) };
      await this.store.put(c);
      this.saved = S().metadata(c);
    }

    async clear() {
      await this.open();
      if (this.store) await this.store.remove(SAVE_ID);
      this.saved = null;
    }
  }

  const notAsked = async () => { throw new Error("the person at the page did not allow it"); };

  /**
   * The page's machines and what can be done with them: the API window.snowglobeAgent is.
   * `manifest` is runtimes.json; `pageUrl` the page's address (URLs in it resolve against it).
   * `ask(options)` is the page's consent: every run and copy goes through it, whoever asks (it
   * asks the person once per page load). `confirmFresh(m)` asks before a start fresh.
   * `onactivity(event)` hears every run and copy, whoever started it: { kind: "run", runtime,
   * command, jobId, source }, { kind: "job", jobId, runtime } (a job ended), { kind: "copy", id,
   * from, to, source, state, result | error }, { kind: "preview", preview | null, source } (the
   * preview opened, or closed). `isolated`: the page is cross-origin isolated (machines on several
   * CPUs need it); crossOriginIsolated when not given. `granted()`: the person has allowed it in
   * this page load (preview requests are answered only then; ask.granted when not given).
   */
  function createAgents(manifest, { pageUrl, scheduler, Machine, createMachine, ask = notAsked, confirmFresh, onchange, onactivity, now = () => Date.now(),
    transport = "worker", hidden = false, machineOptions = {}, hostOptions = {}, isolated = root.crossOriginIsolated === true,
    granted = () => !!ask.granted?.(), preview: Preview = root.SnowglobePreview } = {}) {
    const page = new URL("./", pageUrl);
    const abs = (u) => new URL(u, page).href;
    const scripts = {
      worker: abs("machine-worker.js"),
      core: [abs(manifest.armless.js), abs("sessions.js"), abs("agent.js"), abs("transfer.js"), abs("machine-core.js")],
    };
    const changed = () => { try { onchange?.(); } catch {} };
    const tell = (event) => { try { onactivity?.(event); } catch {} };
    const jobs = new Map(); // job id: { machine, final view once it ended }
    const requests = new Map(); // request id: { runtime, command, jobId }
    const copies = new Map(); // copy id: AbortController
    let copyN = 0;
    const down = (n) => Math.max(0, n - 1); // a count that a failure may already have reset
    // Upload lines typed ahead: 4 doubles how fast files go in (measured: 7 to 15 KiB/s), and
    // 4 lines stay under the guest terminal's 4 KiB buffer
    const state = { transport, uploadWindow: 4, preview: null };

    const machines = manifest.runtimes.map((r) => {
      const base = abs(r.base);
      // CPUs per machine, as its site has them (several need the page cross-origin isolated)
      const cpus = r.cpus ?? 1;
      const config = { build: r.build_id, memory: r.memory_mb, cpus, network: r.network === "fetch" ? "fetch" : "none" };
      const m = {
        name: r.name, title: r.title, purpose: r.purpose, sample: r.sample, base, cpus, network: r.network === "fetch",
        slot: new SaveSlot(new URL(r.name, page).pathname, config, r.title),
        host: null, job: null, xfers: 0, starting: 0, lastUsed: 0, tape: [], tapeBytes: 0,
        loading: null, memoryBytes: 0, inMemory: null, discard: false, error: null,
        // Changed since its last save (a run, a copy into it, a key in its terminal): a reload loses it
        dirty: false,
        // The blob store its files come from, when it can't be reached: what the page says
        blobsDown: null,
        // Its operations (a run's start, a copy's half), one at a time, in the order asked
        ops: Promise.resolve(),
        // Its ports the preview shows (open) or the previewed page reaches (linked): while there
        // are any, it is busy, so never suspended
        previews: new Map(),
        // Preview requests under way, by port: a port is let go only once the last one is over
        inflight: new Map(),
        busy() { return !!this.job || this.xfers > 0 || this.starting > 0 || this.previews.size > 0; },
        // Held by the preview: the scheduler counts the preview's machines as one
        previewHeld() { return this.previews.size > 0; },
      };
      m.armless = {
        name: r.name,
        wasm: manifest.armless.wasm ? abs(manifest.armless.wasm) : undefined,
        wasm_smp: manifest.armless.wasm_smp ? abs(manifest.armless.wasm_smp) : undefined,
        memory_mb: r.memory_mb, cpus,
        filesystem: { json: "system/filesystem.json", baseurl: r.baseurl ?? "system/filesystem/" },
        initial_state: "system/state.bin.zst",
        warm: "system/warm.pack",
        ...(r.network === "fetch" ? { network: { tls: "system/tls.json" } } : {}),
      };
      m.lifecycle = new Machine({
        busy: () => m.busy(),
        suspend: () => suspendIt(m),
        wake: () => wakeIt(m),
        requestSuspend: (reason) => scheduler.suspend(m, reason),
        onchange: (state) => {
          // However it failed (a crash, a stop, a hung capture, wakes that kept failing): nothing of
          // it is left running
          if (state === "failed") ended(m, m.lifecycle.error);
          changed();
        },
      }, { ...machineOptions, state: "suspended" });
      m.lifecycle.setHidden(hidden);
      scheduler.add(m);
      return m;
    });
    const byName = new Map(machines.map((m) => [m.name, m]));

    function get(runtime) {
      const m = byName.get(runtime);
      if (!m) throw new Error(`no runtime ${JSON.stringify(runtime)}; these are: ${machines.map((x) => x.name).join(", ")}`);
      return m;
    }

    function record(m, bytes) {
      m.tape.push(bytes);
      m.tapeBytes += bytes.length;
      while (m.tapeBytes > MAX_TAPE && m.tape.length > 1) m.tapeBytes -= m.tape.shift().length;
      m.onConsole?.(bytes);
    }

    // A machine's host, made at each wake (and its worker with it), ended at each suspend
    function makeHost(m) {
      const host = createMachine({ base: m.base, config: m.armless, transport: state.transport, scripts, uploadWindow: state.uploadWindow, ...hostOptions });
      host.on("console", (bytes) => { if (m.host === host) record(m, bytes); });
      host.on("progress", (e) => {
        if (m.host === host && /state\.bin/.test(e.file) && e.total) {
          m.loading = Math.round((e.loaded / e.total) * 100);
          changed();
        }
      });
      host.on("job", async ({ jobId }) => {
        if (m.host !== host) return;
        if (m.job === jobId) m.job = null;
        const j = jobs.get(jobId);
        if (j) try { j.final = await host.readJob(jobId); } catch {}
        m.lastUsed = now();
        m.lifecycle.touch();
        scheduler.notify();
        changed();
        if (j) tell({ kind: "job", jobId, runtime: m.name });
      });
      host.on("stop", ({ reason }) => {
        // A capture stops it too; only a machine that stops by itself (powered off) has failed
        if (m.host !== host || m.lifecycle.state !== "running") return;
        m.lifecycle.failed(new Error(`the machine stopped (${reason})`));
      });
      host.on("error", (e) => {
        if (m.host !== host) return;
        m.error = e.message;
        // Its worker crashed: the machine is gone, whatever it was doing
        if (e.fatal && (m.lifecycle.state === "running" || m.lifecycle.state === "suspending")) m.lifecycle.failed(new Error(e.message));
        changed();
      });
      host.on("blobs", (e) => {
        if (m.host !== host) return;
        m.blobsDown = e.ok ? null : { url: e.url, message: e.message };
        changed();
      });
      return host;
    }

    /** A machine that failed: its host ended (the worker terminated, even one that doesn't
     *  answer), and what was under way in it finished as failed. */
    function ended(m, error) {
      const host = m.host;
      m.host = null;
      if (host) host.destroy().catch(() => {});
      const why = `the machine failed: ${String(error?.message ?? error ?? "it stopped")}`;
      if (m.job) {
        const j = jobs.get(m.job);
        if (j && !j.final) j.final = { jobId: m.job, state: "failed", exitStatus: null, error: why, output: j.lastOutput ?? "" };
        const jobId = m.job;
        m.job = null;
        tell({ kind: "job", jobId, runtime: m.name });
      }
      m.xfers = 0;
      m.starting = 0;
      m.memoryBytes = 0;
      m.loading = null;
      m.dirty = false; // nothing left to lose
      // A preview of it is over (the page shows why); one that only reached it lets go
      if (state.preview?.runtime === m.name) closePreview("failed");
      m.previews.clear();
      scheduler.notify();
    }

    async function wakeIt(m) {
      // Whatever an earlier life left behind is ended first: never two workers for one machine
      if (m.host) {
        const old = m.host;
        m.host = null;
        try { await old.destroy(); } catch {}
      }
      await m.slot.open();
      const began = now();
      m.loading = 0;
      m.blobsDown = null;
      const host = makeHost(m);
      m.host = host;
      try {
        const saved = m.inMemory ?? await m.slot.load();
        if (saved) await host.boot(saved.state, saved.encoding);
        else await host.boot();
        await host.run();
        m.inMemory = null;
        m.onWake?.();
        m.wakeMs = now() - began;
        m.memoryBytes = (await host.memory()).wasmBytes;
      } catch (e) {
        if (m.host === host) m.host = null;
        try { await host.destroy(); } catch {}
        throw e;
      } finally {
        m.loading = null;
      }
    }

    async function suspendIt(m) {
      const host = m.host;
      if (!m.discard) {
        let packed;
        try {
          packed = await host.capture();
        } catch (e) {
          // A capture that hung (its worker ended) or a worker that died: the machine is gone,
          // and its lifecycle fails it (e.fatal); otherwise it goes on running
          if (e?.fatal) {
            if (m.host === host) m.host = null;
            host.destroy().catch(() => {});
          }
          throw e;
        }
        try {
          await m.slot.save(packed);
          m.dirty = false;
        } catch {
          // No storage (another tab holds it, or none at all): kept in this tab for the wake, and
          // the store is tried again at the next suspend
          m.inMemory = packed;
        }
      } else {
        m.dirty = false;
      }
      m.host = null;
      m.tape = [];
      m.tapeBytes = 0;
      m.blobsDown = null;
      await host.destroy();
      m.memoryBytes = 0;
      return true;
    }

    /** `fn` once the machine's earlier operations are done: one at a time in each machine. */
    function serial(m, fn) {
      const run = m.ops.then(fn);
      m.ops = run.catch(() => {});
      return run;
    }

    function uiState(m) {
      switch (m.lifecycle.state) {
        case "running": return m.busy() ? "busy" : "awake";
        case "suspended": return "asleep";
        default: return m.lifecycle.state; // waking, suspending, failed
      }
    }

    function describe(m) {
      return {
        name: m.name, title: m.title, purpose: m.purpose, sample: m.sample,
        state: uiState(m),
        doing: m.job ? `job ${m.job}` : m.xfers ? "copying a file" : m.previews.size ? `serving the preview (port ${[...m.previews.keys()].join(", ")})` : null,
        saved: !!(m.slot.saved || m.inMemory),
        savedAt: m.slot.saved?.savedAt ?? null,
        storage: m.slot.error ? `not saving: ${m.slot.error}` : "this browser (IndexedDB)",
        wakeSeconds: m.wakeMs != null ? Math.round(m.wakeMs / 100) / 10 : null,
        memoryMB: m.memoryBytes ? Math.round(m.memoryBytes / (1 << 20)) : 0,
        error: m.lifecycle.state === "failed" ? String(m.lifecycle.error?.message ?? m.lifecycle.error) : null,
        // Run in since its last save: a reload would lose that
        unsaved: m.dirty && uiState(m) !== "asleep" && uiState(m) !== "failed",
        // Its files (the blob store) could not be reached: reads of files not yet fetched fail
        filesUnreachable: m.blobsDown ? `can't reach the machine's files (${m.blobsDown.url})` : null,
        cpus: m.cpus,
        // Why it can't run in this page, if it can't (several CPUs, not isolated)
        unavailable: unavailable(m),
        // The ports a preview holds it awake for
        previewPorts: [...m.previews.keys()],
      };
    }

    function unavailable(m) {
      if (m.cpus > 1 && !isolated) {
        return `${m.name} runs on ${m.cpus} CPUs, which needs this page cross-origin isolated (SharedArrayBuffer), and it isn't: ` +
          "reload the page so its service worker can make it so (a browser without service workers can't)";
      }
      return null;
    }

    /** The panel's view of a machine: as agent.js's status() has it. */
    function status(runtime) {
      const m = get(runtime);
      const L = m.lifecycle;
      if (L.state === "failed") return { state: "failed", reason: String(L.error?.message ?? L.error) };
      if (L.state === "suspended" || L.state === "suspending" || L.state === "waking") {
        return { state: L.state, wakeSeconds: m.wakeMs != null ? m.wakeMs / 1000 : null,
          fresh: L.state === "suspended" && !m.slot.saved && !m.inMemory,
          note: L.state === "waking" ? "waking from its saved state" : "the next command wakes it first" };
      }
      if (m.job) return { state: "busy", jobId: m.job };
      if (m.xfers) return { state: "busy", jobId: "(a file copy)" };
      return { state: "ready" };
    }

    async function awake(m, signal, opts = {}) {
      const why = unavailable(m);
      if (why) throw new Error(why);
      await scheduler.ensureAwake(m, { signal, ...opts });
      m.lastUsed = now();
    }

    const busyJob = (m) => new Error(`busy: job ${m.job} is running in ${m.name}; one job at a time in each machine (cancel it, or wait)`);

    /** A command started in a machine: { jobId, runtime }. Asks the person first (once per page
     *  load). Behind a copy in the same machine, it waits for it; beside a job, it is refused.
     *  `source` says who asked, for the page's history: "form", "webmcp", or "script". */
    async function runCommand(input, { source = "script" } = {}) {
      if (!input || typeof input !== "object") throw new Error("runCommand: { runtime, command, timeoutSeconds?, requestId? }");
      const m = get(input.runtime);
      const { command, timeoutSeconds, requestId } = input;
      if (typeof command !== "string" || !command.trim()) throw new Error("command: a non-empty string");
      if (requestId !== undefined) {
        if (typeof requestId !== "string" || !/^[\w.:-]{1,128}$/.test(requestId)) throw new Error("requestId: 1 to 128 letters, digits, or _ . : -");
        const seen = requests.get(requestId);
        if (seen) {
          if (seen.runtime !== m.name || seen.command !== command) throw new Error(`requestId ${requestId} was used for a different command`);
          return { jobId: seen.jobId, runtime: m.name, repeated: true };
        }
      }
      if (m.job) throw busyJob(m);
      await ask();
      m.starting++;
      changed();
      try {
        return await serial(m, async () => {
          if (m.job) throw busyJob(m);
          await awake(m);
          if (!m.host) throw new Error(`${m.name} is not running`);
          const { jobId } = await m.host.runCommand({ command, timeoutSeconds });
          m.job = jobId;
          m.dirty = true;
          jobs.set(jobId, { machine: m, final: null });
          if (requestId !== undefined) requests.set(requestId, { runtime: m.name, command, jobId });
          changed();
          tell({ kind: "run", runtime: m.name, command, jobId, source });
          return { jobId, runtime: m.name };
        });
      } finally {
        m.starting = down(m.starting);
        changed();
      }
    }

    function owner(jobId) {
      const j = jobs.get(typeof jobId === "string" ? jobId : jobId?.jobId);
      if (!j) throw new Error(`no job ${typeof jobId === "string" ? jobId : jobId?.jobId}`);
      return j;
    }

    async function readJob(jobId) {
      const j = owner(jobId);
      if (j.final) return { ...j.final, runtime: j.machine.name };
      if (!j.machine.host) throw new Error("the job's machine was put away before it reported");
      const v = await j.machine.host.readJob(j.final?.jobId ?? (typeof jobId === "string" ? jobId : jobId.jobId));
      if (v.state !== "running") j.final = v;
      else j.lastOutput = v.output; // what a failed machine's job says it had printed
      if (j.final) return { ...j.final, runtime: j.machine.name }; // it failed meanwhile
      return { ...v, runtime: j.machine.name };
    }

    async function cancelJob(jobId) {
      const j = owner(jobId);
      if (j.final) return { ...j.final, runtime: j.machine.name };
      const v = await j.machine.host.cancelJob(typeof jobId === "string" ? jobId : jobId.jobId);
      return { ...v, runtime: j.machine.name };
    }

    /**
     * Copy a file from one machine to another (transfer.js over each machine's job runner):
     * { bytes, sha256, readSeconds, writeSeconds }. Asks the person first (once per page load).
     * `onProgress({ phase, done, total })`; `signal` cancels it. Each half runs in its machine's
     * turn (after what was asked of it before), and the machine is busy (never suspended) meanwhile.
     */
    async function copyFile(input, { signal, onProgress, source = "script" } = {}) {
      const { fromRuntime, fromPath, toRuntime, toPath } = input ?? {};
      const a = get(fromRuntime);
      const b = get(toRuntime);
      for (const [k, v] of [["fromPath", fromPath], ["toPath", toPath]]) {
        if (typeof v !== "string" || !v.trim()) throw new Error(`${k}: a file path in the machine`);
      }
      if (signal?.aborted) throw root.SnowglobeScheduler?.abortError?.() ?? Object.assign(new Error("cancelled"), { name: "AbortError" });
      await ask();
      const id = `copy-${++copyN}`;
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener?.("abort", abort);
      copies.set(id, controller);
      const sig = controller.signal;
      const from = `${a.name}:${fromPath}`;
      const to = `${b.name}:${toPath}`;
      tell({ kind: "copy", id, from, to, source, state: "running" });
      // One half in one machine: in its turn, busy (a copy) from the moment it is asked
      const half = async (m, fn) => {
        m.xfers++;
        changed();
        try {
          return await serial(m, async () => {
            if (m.job) throw new Error(`busy: job ${m.job} is running in ${m.name}`);
            await awake(m, sig);
            if (!m.host) throw new Error(`${m.name} is not running`);
            return await fn(m.host);
          });
        } finally {
          m.xfers = down(m.xfers);
          m.lastUsed = now();
          scheduler.notify();
          changed();
        }
      };
      const t0 = now();
      try {
        const read = await half(a, (host) => host.readFile(fromPath, { signal: sig, onProgress }));
        const t1 = now();
        const wrote = await half(b, (host) => {
          b.dirty = true;
          return host.writeFile(toPath, read.blob, { signal: sig, onProgress, sha256: read.sha256 });
        });
        const t2 = now();
        if (wrote.sha256 !== read.sha256) throw new Error("the copy's sha256 differs from the original's");
        const result = { copyId: id, bytes: read.size, sha256: read.sha256, readSeconds: (t1 - t0) / 1000, writeSeconds: (t2 - t1) / 1000 };
        tell({ kind: "copy", id, from, to, source, state: "copied", result });
        return result;
      } catch (e) {
        tell({ kind: "copy", id, from, to, source, state: e?.name === "AbortError" ? "cancelled" : "failed", error: String(e?.message ?? e) });
        throw e;
      } finally {
        copies.delete(id);
        signal?.removeEventListener?.("abort", abort);
      }
    }

    // ---------------------------------------------------------------- the preview

    const previewUrl = (runtime, port, path) => Preview.previewUrl(page.href, runtime, port, path);

    /** The preview, as the page and the tools see it (null when none is open). */
    function previewView() {
      const p = state.preview;
      if (!p) return null;
      return { runtime: p.runtime, port: p.port, path: p.path, url: previewUrl(p.runtime, p.port, p.path), base: previewUrl(p.runtime, p.port, "/"),
        reaching: machines.filter((m) => m.previews.size).map((m) => ({ runtime: m.name, ports: [...m.previews.keys()] })) };
    }

    /** No preview: every machine it held let go (their idle clocks start again). */
    function closePreview(why = "closed", source = "script") {
      const was = state.preview;
      state.preview = null;
      for (const m of machines) {
        if (!m.previews.size) continue;
        m.previews.clear();
        m.lastUsed = now();
        if (m.lifecycle.state === "running") m.lifecycle.touch();
      }
      scheduler.notify();
      changed();
      if (was) tell({ kind: "preview", preview: null, why, source });
      return true;
    }

    /** One GET through the bridge, for its status only: what open_preview says came back. The
     *  connection is dropped once the head arrives (the body is never read). */
    async function probe(m, port, path, signal) {
      let head = null;
      let error = null;
      const stop = new AbortController();
      const abort = () => stop.abort();
      if (signal?.aborted) abort();
      signal?.addEventListener?.("abort", abort);
      try {
        await Preview.serve((p) => m.host.tcpOpen(p), { runtime: m.name, port, method: "GET", path, headers: [["Accept", "text/html,*/*"]],
          prefix: new URL(previewUrl(m.name, port, "/")).pathname.replace(/\/$/, ""), origin: page.origin },
        (msg) => {
          if (msg.type === "head") {
            head = msg;
            stop.abort();
          }
          if (msg.type === "error") error = msg;
        }, { connectMs: 5000, answerMs: 30000, signal: stop.signal });
      } finally {
        signal?.removeEventListener?.("abort", abort);
      }
      if (head) return { status: head.status, statusText: head.statusText };
      const detail = /<h1>([^<]*)<\/h1>\s*<p>([^<]*)<\/p>/.exec(error?.body ?? "");
      return { status: error?.status ?? 502, error: detail ? `${detail[1]}: ${detail[2].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")}` : "no answer" };
    }

    /**
     * Show a machine's web server in the page's preview: { runtime, port, path? }. Asks the person
     * first (once per page load), wakes the machine, keeps it busy (never suspended) while the
     * preview is open, and tries the address once: { url, base, runtime, port, path, status,
     * statusText | error }. One preview at a time: an earlier one is closed.
     */
    async function openPreview(input, { source = "script", check = true, signal, waitMs = PREVIEW_WAIT_MS } = {}) {
      if (!input || typeof input !== "object") throw new Error("openPreview: { runtime, port, path? }");
      const m = get(input.runtime);
      const port = Preview.checkPort(input.port);
      const path = Preview.checkPath(input.path);
      if (!m.network) throw new Error(`${m.name} has no network device, so its servers can't be reached: a preview needs a machine built with the network on`);
      const why = unavailable(m);
      if (why) throw new Error(why);
      await ask();
      if (state.preview) closePreview("replaced", source);
      m.previews.set(port, "open");
      state.preview = { runtime: m.name, port, path };
      changed();
      try {
        await awake(m, signal, { waitMs, preview: true });
      } catch (e) {
        if (state.preview?.runtime === m.name && state.preview.port === port) closePreview("failed", source);
        throw e;
      }
      const view = previewView();
      const result = { ...view };
      if (check) Object.assign(result, await probe(m, port, path, signal));
      tell({ kind: "preview", preview: view, source, result });
      return result;
    }

    /**
     * A request the page's service worker passed on: { runtime, port, method, path, headers,
     * body, prefix, origin }. Its answer goes to `send` as it comes (preview.js's serve()). Answered
     * only while a preview is open and the person has allowed the page; a machine it reaches is
     * woken if it must be, and held awake (linked) for as long as the preview stays open.
     */
    async function previewRequest(req, send, { signal, waitMs = PREVIEW_WAIT_MS } = {}) {
      const refuse = (status, title, detail) => send({ type: "error", ...Preview.errorPage(status, title, detail, { back: page.href }) });
      if (!state.preview) return refuse(403, "No preview is open", "This address shows a machine's server only while the agent page has a preview open: open one there (Open preview, or the open_preview tool).");
      if (!granted()) return refuse(403, "Not allowed", "The person at the agent page hasn't allowed its machines to run yet.");
      let m;
      try { m = get(req.runtime); } catch (e) { return refuse(404, "No such machine", String(e?.message ?? e)); }
      if (!m.network) return refuse(502, "The machine can't be reached", `${m.name} has no network device: nothing in it can be connected to.`);
      // Held awake while the preview is open: a port is "linking" while requests to it are under
      // way, "linked" (until the preview closes) once one of them was answered, and let go when
      // the last one is over without an answer. Counted, so concurrent requests agree
      const port = req.port;
      m.inflight.set(port, (m.inflight.get(port) ?? 0) + 1);
      if (!m.previews.has(port)) {
        m.previews.set(port, "linking");
        changed();
      }
      let answered = false;
      try {
        try {
          await awake(m, signal, { waitMs, preview: true });
        } catch (e) {
          if (e?.name === "AbortError") return refuse(499, "Cancelled", "the page that asked for it went away");
          if (e?.name === "TimeoutError") return refuse(503, "No machine slot free", `${String(e?.message ?? e)}.`);
          return refuse(503, `${m.name} is not running`, String(e?.message ?? e));
        }
        if (!m.host) return refuse(503, `${m.name} is not running`, "it was put away");
        m.lastUsed = now();
        m.lifecycle.touch();
        if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) m.dirty = true;
        const host = m.host;
        await Preview.serve((p) => host.tcpOpen(p), { ...req, runtime: m.name }, (msg, transfer) => {
          if (msg.type === "head") {
            answered = true;
            if (m.previews.get(port) === "linking") m.previews.set(port, "linked");
          }
          send(msg, transfer);
        }, { signal });
      } finally {
        const left = (m.inflight.get(port) ?? 1) - 1;
        if (left > 0) m.inflight.set(port, left);
        else m.inflight.delete(port);
        if (left <= 0 && m.previews.get(port) === "linking") {
          m.previews.delete(port);
          m.lastUsed = now();
          scheduler.notify();
          changed();
        }
      }
    }

    /** Back to the snapshot: its save deleted, and (if awake) the machine ended without a save.
     *  Always asks the person at the page first (confirmFresh), whoever calls it. */
    async function startFresh(runtime) {
      const m = get(runtime);
      if (m.busy()) throw new Error(`${m.name} is busy; wait for it, or cancel what runs`);
      if (!(await confirmFresh(m))) return false;
      await scheduler.exclusive(async () => {
        if (m.busy()) throw new Error(`${m.name} is busy; wait for it, or cancel what runs`);
        if (m.lifecycle.state === "running") {
          m.discard = true;
          try { await m.lifecycle.suspend("fresh"); } finally { m.discard = false; }
        }
        if (m.host) ended(m, null); // a failed machine's leftovers, if any
        m.inMemory = null;
        m.dirty = false;
        await m.slot.clear();
        m.lifecycle.forget();
      });
      changed();
      return true;
    }

    const api = {
      async capabilities() {
        return {
          protocolVersion: "2",
          page: "agent",
          execution: "browser-wasm",
          architecture: "arm64",
          transport: state.transport,
          runtimes: machines.map((m) => m.name),
          awakeLimit: scheduler.budget,
          budget: scheduler.budget,
          maxAwakeLimit: root.SnowglobeScheduler?.defaults.MAX_BUDGET ?? 8,
          awake: scheduler.awake().length,
          overLimit: scheduler.over,
          supported: machines.length > 0,
          reason: machines.length ? null : "no runtimes",
          maxConcurrentJobsPerRuntime: 1,
          maxCopyBytes: root.SnowglobeTransfer?.limits.MAX_BYTES ?? 8 << 20,
          features: ["listRuntimes", "runCommand", "readJob", "cancelJob", "copyFile", "suspend", "wake", "startFresh", "setAwakeLimit", "openPreview", "closePreview"],
          crossOriginIsolated: isolated,
          previewBase: new URL(Preview?.PREFIX ?? "preview/", page).href,
          preview: previewView(),
          workingDirectory: "/root",
          suspendsAfterIdleSeconds: Math.round(root.SnowglobeMachine.defaults.IDLE_MS / 1000),
          suspendsAfterHiddenSeconds: Math.round(root.SnowglobeMachine.defaults.HIDDEN_MS / 1000),
          webmcp: api._webmcp ?? null,
        };
      },
      async listRuntimes() { return machines.map(describe); },
      async status(runtime) { return runtime === undefined ? machines.map(describe) : status(runtime); },
      runCommand,
      readJob,
      cancelJob,
      copyFile,
      async cancelCopy(id) {
        for (const [k, c] of copies) if (id === undefined || k === id) c.abort();
        return true;
      },
      async suspend(runtime) { return scheduler.suspend(get(runtime), "asked"); },
      async wake(runtime) { await awake(get(runtime)); return true; },
      async retry(runtime) {
        const m = get(runtime);
        m.lifecycle.retry();
        changed();
        await awake(m);
        return true;
      },
      startFresh,
      openPreview,
      async closePreview(opts) { return closePreview("closed", opts?.source); },
      async preview() { return previewView(); },
      previewRequest,
      /** How many machines may be awake at once, 1 to 8, for this page load (2 until changed). It
       *  runs nothing, so it asks no one. Lower than what is awake: idle machines are suspended, least
       *  recently used first; busy ones once they finish (capabilities().overLimit says so meanwhile).
       *  Resolves once the idle ones are suspended: { awakeLimit, awake, overLimit }. */
      async setAwakeLimit(count) {
        const n = typeof count === "string" && /^\d+$/.test(count.trim()) ? Number(count) : count;
        const trimmed = scheduler.setBudget(n);
        changed();
        // A trim waits its turn behind wakes under way: not for ever
        let timer;
        await Promise.race([trimmed, new Promise((r) => { timer = setTimeout(r, 20000); })]);
        clearTimeout(timer);
        changed();
        return { awakeLimit: scheduler.budget, awake: scheduler.awake().length, overLimit: scheduler.over };
      },
      async setBudget(n) { return (await api.setAwakeLimit(n)).awakeLimit; },
      /** The machines whose changes a reload would lose: awake, and run in since their last save. */
      unsaved() {
        return machines.filter((m) => m.dirty && ["running", "suspending", "waking"].includes(m.lifecycle.state)).map((m) => m.name);
      },
      // Upload lines typed ahead of their acknowledgement (1 to 4), from each machine's next wake
      async setUploadWindow(n) {
        if (!Number.isInteger(n) || n < 1 || n > 4) throw new Error("uploadWindow: 1 to 4");
        state.uploadWindow = n;
        return "applies to each machine from its next wake";
      },
      async setTransport(t) {
        if (t !== "worker" && t !== "inline") throw new Error('transport: "worker" or "inline"');
        state.transport = t;
        return "applies to each machine from its next wake";
      },
    };
    Object.defineProperty(api, "_machines", { value: machines });
    Object.defineProperty(api, "_get", { value: get });
    Object.defineProperty(api, "_status", { value: status });
    Object.defineProperty(api, "_describe", { value: describe });
    return api;
  }

  const SnowglobeOrchestrator = { createAgents, SaveSlot };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeOrchestrator;
  else root.SnowglobeOrchestrator = SnowglobeOrchestrator;
})(typeof window !== "undefined" ? window : globalThis);
