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
//    every machine its page reaches through the preview, awake (busy) until it is closed; a
//    WebSocket its page opens to a machine is spoken here (previewSocket, ws-client.js).
// A machine on several CPUs needs the page cross-origin isolated (its service worker makes it one);
// where it isn't, that machine is refused with the reason, and the others run as ever.
// A machine that fails (its worker crashed, it powered off, a capture hung) is ended at once: its
// worker terminated, its job finished as failed, nothing left holding its memory.
// Nothing runs because of the address: ?runtime=<name> only preselects a machine.
(function (root) {
  "use strict";

  const S = () => root.SnowglobeSessions;
  const B = () => root.SnowglobeBuilder;
  const MAX_TAPE = 256 << 10; // console output kept per machine, for its terminal
  const SAVE_ID = "machine";
  // How long the preview (a request through it, or open_preview) waits for an awake slot when
  // every awake machine is busy with something other than the preview, before it gives up
  const PREVIEW_WAIT_MS = 30000;
  // Raw TCP over links: connections at once over one link (from, to, port), beyond which a new one
  // is refused; bytes on their way in either direction on one connection, beyond which it is
  // closed (nothing in armless can tell a guest to slow down: see linkOpen); how long the machine
  // linked to gets to accept, once awake
  const MAX_LINK_CONNS = 64;
  const MAX_LINK_QUEUED = 8 << 20;
  const LINK_CONNECT_MS = 10000;
  // WebSockets the preview's pages open to the machines (previewSocket): at once, in the whole page
  const MAX_PREVIEW_SOCKETS = 32;
  // A link's tunnel url, as machine-core.js's linkUrl() makes it and its LinkSocket recognises
  const linkUrl = (runtime, port) => `wss://link.invalid/${encodeURIComponent(runtime)}/${port}`;

  /** One machine's save: one checkpoint in IndexedDB, in a scope of its own, held by one tab. */
  class SaveSlot {
    constructor(scope, config, name, openStore) {
      this.openStore = openStore;
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
          this.store = await (this.openStore ? this.openStore() : S().BrowserStore.open(this.scope));
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
      this.error = null;
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
  function createAgents(manifest, { pageUrl, scheduler, Machine, createMachine, ask = notAsked, confirmFresh, onchange, onactivity, saveScope, saveStore, now = () => Date.now(),
    transport = "worker", hidden = false, machineOptions = {}, hostOptions = {}, isolated = root.crossOriginIsolated === true,
    granted = () => !!ask.granted?.(), preview: Preview = root.SnowglobePreview } = {}) {
    const page = new URL("./", pageUrl);
    const abs = (u) => new URL(u, page).href;
    const scripts = {
      worker: abs("machine-worker.js"),
      core: [abs(manifest.armless.js), abs("sessions.js"), abs("agent.js"), abs("transfer.js"), abs("ws-client.js"), abs("machine-core.js")],
    };
    // The memory debug (memory-debug.js): armless samples the machines' memory when the page asked
    const debugMemory = !!root.SnowglobeMemoryDebug?.enabled?.();
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
    // Links between machines, by the machine that connects: { names: { name: { runtime, port } } (its
    // guest's HTTP to a name, guestFetch), tunnels: [{ host, port, runtime, to }] (its guest's TCP to
    // host:port, carried to port `to` in `runtime`) }; and the ports they reach, which the page
    // answers without a preview
    const links = { byMachine: new Map(), targets: new Set() };
    // WebSockets the preview's pages have open to the machines: each { close(why) }
    const previewSockets = new Set();

    const machines = manifest.runtimes.map((r) => {
      const base = abs(r.base);
      // CPUs per machine, as its site has them (several need the page cross-origin isolated)
      const cpus = r.cpus ?? 1;
      const config = { build: r.build_id, memory: r.memory_mb, cpus, network: r.network === "fetch" ? "fetch" : "none" };
      const m = {
        name: r.name, title: r.title, purpose: r.purpose, sample: r.sample, base, cpus, network: r.network === "fetch",
        // The directory whose changes each command reports (builder.js), if its site has one
        watch: r.watch && B() ? B().checkWatch(r.watch) : null,
        slot: new SaveSlot(saveScope ? saveScope(r.name) : new URL(r.name, page).pathname, config, r.title, saveStore ? () => saveStore(r.name) : null),
        host: null, job: null, xfers: 0, starting: 0, holds: 0, lastUsed: 0, tape: [], tapeBytes: 0,
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
        // TCP connections over links: into it (each holds it awake, busy, until it closes), and out
        // of its guest (while any is open, it and the machines it reaches count as one, as the
        // preview's do, so the machine it connects to is woken beside it even at the awake limit)
        linksIn: 0,
        linksOut: 0,
        busy() { return !!this.job || this.xfers > 0 || this.starting > 0 || this.holds > 0 || this.previews.size > 0 || this.linksIn > 0; },
        // Held by the preview: the scheduler counts the preview's machines as one
        previewHeld() { return this.previews.size > 0 || this.linksIn > 0 || this.linksOut > 0; },
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

    /** The machine's armless options, with the names its guest may connect to (read at each wake):
     *  `links` for its HTTP to them, and a tunnel per link for its TCP (machine-core.js's LinkSocket). */
    function withLinks(m) {
      const l = links.byMachine.get(m.name);
      if (!l) return m.armless;
      const cfg = { ...m.armless, links: l.names, link_base: page.href };
      if (m.armless.network) {
        cfg.network = { ...m.armless.network, tunnels: [...(m.armless.network.tunnels ?? []),
          ...l.tunnels.map((t) => ({ host: t.host, port: t.port, url: linkUrl(t.runtime, t.to) }))] };
      }
      return cfg;
    }

    // ---------------------------------------------------------------- TCP over links
    //
    // A guest's TCP connection to a link's name and port arrives as `link` events from its host
    // (machine-core.js's LinkSocket, in its worker): open { cid, runtime, port }, then data, end
    // (the guest's FIN) and close. The page checks it against that machine's own links (the worker
    // is trusted less than the page), holds the machine it reaches awake (busy) while it is open,
    // wakes it if it must, connects to the port there (tcpOpen) and pipes both ways, answering
    // with host.linkIn(cid, connect | data | end | close | error). Every way it can end (either
    // side closing, either machine going, a refusal, the bound on bytes on their way) ends it once
    // and lets go of the hold once.

    /** What a host says about its guest's link connections (`conns`: that host's, by cid). */
    function linkEvent(a, host, conns, e) {
      if (!e || typeof e !== "object") return;
      if (e.kind === "gone") {
        for (const c of [...conns.values()]) c.finish(null, `${a.name} went away`);
        return;
      }
      if (e.kind === "open") return linkOpen(a, host, conns, e);
      const c = conns.get(e.cid);
      if (!c) return; // over already
      if (e.kind === "data") c.fromGuest(e.bytes);
      else if (e.kind === "end") c.guestEnded();
      else if (e.kind === "close") c.finish(null, "the guest closed it");
    }

    function linkOpen(a, host, conns, { cid, runtime, port }) {
      const refuse = () => { host.linkIn(cid, "close").catch(() => {}); };
      if (!Number.isInteger(cid) || cid < 1 || conns.has(cid)) return;
      // Only a machine's own links, as this page declared them, and once the person allowed the page
      const declared = links.byMachine.get(a.name)?.tunnels.some((t) => t.runtime === runtime && t.to === port);
      if (a.host !== host || !granted() || !declared || !links.targets.has(`${runtime}:${port}`)) return refuse();
      const b = byName.get(runtime);
      if (!b || b === a || !b.network) return refuse();
      let open = 0;
      for (const x of conns.values()) if (x.b === b && x.port === port) open++;
      if (open >= MAX_LINK_CONNS) return refuse();

      const wake = new AbortController();
      let timer = null;
      let stream = null;
      let streamOver = false; // b's side said close or error: nothing to abort
      let held = true;
      const c = {
        cid, b, port,
        state: "opening", // opening, open, closing (the server finished: the guest was told), done
        toB: 0, // bytes written to b's server that it hasn't taken yet
        toA: 0, // bytes handed to a's guest that it hasn't taken yet
        /** Over: `say` (connect's opposite, to a's guest: "close", "error", or null for nothing), b's
         *  side ended, the hold let go. Once, whatever asks. */
        finish(say, why) {
          if (c.state === "done") return;
          c.state = "done";
          c.why = why;
          conns.delete(cid);
          if (timer !== null) clearTimeout(timer);
          timer = null;
          wake.abort();
          if (say) host.linkIn(cid, say).catch(() => {});
          if (stream && !streamOver) { try { stream.abort(); } catch {} }
          if (held) {
            held = false;
            b.linksIn = down(b.linksIn);
            a.linksOut = down(a.linksOut);
            b.lastUsed = now();
            if (b.lifecycle.state === "running") b.lifecycle.touch();
            scheduler.notify();
            changed();
          }
        },
        fromGuest(bytes) {
          if (c.state !== "open" || !(bytes instanceof Uint8Array)) return;
          const n = bytes.length;
          c.toB += n;
          if (c.toB > MAX_LINK_QUEUED) return c.finish("error", `more than ${MAX_LINK_QUEUED} bytes on their way to ${b.name}`);
          stream.write(bytes)?.then?.(() => { c.toB -= n; }, () => {});
        },
        guestEnded() {
          // A half-close: b's server reads its end, and may still answer
          if (c.state === "open") stream.end();
        },
      };
      conns.set(cid, c);
      b.linksIn++;
      a.linksOut++;
      changed();

      (async () => {
        try {
          await awake(b, wake.signal, { waitMs: PREVIEW_WAIT_MS, preview: true });
        } catch (e) {
          return c.finish("error", String(e?.message ?? e));
        }
        if (c.state !== "opening") return;
        if (!b.host) return c.finish("error", `${b.name} is not running`);
        b.lastUsed = now();
        b.lifecycle.touch();
        b.dirty = true; // whatever comes over the connection may change it
        const s = stream = b.host.tcpOpen(port);
        timer = setTimeout(() => { timer = null; if (c.state === "opening") c.finish("error", `${b.name} did not accept on port ${port}`); }, LINK_CONNECT_MS);
        s.onconnect = () => {
          if (c.state !== "opening") return;
          clearTimeout(timer);
          timer = null;
          c.state = "open";
          host.linkIn(cid, "connect").catch(() => c.finish(null, `${a.name} went away`));
        };
        s.ondata = (bytes) => {
          if (c.state !== "open") return;
          const n = bytes.length;
          c.toA += n;
          if (c.toA > MAX_LINK_QUEUED) return c.finish("error", `more than ${MAX_LINK_QUEUED} bytes on their way to ${a.name}`);
          host.linkIn(cid, "data", bytes).then(() => { c.toA -= n; }, () => c.finish(null, `${a.name} went away`));
        };
        // The server finished sending: the guest's side is closed after what came (armless can't be
        // told a half-close), and the page's side to the server too; over once the server closes
        s.onend = () => {
          if (c.state !== "open") return;
          c.state = "closing";
          host.linkIn(cid, "end").catch(() => {});
          try { s.end(); } catch {}
        };
        // Closed with no connect before it: nothing listens there, and the guest is refused
        s.onclose = () => { streamOver = true; c.finish(c.state === "closing" ? null : "close", "the server closed it"); };
        // The machine linked to went away (suspended, failed, ended) under it
        s.onerror = (e) => { streamOver = true; c.finish(c.state === "closing" ? null : "error", String(e?.message ?? e)); };
      })();
    }

    // A machine's host, made at each wake (and its worker with it), ended at each suspend
    function makeHost(m) {
      const config = debugMemory ? { ...withLinks(m), debug: true } : withLinks(m);
      const host = createMachine({ base: m.base, config, transport: state.transport, scripts, uploadWindow: state.uploadWindow, ...hostOptions });
      m.files = null; // this wake's

      // Its guest's TCP connections over links, by cid: each ends when this host goes ("gone")
      const linkConns = new Map();
      host.on("link", (e) => linkEvent(m, host, linkConns, e));
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
        j?.end?.();
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
      // How its guest's files are coming in (the warm pack, files fetched on their own and ahead)
      host.on("files", (e) => {
        if (m.host !== host) return;
        m.files = e;
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
        j?.end?.();
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
        } catch (error) {
          // No storage (another tab holds it, or none at all): kept in this tab for the wake, and
          // the store is tried again at the next suspend
          m.slot.error = String(error?.message ?? error);
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
        // Each command here reports the files it changed in this directory (job_status's changes)
        watch: m.watch,
        doing: m.job ? `job ${m.job}` : m.xfers ? "copying a file" : m.previews.size ? `serving the preview (port ${[...m.previews.keys()].join(", ")})`
          : m.linksIn ? `serving ${m.linksIn} link connection${m.linksIn === 1 ? "" : "s"}` : null,
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
        // How its files are coming in, while it is awake: { warm: { loaded, total, done } | null,
        // fromPack, fetched, fetchedBytes, prefetched, prefetchedBytes }
        files: m.host ? m.files ?? null : null,
        cpus: m.cpus,
        // Why it can't run in this page, if it can't (several CPUs, not isolated)
        unavailable: unavailable(m),
        // The ports a preview holds it awake for
        previewPorts: [...m.previews.keys()],
        // TCP connections over links: into it (holding it awake), and out of its guest
        linkConnections: { in: m.linksIn, out: m.linksOut },
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
    async function runCommand(input, { source = "script", files, display, wrap = true, silent = false } = {}) {
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
          // In a watched machine the command runs inside a wrapper that reports what it changed (not
          // a read: wrap false)
          const wrapped = m.watch && wrap;
          const nonce = wrapped ? token() : null;
          const run = wrapped ? B().wrapCommand(command, m.watch, nonce) : { command, files: {} };
          const { jobId } = await m.host.runCommand({ command: run.command, timeoutSeconds,
            ...(files || wrapped ? { files: { ...files, ...run.files } } : {}) });
          m.job = jobId;
          if (wrap) m.dirty = true;
          const j = { machine: m, final: null, nonce };
          j.ended = new Promise((resolve) => { j.end = resolve; });
          jobs.set(jobId, j);
          if (requestId !== undefined) requests.set(requestId, { runtime: m.name, command, jobId });
          changed();
          if (!silent) tell({ kind: "run", runtime: m.name, command: display ?? command, jobId, source, watch: wrapped ? m.watch : null, ...(typeof silent === "object" ? silent : {}) });
          return { jobId, runtime: m.name };
        });
      } finally {
        m.starting = down(m.starting);
        changed();
      }
    }

    /** A random token of 16 hex digits. */
    function token() {
      const b = new Uint8Array(8);
      (root.crypto ?? globalThis.crypto).getRandomValues(b);
      return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    }

    /** A job's view as callers see it: in a watched machine, the report of what it changed taken out
     *  of its output and given as changes ({ files, more }, once it is complete). */
    function present(j, v) {
      const out = { ...v, runtime: j.machine.name };
      if (j.nonce) {
        const split = B().splitChanges(v.output ?? "", j.nonce);
        out.output = split.output;
        out.changes = split.changes;
        out.watch = j.machine.watch;
      }
      return out;
    }

    function owner(jobId) {
      const j = jobs.get(typeof jobId === "string" ? jobId : jobId?.jobId);
      if (!j) throw new Error(`no job ${typeof jobId === "string" ? jobId : jobId?.jobId}`);
      return j;
    }

    async function readJob(jobId) {
      const j = owner(jobId);
      if (j.final) return present(j, j.final);
      if (!j.machine.host) throw new Error("the job's machine was put away before it reported");
      const v = await j.machine.host.readJob(j.final?.jobId ?? (typeof jobId === "string" ? jobId : jobId.jobId));
      if (v.state !== "running") j.final = v;
      else j.lastOutput = v.output; // what a failed machine's job says it had printed
      if (j.final) return present(j, j.final); // it failed meanwhile
      return present(j, v);
    }

    async function cancelJob(jobId) {
      const j = owner(jobId);
      if (j.final) return present(j, j.final);
      const v = await j.machine.host.cancelJob(typeof jobId === "string" ? jobId : jobId.jobId);
      return present(j, v);
    }

    const MAX_WRITE = 1 << 20;

    /**
     * Write a text file in a machine: { runtime, path, content }. A job of its own (so it takes its
     * turn, and asks the person first, as a run does), the content passed as a file of the job's,
     * never typed into a shell command; the file's directory is made. Resolves once it is written:
     * { jobId, runtime, path, bytes, changes } (changes: in a watched machine, what it changed).
     */
    async function writeFile(input, { source = "script", signal } = {}) {
      if (!input || typeof input !== "object") throw new Error("writeFile: { runtime, path, content }");
      const { path, content } = input;
      if (typeof path !== "string" || !path.trim() || path.length > 4096 || /[\0\n\r]/.test(path) || path.endsWith("/")) {
        throw new Error("path: a file path in the machine (relative paths start in /root), with no line breaks");
      }
      if (typeof content !== "string") throw new Error("content: the file's text");
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > MAX_WRITE) throw new Error(`content: ${bytes.length} bytes; at most ${MAX_WRITE} (1 MiB): copy_file larger files`);
      const q = "'" + path.replace(/'/g, "'\\''") + "'";
      const command = `f=${q}; d=$(dirname -- "$f"); mkdir -p -- "$d" && cat "$EXCLAVE_WORKSPACE/in/content" >"$f" && echo "wrote $(wc -c <"$f") bytes to $f"`;
      const { jobId, runtime } = await runCommand({ runtime: input.runtime, command }, { source, files: { content: bytes }, display: `write ${path} (${bytes.length} bytes)` });
      const j = jobs.get(jobId);
      const abort = () => { cancelJob(jobId).catch(() => {}); };
      signal?.addEventListener?.("abort", abort);
      try { await j.ended; } finally { signal?.removeEventListener?.("abort", abort); }
      const v = await readJob(jobId);
      if (v.state !== "exited" || v.exitStatus !== 0) {
        throw new Error(`${path} was not written: ${v.state === "exited" ? `exit ${v.exitStatus}` : v.state}${v.error ? ` (${v.error})` : ""}${v.output.trim() ? `: ${v.output.trim().slice(-300)}` : ""}`);
      }
      return { jobId, runtime, path, bytes: bytes.length, changes: v.changes ?? null, watch: v.watch ?? null };
    }

    /** A job run to its end: its view (output, exit status, changes). `signal` cancels it. */
    async function finish(jobId, signal) {
      const j = jobs.get(jobId);
      const abort = () => { cancelJob(jobId).catch(() => {}); };
      signal?.addEventListener?.("abort", abort);
      try { await j.ended; } finally { signal?.removeEventListener?.("abort", abort); }
      return readJob(jobId);
    }

    /** A job of the page's own (a read, a listing): run unwrapped and to its end, its output if it
     *  exited 0, else an error saying how it ended. */
    async function quietJob(runtime, command, { files, signal, source, display, kind } = {}) {
      const { jobId } = await runCommand({ runtime, command }, { source, files, wrap: false, silent: true });
      const v = await finish(jobId, signal);
      if (v.state !== "exited" || v.exitStatus !== 0) {
        throw new Error(`${display ?? "it"} failed: ${v.state === "exited" ? `exit ${v.exitStatus}` : v.state}${v.error ? ` (${v.error})` : ""}${v.output?.trim() ? `: ${v.output.trim().slice(-300)}` : ""}`);
      }
      if (source !== "studio" && kind) tell({ kind, runtime, source, ...kind === "read" ? { paths: display } : { path: display } });
      return v.output ?? "";
    }

    /**
     * A directory's files: { runtime, path?, depth? } (path: the machine's watched project, else
     * /root). One job; node_modules, dist and .git are listed, not entered. Resolves to { dir,
     * entries: [{ path, type, size, skipped? }], truncated }.
     */
    async function listFiles(input, { source = "script", signal } = {}) {
      const m = get(input?.runtime);
      const dir = input.path ?? m.watch ?? "/root";
      const out = await quietJob(m.name, B().listCommand(dir, input.depth ?? 4), { signal, source, display: dir, kind: "list" });
      return { runtime: m.name, ...B().parseList(out) };
    }

    /**
     * Text files' contents: { runtime, paths } (or path), up to 20 files in one job, 256 KiB of each
     * at most (truncated says so). Resolves to [{ path, size, text, truncated } | { path, binary } |
     * { path, error }].
     */
    async function readFiles(input, { source = "script", signal } = {}) {
      const m = get(input?.runtime);
      const paths = input.paths ?? (input.path !== undefined ? [input.path] : null);
      if (!Array.isArray(paths) || !paths.length) throw new Error("paths: the files to read");
      const out = await quietJob(m.name, B().readCommand(paths), { signal, source, display: paths, kind: "read" });
      return B().parseRead(out, paths);
    }

    /**
     * Several changes to a machine's files in one job: { runtime, files: [{ path, content }], move:
     * [{ from, to }], delete: [path] }. Written to temporary names first and moved into place
     * together (so a watcher sees them at once, and rebuilds once). Resolves once done: { jobId,
     * runtime, written, bytes, changes, watch }.
     */
    async function writeFiles(input, { source = "script", signal } = {}) {
      if (!input || typeof input !== "object") throw new Error("writeFiles: { runtime, files, move?, delete? }");
      const w = B().writeFilesCommand({ files: input.files ?? [], move: input.move ?? [], remove: input.delete ?? [] });
      const n = (input.files ?? []).length;
      const what = [n && `${n} file${n === 1 ? "" : "s"}`, input.move?.length && `${input.move.length} moved`, input.delete?.length && `${input.delete.length} deleted`].filter(Boolean).join(", ");
      const { jobId, runtime } = await runCommand({ runtime: input.runtime, command: w.command }, { source, files: w.files, display: `write ${what}` });
      const v = await finish(jobId, signal);
      if (v.state !== "exited" || v.exitStatus !== 0) {
        throw new Error(`not done: ${v.state === "exited" ? `exit ${v.exitStatus}` : v.state}${v.error ? ` (${v.error})` : ""}${v.output?.trim() ? `: ${v.output.trim().slice(-300)}` : ""}`);
      }
      return { jobId, runtime, written: n, bytes: w.bytes, changes: v.changes ?? null, watch: v.watch ?? null };
    }

    /** A watched project taken back: { runtime, to: "previous" | "start" } (builder.js's
     *  revertCommand), as a job whose report says what it changed: { jobId, changes, output }. */
    async function revert(input, { source = "script", signal } = {}) {
      const m = get(input?.runtime);
      if (!m.watch) throw new Error(`${m.name} has no watched project to revert (list_runtimes' watch)`);
      const command = B().revertCommand(m.watch, input.to);
      const { jobId } = await runCommand({ runtime: m.name, command }, { source, display: input.to === "start" ? "revert the project to how it began" : "undo the last change" });
      const v = await finish(jobId, signal);
      if (v.state === "exited" && v.exitStatus === 3) throw new Error(v.output.trim() || "nothing to revert");
      if (v.state !== "exited" || v.exitStatus !== 0) throw new Error(`not reverted: ${v.state === "exited" ? `exit ${v.exitStatus}` : v.state}${v.output?.trim() ? `: ${v.output.trim().slice(-300)}` : ""}`);
      return { jobId, runtime: m.name, changes: v.changes ?? null, watch: m.watch, output: v.output.trim() };
    }

    /**
     * SQL on a database machine: { runtime (supabase by default), sql }, through psql with
     * ON_ERROR_STOP (Supabase's $DB_URL, else the local server's socket), then
     * `notify pgrst, 'reload schema'` so Supabase's Data API sees a schema change at once. The SQL
     * goes in as a file of the job's: no quoting. Resolves once done: { jobId, exitStatus, output }.
     * `tsv`: rows as tab-separated values, no headers (for the page's own reads).
     */
    async function runSql(input, { source = "script", signal, tsv = false, silent = false } = {}) {
      if (!input || typeof input.sql !== "string" || !input.sql.trim()) throw new Error("sql: the statements to run");
      const runtime = input.runtime ?? "supabase";
      const sql = new TextEncoder().encode(input.sql);
      if (sql.length > MAX_WRITE) throw new Error("sql: at most 1 MiB");
      const db = `"\${DB_URL:-postgresql://postgres@/postgres?host=/run/postgresql}"`;
      const command = `psql ${db} -X -v ON_ERROR_STOP=1 -P pager=off ${tsv ? `-A -t -F "$(printf '\\t')" ` : ""}-f "$EXCLAVE_WORKSPACE/in/sql"; sg_rc=$?\n` +
        `[ "$sg_rc" -eq 0 ] && psql ${db} -X -q -c "notify pgrst, 'reload schema'" >/dev/null 2>&1\nexit $sg_rc\n`;
      const first = input.sql.trim().split("\n")[0];
      const { jobId } = await runCommand({ runtime, command }, { source, files: { sql }, display: `SQL: ${first.length > 120 ? first.slice(0, 120) + "…" : first}`, wrap: false, silent });
      const v = await finish(jobId, signal);
      return { jobId, runtime, state: v.state, exitStatus: v.exitStatus, output: v.output ?? "", error: v.error ?? null };
    }

    /**
     * How the last build of a machine's `serve --watch` went: { runtime (web by default), port
     * (4173) }. Wakes the machine if it must (asking the person first, as a run does) and reads its
     * /__build over the machine's network: { version, state: "building" | "ok" | "error", error, ms,
     * at }, or { state: "none" } when nothing answers there.
     */
    async function buildStatus(input = {}, { signal } = {}) {
      const m = get(input.runtime ?? "web");
      if (!m.network) throw new Error(`${m.name} has no network device: its servers can't be reached`);
      await ask();
      await awake(m, signal);
      if (!m.host) throw new Error(`${m.name} is not running`);
      const r = await fetchText(m, Preview.checkPort(input.port ?? 4173), "/__build", { signal });
      if (!r || r.status === 404 || r.error) return { runtime: m.name, state: "none", detail: r?.status === 404 ? "the server there has no /__build (it isn't serve --watch)" : "nothing answers on that port" };
      try { return { runtime: m.name, ...JSON.parse(r.body) }; } catch { return { runtime: m.name, state: "none", detail: "/__build didn't answer JSON" }; }
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
      // Its pages' WebSockets go with it (the page in the frame is gone, or going)
      for (const s of [...previewSockets]) s.close("the preview closed");
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
     * A small GET to a server in a machine the preview reaches, for the page itself (the preview's
     * /__build, say): { status, body } (body as text, at most 64 KiB), or null when no preview is
     * open, the person hasn't allowed the page, or the machine isn't running (it is never woken).
     */
    async function previewGet({ runtime, port, path = "/" }, { signal, answerMs = 10000 } = {}) {
      if (!state.preview || !granted()) return null;
      const m = get(runtime);
      if (m.lifecycle.state !== "running" || !m.host || !m.network) return null;
      return fetchText(m, port, path, { signal, answerMs });
    }

    /** A small GET to a running machine's server, over its network: { status, body } (64 KiB at
     *  most), { status, error: true }, or null if nothing answered. */
    async function fetchText(m, port, path, { signal, answerMs = 10000 } = {}) {
      const host = m.host;
      let head = null;
      let error = null;
      const parts = [];
      let size = 0;
      await Preview.serve((p) => host.tcpOpen(p), { runtime: m.name, port: Preview.checkPort(port), method: "GET", path: Preview.checkPath(path),
        headers: [["Accept", "application/json, text/plain, */*"]], prefix: new URL(previewUrl(m.name, port, "/")).pathname.replace(/\/$/, ""), origin: page.origin },
      (msg) => {
        if (msg.type === "head") head = msg;
        else if (msg.type === "data" && size < 64 << 10) { parts.push(msg.bytes); size += msg.bytes.length; }
        else if (msg.type === "error" || msg.type === "abort") error = msg;
      }, { connectMs: 3000, answerMs, signal });
      if (!head) return error ? { status: error.status ?? 502, body: "", error: true } : null;
      const all = new Uint8Array(Math.min(size, 64 << 10));
      let at = 0;
      for (const p of parts) { all.set(p.subarray(0, all.length - at), at); at += Math.min(p.length, all.length - at); }
      return { status: head.status, body: new TextDecoder().decode(all) };
    }

    /**
     * A request the page's service worker passed on: { runtime, port, method, path, headers,
     * body, prefix, origin }. Its answer goes to `send` as it comes (preview.js's serve()). Answered
     * only while a preview is open and the person has allowed the page; a machine it reaches is
     * woken if it must be, and held awake (linked) for as long as the preview stays open.
     */
    async function previewRequest(req, send, { signal, waitMs = PREVIEW_WAIT_MS } = {}) {
      const refuse = (status, title, detail) => send({ type: "error", ...Preview.errorPage(status, title, detail, { back: page.href }) });
      if (!state.preview && !links.targets.has(`${req.runtime}:${req.port}`)) return refuse(403, "No preview is open", "This address shows a machine's server only while the agent page has a preview open: open one there (Open preview, or the open_preview tool).");
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

    /**
     * A WebSocket a page in the preview opened to a machine: preview-hook.js's shim, for a url under
     * the page's preview/<runtime>/<port>/ (a service worker can't take a WebSocket, so the preview's
     * page asks this page over a MessageChannel instead). `req` is { url (same origin, http(s)),
     * protocols }; `port` the channel's end. The WebSocket itself (handshake, frames) is spoken here
     * (ws-client.js) over a TCP connection into the machine (host.tcpOpen); the shim gets what it
     * says already decoded: { type: "taken" } at once, then "open" { protocol, extensions },
     * "message" { data: a string or an ArrayBuffer, handed over }, "sent" { n } (bytes of a message
     * the machine took: the shim's bufferedAmount), "error" { message } and "close" { code, reason,
     * wasClean }, the last thing said. The shim says "send" { data, n }, "close" { code, reason } and
     * "gone" (its page went away).
     *
     * The gate, waking and holding are previewRequest's: a preview open (or the port a link's
     * target) and the person's yes; the machine woken if it must be, and held awake (linked) while
     * the preview stays open; closing the preview closes its sockets (1001). At most
     * MAX_PREVIEW_SOCKETS at once; bytes on their way to the machine beyond MAX_LINK_QUEUED fail it.
     */
    function previewSocket(req, port, { waitMs = PREVIEW_WAIT_MS } = {}) {
      const W = root.SnowglobeWsClient;
      const say = (msg, transfer) => { try { port.postMessage(msg, transfer ?? []); } catch {} };
      let over = false;
      let held = null; // { m, port }: what this socket counts in previewRequest's accounting
      let ws = null;
      const wake = new AbortController();
      const handle = { close: (why) => { if (ws) ws._close(1001, new TextEncoder().encode(why)); else end({ code: 1006, error: why }); } };
      const release = () => {
        previewSockets.delete(handle);
        if (!held) return;
        const { m, port: p } = held;
        held = null;
        const left = (m.inflight.get(p) ?? 1) - 1;
        if (left > 0) m.inflight.set(p, left);
        else m.inflight.delete(p);
        if (left <= 0 && m.previews.get(p) === "linking") m.previews.delete(p);
        m.lastUsed = now();
        if (m.lifecycle.state === "running") m.lifecycle.touch();
        scheduler.notify();
        changed();
      };
      /** Over, once: what the shim hears last, and the hold let go. */
      const end = ({ code = 1006, reason = "", wasClean = false, error = null }) => {
        if (over) return;
        over = true;
        wake.abort();
        if (error) say({ type: "error", message: String(error) });
        say({ type: "close", code, reason, wasClean });
        try { port.onmessage = null; port.close(); } catch {}
        release();
      };
      say({ type: "taken" });
      port.onmessage = ({ data }) => {
        if (over || !data || typeof data !== "object") return;
        if (data.type === "send") {
          if (!ws || ws.readyState !== 1) return;
          const d = data.data;
          if (typeof d !== "string" && !(d instanceof ArrayBuffer)) return;
          const n = typeof d === "string" ? W.byteLength(d) : d.byteLength;
          ws.send(d).then(() => { if (!over) say({ type: "sent", n }); });
          if (ws.bufferedAmount > MAX_LINK_QUEUED) ws._fail(1008, `more than ${MAX_LINK_QUEUED} bytes on their way to ${held?.m.name ?? "the machine"}`);
        } else if (data.type === "close") {
          if (!ws) return end({ code: 1006, error: "closed before it connected" });
          try { ws.close(data.code ?? undefined, data.reason ?? undefined); } catch { ws.close(); }
        } else if (data.type === "gone") {
          if (ws) ws._close(1001, new TextEncoder().encode("the page went away"));
          else end({ code: 1006, error: "the page went away" });
        }
      };
      if (!W) return end({ error: "the page has no WebSocket client (ws-client.js)" });
      let r = null;
      try { r = Preview.route(new URL(String(req?.url)), page); } catch {}
      if (!r || r.error) return end({ error: r?.error ?? `not an address under this page's preview/: ${String(req?.url).slice(0, 200)}` });
      let protocols;
      try { protocols = W.checkProtocols(req.protocols ?? []); } catch (e) { return end({ error: String(e?.message ?? e) }); }
      if (!state.preview && !links.targets.has(`${r.runtime}:${r.port}`)) return end({ error: "no preview is open: this address reaches a machine's server only while the page has a preview open" });
      if (!granted()) return end({ error: "the person at the page hasn't allowed its machines to run yet" });
      let m;
      try { m = get(r.runtime); } catch (e) { return end({ error: String(e?.message ?? e) }); }
      if (!m.network) return end({ error: `${m.name} has no network device: nothing in it can be connected to` });
      if (previewSockets.size >= MAX_PREVIEW_SOCKETS) return end({ error: `at most ${MAX_PREVIEW_SOCKETS} WebSockets from the preview at once` });
      previewSockets.add(handle);
      held = { m, port: r.port };
      m.inflight.set(r.port, (m.inflight.get(r.port) ?? 0) + 1);
      if (!m.previews.has(r.port)) {
        m.previews.set(r.port, "linking");
        changed();
      }
      (async () => {
        try {
          await awake(m, wake.signal, { waitMs, preview: true });
        } catch (e) {
          return end({ error: e?.name === "TimeoutError" ? `no machine slot free: ${e?.message ?? e}` : `${m.name} is not running: ${e?.message ?? e}` });
        }
        if (over) return;
        const host = m.host;
        if (!host) return end({ error: `${m.name} is not running` });
        m.lastUsed = now();
        m.lifecycle.touch();
        m.dirty = true; // whatever comes over it may change the machine
        // The server sees the page's own origin, and a Host on the machine (as the preview's HTTP does)
        try {
          ws = new W.WebSocketClient(r.prefix + r.path, protocols, { base: page.href, connect: () => host.tcpOpen(r.port), host: `localhost:${r.port}`, path: r.path, origin: page.origin });
        } catch (e) {
          return end({ error: String(e?.message ?? e) });
        }
        ws.binaryType = "arraybuffer";
        let failed = false;
        ws.onopen = () => {
          if (m.previews.get(r.port) === "linking") {
            m.previews.set(r.port, "linked");
            changed();
          }
          say({ type: "open", protocol: ws.protocol, extensions: ws.extensions });
        };
        ws.onmessage = ({ data }) => {
          if (typeof data === "string") say({ type: "message", data });
          else say({ type: "message", data }, [data]);
        };
        ws.onerror = () => { failed = true; };
        ws.onclose = ({ code, reason, wasClean }) => end({ code, reason, wasClean, error: failed ? `${m.name}'s port ${r.port}: ${ws.failure ?? "the connection failed"}` : null });
      })();
      return handle;
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
          features: ["listRuntimes", "runCommand", "readJob", "cancelJob", "writeFile", "writeFiles", "readFiles", "listFiles", "revert", "runSql", "buildStatus", "copyFile", "suspend", "wake", "startFresh", "setAwakeLimit", "openPreview", "closePreview"],
          maxWriteBytes: MAX_WRITE,
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
      writeFile,
      writeFiles,
      readFiles,
      listFiles,
      revert,
      runSql,
      buildStatus,
      copyFile,
      async cancelCopy(id) {
        for (const [k, c] of copies) if (id === undefined || k === id) c.abort();
        return true;
      },
      async suspend(runtime) { return scheduler.suspend(get(runtime), "asked"); },
      /**
       * The links between machines, whole: [{ from, to, port, as, as_port? }]. The guest of `from`
       * then reaches `as` (feed.internal) as `to`'s server on `port`: its HTTP to `as` (ports 80 and
       * 443, fetch()), and its plain TCP to `as`:`as_port` (default: `port`; any port but 80 and
       * 443, which armless keeps for HTTP), carried by the page. The page answers those without a
       * preview open. When one name has several links, its HTTP goes to the first declared. A
       * machine's links are read when it wakes, so one that is awake with other links is suspended
       * (woken again by its next use). Resolves with the machines it suspended.
       */
      async setLinks(list = []) {
        if (!Array.isArray(list)) throw new Error("setLinks: [{ from, to, port, as, as_port? }]");
        const byMachine = new Map();
        const targets = new Set();
        for (const l of list) {
          const from = get(l.from);
          const to = get(l.to);
          const port = Preview.checkPort(l.port);
          if (from === to) throw new Error(`a machine can't link to itself (${from.name})`);
          if (!from.network) throw new Error(`${from.name} has no network device, so it can't connect to ${to.name}`);
          if (!to.network) throw new Error(`${to.name} has no network device, so nothing can connect to it`);
          if (typeof l.as !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(l.as) || /^[0-9.]+$/.test(l.as)) throw new Error(`as: a host name like feed.internal, not ${JSON.stringify(l.as)}`);
          let asPort = port;
          if (l.as_port !== undefined && l.as_port !== null) {
            try { asPort = Preview.checkPort(l.as_port); } catch { throw new Error(`as_port: the port ${from.name}'s guest connects to, 1 to 65535, not ${JSON.stringify(l.as_port)}`); }
          }
          const mine = byMachine.get(from.name) ?? { names: Object.create(null), tunnels: [] };
          if (mine.tunnels.some((t) => t.host === l.as && t.port === asPort)) throw new Error(`${from.name} links ${l.as}:${asPort} twice`);
          if (!Object.hasOwn(mine.names, l.as)) mine.names[l.as] = { runtime: to.name, port };
          mine.tunnels.push({ host: l.as, port: asPort, runtime: to.name, to: port });
          byMachine.set(from.name, mine);
          targets.add(`${to.name}:${port}`);
        }
        const key = (l) => JSON.stringify(l ? [Object.entries(l.names).sort(), l.tunnels] : null);
        const stale = machines.filter((m) => m.host && key(links.byMachine.get(m.name)) !== key(byMachine.get(m.name)));
        for (const m of stale) if (m.busy()) throw new Error(`${m.name} is busy: wait for it, then set the links again`);
        links.byMachine = byMachine;
        links.targets = targets;
        for (const m of stale) await scheduler.suspend(m, "asked");
        changed();
        return stale.map((m) => m.name);
      },
      async wake(runtime) { await awake(get(runtime)); return true; },
      async recoverFiles(runtime) {
        const m = get(runtime);
        return serial(m, async () => {
          if (m.busy()) throw new Error("wait for the active operation before restoring environment files");
          m.starting++;
          changed();
          try {
            await awake(m);
            return await m.host.recoverFiles();
          } finally {
            m.starting = down(m.starting);
            m.lifecycle.touch();
            changed();
          }
        });
      },
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
      previewSocket,
      previewGet,
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
    // Parent-owned interactive tools hold a running VM while their connection is open.
    Object.defineProperty(api, "_hold", { value(runtime) {
      const m = get(runtime);
      if (!m.host || m.lifecycle.state !== "running") throw new Error("Wake the VM before holding it");
      m.holds++;
      let released = false;
      return () => { if (released) return; released = true; m.holds = down(m.holds); if (m.lifecycle.state === "running") m.lifecycle.touch(); scheduler.notify(); changed(); };
    } });
    Object.defineProperty(api, "_status", { value: status });
    Object.defineProperty(api, "_describe", { value: describe });
    return api;
  }

  const SnowglobeOrchestrator = { createAgents, SaveSlot };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeOrchestrator;
  else root.SnowglobeOrchestrator = SnowglobeOrchestrator;
})(typeof window !== "undefined" ? window : globalThis);
