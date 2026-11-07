// One machine's own side: the armless machine itself, the warm pack that fills its file cache, its
// captured state, and (with agent.js loaded) the serial job runner and the file
// transfer over it. It runs wherever the machine runs: in the page (the terminal pages), or in a
// dedicated Web Worker of its own (the agent page, machine-worker.js), so that machines run on
// cores of their own and the page stays responsive. It never touches the DOM.
//
// What it says goes out through `emit(event, payload)`: progress ({file, loaded, total}), console
// (bytes), stop ({reason}), error ({name, message}), job ({jobId, state}: a job ended), xfer
// ({xid, phase, done, total}: a file transfer's progress), blobs ({ok, url, message}: the blob store the
// guest's files come from stopped or started answering), tcp ({sid, kind, bytes}: a connection
// into the machine, tcpOpen()).
(function (root) {
  "use strict";

  const errorOf = (e) => ({ name: e?.name ?? "Error", message: String(e?.message ?? e) });

  /** The machine's files as absolute URLs against `base` (the site's directory): armless loads
   *  some of them away from this script (the blobs, in a worker), where a relative URL would
   *  resolve against the wrong place. */
  function located(base, o) {
    const at = (url) => typeof url === "string" ? new URL(url, base).href : url;
    const r = { ...o, wasm: at(o.wasm), wasm_smp: at(o.wasm_smp), initial_state: at(o.initial_state),
      filesystem: { json: at(o.filesystem.json), baseurl: at(o.filesystem.baseurl) } };
    if (o.network) r.network = { ...o.network, tls: at(o.network.tls) };
    if (o.warm) r.warm = at(o.warm);
    return r;
  }

  // Request headers a package manager adds that only hint (caching, npm's and pacote's bookkeeping,
  // its user agent). None is CORS-safelisted, so with any of them the browser preflights the request,
  // and package registries (registry.npmjs.org answers OPTIONS with 404) refuse the preflight; with
  // them gone a GET is simple and goes through. Dropping them changes no answer. (web's npm also goes
  // through a relay that sends only Accept, examples/web/serve.mjs; this covers npm pointed at the
  // registry itself, and pnpm or yarn.)
  const DROPPED = /^(cache-control|pragma|user-agent|npm-[\w-]+|pacote-[\w-]+)$/i;

  /** The page's fetch() as the guest's network uses it: without the headers in DROPPED. */
  function guestFetch(url, init) {
    if (init?.headers) {
      const headers = new Headers(init.headers);
      for (const name of [...headers.keys()]) if (DROPPED.test(name)) headers.delete(name);
      init = { ...init, headers };
    }
    return fetch(url, init);
  }

  class Core {
    /**
     * `config` is armless's options with absolute URLs (located()), plus `warm` (the warm pack's
     * URL). `Armless` the class; `emit(event, payload)` where what it says goes.
     */
    constructor({ config, Armless = root.Armless, emit = () => {}, agent = root.SnowglobeAgent, transfer = root.SnowglobeTransfer,
      sessions = root.SnowglobeSessions, uploadWindow = 1 }) {
      this.config = config;
      this.Armless = Armless;
      this.emit = emit;
      this.sessions = sessions;
      this.vm = null;
      this.state = "idle"; // idle, loading, ready, stopped
      this.capturing = false;
      this.xfers = new Map();
      this.controller = null;
      // The job runner for any machine with agent.js loaded (its Controller says what it supports)
      if (agent) {
        const core = this;
        this.controller = new agent.Controller({ get emulator() { return core.vm; }, cpus: config.cpus, network: config.network ? "fetch" : "none",
          state: () => core.state, saving: () => core.capturing });
        this.controller.uploadWindow = uploadWindow;
        this.controller.finishedListeners.push((job) => emit("job", { jobId: job?.id ?? null, state: job?.state ?? null }));
        this.files = transfer?.overJobs((command, opts) => this._job(command, opts), { token: agent.token });
      }
    }

    /** A new machine from a state (a URL, or a Blob of a captured state packed with `encoding`,
     *  as capture() and saves have it), ready to run(). */
    async boot(initialState, encoding = "raw") {
      if (this.vm) throw new Error("the machine is already booted");
      let url = initialState;
      let made = null;
      if (typeof Blob !== "undefined" && initialState instanceof Blob) {
        const raw = encoding === "raw" ? initialState : await this.sessions.stateBlob({ encoding, state: initialState });
        url = made = URL.createObjectURL(raw);
      }
      this.state = "loading";
      let vm;
      try {
        // The guest's files through fetchBlob, so a blob store that can't be reached is said
        // (the guest only sees an I/O error)
        const filesystem = this.config.filesystem ? { ...this.config.filesystem, fetch_blob: (name) => this.fetchBlob(name) } : undefined;
        const network = this.config.network ? { ...this.config.network, fetch: guestFetch } : undefined;
        vm = new this.Armless({ ...this.config, filesystem, network, warm: undefined, initial_state: url, autostart: false });
        this.vm = vm;
        vm.on("progress", (e) => this.emit("progress", { file: e.file, loaded: e.loaded, total: e.total }));
        vm.on("console", (bytes) => { if (vm === this.vm) this.emit("console", bytes); });
        vm.on("stop", ({ reason }) => {
          if (vm !== this.vm) return;
          this.state = "stopped";
          this.emit("stop", { reason });
        });
        vm.on("error", (e) => { if (vm === this.vm) this.emit("error", errorOf(e)); });
        this.controller?.bind(vm);
        await vm.ready;
      } catch (e) {
        try { vm?.destroy(); } catch {}
        if (this.vm === vm) this.vm = null;
        this.state = "idle";
        throw e;
      } finally {
        if (made) URL.revokeObjectURL(made);
      }
      return true;
    }

    /**
     * One of the guest's files from the blob store (as armless would fetch it). A failure is said
     * once, as a `blobs` event { ok: false, url, message } (url: the store), until a fetch
     * succeeds again ({ ok: true }); it still fails the guest's read, as armless's own would.
     */
    async fetchBlob(name) {
      const base = this.config.filesystem?.baseurl ?? "";
      const url = new URL(name, typeof location !== "undefined" ? new URL(base, location.href) : base).href;
      try {
        const r = await (this.fetch ?? fetch)(url);
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`.trim());
        const bytes = new Uint8Array(await r.arrayBuffer());
        if (this.blobsDown) {
          this.blobsDown = false;
          this.emit("blobs", { ok: true });
        }
        return bytes;
      } catch (e) {
        if (!this.blobsDown) {
          this.blobsDown = true;
          this.emit("blobs", { ok: false, url: base, message: String(e?.message ?? e) });
        }
        throw e;
      }
    }

    /** Run it, and fill its file cache in the background. */
    run() {
      this.vm.run();
      this.state = "ready";
      this.warm().catch(() => {});
      return true;
    }

    input(data) { this.vm?.console_input(data); }
    resize(cols, rows) { this.vm?.console_resize(cols, rows); }

    /** Stop it and capture its state, packed (gzip where the browser can): { encoding, state: Blob }.
     *  It stays stopped (a suspend: destroy() next); keepRunning runs it again (a save). */
    async capture({ keepRunning = false } = {}) {
      const vm = this.vm;
      if (!vm) throw new Error("no machine to capture");
      this.capturing = true;
      try {
        await vm.stop();
        let bytes = await vm.save_state();
        const packed = this.sessions ? await this.sessions.packState(bytes) : { encoding: "raw", state: new Blob([bytes]) };
        bytes = null;
        return packed;
      } catch (e) {
        vm.run();
        throw e;
      } finally {
        this.capturing = false;
        if (keepRunning && this.vm === vm && !vm.running) vm.run();
      }
    }

    /** End the machine (its timers and any workers) and drop it, so its memory can go. */
    destroy() {
      const vm = this.vm;
      // Its connections end first, each said closed (armless's abort() says so at once), so the
      // page hears of every one before the machine goes
      for (const c of [...(this.tcp?.values() ?? [])]) {
        try { c.abort(); } catch {}
      }
      this.vm = null;
      this.state = "idle";
      this.tcp?.clear();
      try { vm?.destroy(); } catch {}
      return vm ? { wasmBytes: vm.memory?.buffer?.byteLength ?? null } : null;
    }

    /** How much memory the machine holds: its WebAssembly memory. */
    memory() {
      return { wasmBytes: this.vm?.memory?.buffer?.byteLength ?? 0 };
    }

    // The guest's files are fetched one blocking request at a time the first time each is read.
    // warm.pack bundles the files the app is most likely to need so they arrive in a single
    // background download and are in the machine before the guest asks for them.
    async warm() {
      const vm = this.vm;
      if (!this.config.warm || !vm) return;
      const response = await fetch(this.config.warm);
      if (!response.ok) return;
      const pack = new Uint8Array(await response.arrayBuffer());
      const indexSize = new DataView(pack.buffer).getUint32(0, true);
      const index = JSON.parse(new TextDecoder().decode(pack.subarray(4, 4 + indexSize)));
      let offset = 4 + indexSize;
      for (const [name, , length] of index) {
        // A machine stopped (suspended) meanwhile takes no more
        if (vm.stopped || vm !== this.vm) return;
        const blob = pack.subarray(offset, offset + length);
        offset += length;
        if (vm.has_blob(name)) continue; // the guest already loaded it
        vm.provide_blob(name, blob);
        // Yield between files so the machine (and a page sharing this thread) stays responsive
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    // ------------------------------------------------------------------ jobs and files

    _agent() {
      if (!this.controller) throw new Error("agent jobs need the agent scripts");
      return this.controller;
    }

    runCommand(input) { return this._agent().runCommand(input); }
    readJob(id) { return this._agent().readJob(id); }
    cancelJob(id) { return this._agent().cancelJob(id); }
    status() { return this._agent().status(); }

    /** A job run to its end: its view. Rejects unless it exited 0; `signal` cancels it. */
    async _job(command, { files, signal } = {}) {
      const c = this._agent();
      const { jobId } = c.runCommand({ command, files, timeoutSeconds: 600 });
      const view = await new Promise((resolve) => {
        const check = () => {
          const v = c.readJob(jobId);
          if (v.state === "running") return false;
          c.finishedListeners.splice(c.finishedListeners.indexOf(listener), 1);
          signal?.removeEventListener?.("abort", abort);
          resolve(v);
          return true;
        };
        const listener = () => check();
        const abort = () => { try { c.cancelJob(jobId); } catch {} };
        c.finishedListeners.push(listener);
        signal?.addEventListener?.("abort", abort);
        check();
      });
      if (view.state === "cancelled") {
        const e = new Error("cancelled");
        e.name = "AbortError";
        throw e;
      }
      if (view.state !== "exited" || view.exitStatus !== 0) {
        const tail = view.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        throw new Error(`a transfer job ${view.state === "exited" ? `exited ${view.exitStatus}` : view.state}${view.error ? `: ${view.error}` : ""}${tail ? ` (${tail})` : ""}`);
      }
      return view;
    }

    _xfer(xid, fn) {
      const controller = new AbortController();
      this.xfers.set(xid, controller);
      return fn({ signal: controller.signal, onProgress: (p) => this.emit("xfer", { xid, ...p }) })
        .finally(() => this.xfers.delete(xid));
    }

    /** { blob, size, sha256 } of a file in the machine. */
    readFile(xid, path) {
      if (!this.files) this._agent();
      return this._xfer(xid, (o) => this.files.read(path, o));
    }

    /** { size, sha256 }: `blob` written to `path` in the machine, checked there before it lands. */
    writeFile(xid, path, blob, sha256) {
      if (!this.files) this._agent();
      return this._xfer(xid, (o) => this.files.write(path, blob, { ...o, sha256 }));
    }

    abort(xid) {
      this.xfers.get(xid)?.abort();
      return true;
    }

    // ------------------------------------------------------------------ TCP into the machine

    /**
     * A TCP connection from the page to `port` on the machine's network address (armless's
     * connect(): a machine with a network device). Its id comes back at once; what happens on it
     * is said as `tcp` events { sid, kind: "connect" | "data" | "end" | "close", bytes? }. A close
     * with no connect before it: nothing listens there.
     */
    tcpOpen(port) {
      const vm = this.vm;
      if (!vm || this.state !== "ready") throw new Error("the machine is not running");
      if (!this.config.network) throw new Error("the machine has no network device, so nothing in it can be connected to");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1 to 65535");
      this.tcp ??= new Map();
      const sid = (this.tcpNext = (this.tcpNext ?? 0) + 1);
      const conn = vm.connect(port);
      this.tcp.set(sid, conn);
      const say = (kind, bytes) => {
        if (vm !== this.vm) return;
        this.emit("tcp", bytes ? { sid, kind, bytes } : { sid, kind });
      };
      conn.on("connect", () => say("connect"));
      // A copy: armless's bytes may be a view into its memory
      conn.on("data", (bytes) => say("data", new Uint8Array(bytes)));
      conn.on("end", () => say("end"));
      conn.on("close", () => {
        this.tcp?.delete(sid);
        say("close");
      });
      return sid;
    }

    tcpWrite(sid, bytes) {
      const c = this.tcp?.get(sid);
      if (!c) throw new Error(`no connection ${sid}`);
      c.write(bytes);
      return true;
    }

    /** Close the page's side, after what was written. */
    tcpEnd(sid) {
      this.tcp?.get(sid)?.close();
      return true;
    }

    tcpAbort(sid) {
      const c = this.tcp?.get(sid);
      this.tcp?.delete(sid);
      try { c?.abort(); } catch {}
      return true;
    }
  }

  const SnowglobeMachineCore = { Core, located, errorOf, guestFetch };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeMachineCore;
  else root.SnowglobeMachineCore = SnowglobeMachineCore;
})(typeof window !== "undefined" ? window : globalThis);
