// The agent page (/agent/): every one-CPU agent runtime of the site in one page, and what
// coordinates them. It reads runtimes.json (written when the site is assembled: snowglobe
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
//    one set of WebMCP tools; asking the person at the page once, before anything runs.
// A machine that fails (its worker crashed, it powered off, a capture hung) is ended at once: its
// worker terminated, its job finished as failed, nothing left holding its memory.
// Nothing runs because of the address: ?runtime=<name> only preselects a machine.
(function (root) {
  "use strict";

  const S = () => root.SnowglobeSessions;
  const MAX_TAPE = 256 << 10; // console output kept per machine, for its terminal
  const SAVE_ID = "machine";

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
   * from, to, source, state, result | error }.
   */
  function createAgents(manifest, { pageUrl, scheduler, Machine, createMachine, ask = notAsked, confirmFresh, onchange, onactivity, now = () => Date.now(),
    transport = "worker", hidden = false, machineOptions = {}, hostOptions = {} } = {}) {
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
    const state = { transport, uploadWindow: 4 };

    const machines = manifest.runtimes.map((r) => {
      const base = abs(r.base);
      // CPUs per machine, as its site has them (the page lists one-CPU sites today)
      const cpus = r.cpus ?? 1;
      const config = { build: r.build_id, memory: r.memory_mb, cpus, network: r.network === "fetch" ? "fetch" : "none" };
      const m = {
        name: r.name, title: r.title, purpose: r.purpose, sample: r.sample, base,
        slot: new SaveSlot(new URL(r.name, page).pathname, config, r.title),
        host: null, job: null, xfers: 0, starting: 0, lastUsed: 0, tape: [], tapeBytes: 0,
        loading: null, memoryBytes: 0, inMemory: null, discard: false, error: null,
        // Changed since its last save (a run, a copy into it, a key in its terminal): a reload loses it
        dirty: false,
        // The blob store its files come from, when it can't be reached: what the page says
        blobsDown: null,
        // Its operations (a run's start, a copy's half), one at a time, in the order asked
        ops: Promise.resolve(),
        busy() { return !!this.job || this.xfers > 0 || this.starting > 0; },
      };
      m.armless = {
        name: r.name,
        wasm: abs(manifest.armless.wasm), memory_mb: r.memory_mb, cpus,
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
        doing: m.job ? `job ${m.job}` : m.xfers ? "copying a file" : null,
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
      };
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

    async function awake(m, signal) {
      await scheduler.ensureAwake(m, { signal });
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
          features: ["listRuntimes", "runCommand", "readJob", "cancelJob", "copyFile", "suspend", "wake", "startFresh", "setAwakeLimit"],
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
