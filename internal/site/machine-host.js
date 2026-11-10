// createMachine: one machine of a site, for a page. The terminal pages make one; the agent page
// (/agent/) makes one per runtime. Every file of the machine is an absolute URL against its site's
// directory (`base`), so a page anywhere can run any site's machine.
//
// The machine runs where `transport` says:
//  - "inline": in this page's own thread (machine-core.js loaded here). The terminal pages: one
//    machine, and their workspace saves reach into it directly (host.emulator);
//  - "worker": in a dedicated Web Worker (machine-worker.js), the page talking to it in messages.
//    The agent page: several machines on cores of their own, the page responsive whatever they
//    do, and putting one away ends its worker, which frees its memory at once.
// Either way the page sees the same thing: promises for what it asks, events for what the machine
// says (progress, console, stop, error, job, xfer, link: a TCP connection the guest opened over a
// link, answered with linkIn()).
(function (root) {
  "use strict";

  const Core = () => root.SnowglobeMachineCore;

  // How long the page waits for a machine before it gives up on it: a destroy that doesn't answer
  // ends the worker anyway; a capture that doesn't (they take about 1 s) ends it, and the machine
  // fails rather than holding up every other machine's suspend and wake
  const TIMEOUTS = { destroy: 2000, capture: 15000 };

  function errorFrom(e) {
    const err = new Error(e?.message ?? String(e));
    if (e?.name) err.name = e.name;
    if (e?.fatal) err.fatal = true;
    return err;
  }

  /** `p`, or a TimeoutError once `ms` has gone by (then `onTimeout()`). */
  function within(p, ms, what, onTimeout, timers = root) {
    if (!(ms > 0)) return p;
    let timer = null;
    const late = new Promise((_, reject) => {
      timer = timers.setTimeout(() => {
        const e = new Error(`the machine did not answer ${what} within ${Math.round(ms / 100) / 10} s`);
        e.name = "TimeoutError";
        e.fatal = true;
        try { onTimeout?.(); } catch {}
        reject(e);
      }, ms);
    });
    return Promise.race([p, late]).finally(() => timers.clearTimeout(timer));
  }

  /** In this thread: the core itself, behind promises. */
  function inline(config, emit, uploadWindow, timeouts) {
    let core = null;
    const make = () => (core ??= new (Core().Core)({ config, emit, uploadWindow }));
    return {
      call: async (op, args = []) => {
        if (op === "destroy") {
          const r = core?.destroy() ?? null;
          return r;
        }
        if (op === "capture") return within(make().capture(...args), timeouts.capture, "a capture", () => core?.destroy());
        return make()[op](...args);
      },
      send: (op, args = []) => { if (core) core[op](...args); },
      get emulator() { return core?.vm ?? null; },
      end() { core?.destroy(); },
    };
  }

  /** In a worker of its own, started at boot and ended when the machine is put away. */
  function worker(config, emit, uploadWindow, scripts, timeouts, Worker = root.Worker, onEnd = () => {}) {
    let w = null;
    let started = null;
    let next = 1;
    const pending = new Map();
    const rejectAll = (why) => {
      for (const { reject } of pending.values()) reject(why);
      pending.clear();
    };
    const post = (msg, transfer) => w.postMessage(msg, transfer ?? []);
    const request = (op, args = [], transfer) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      try { post({ id, op, args }, transfer); } catch (e) { pending.delete(id); reject(e); }
    });
    const start = () => {
      if (started) return started;
      w = new Worker(scripts.worker, { name: config.name ?? "snowglobe machine" });
      w.onmessage = ({ data }) => {
        if (data?.event) return emit(data.event, data.payload);
        const p = pending.get(data?.id);
        if (!p) return;
        pending.delete(data.id);
        if (data.error) p.reject(errorFrom(data.error));
        else p.resolve(data.result);
      };
      w.onerror = (e) => {
        e.preventDefault?.();
        // A worker that threw is not trusted to go on: it is ended (its memory with it), and
        // whatever waited on it fails, as the machine does
        const err = errorFrom({ name: /memory/i.test(e.message ?? "") ? "RangeError" : "Error", fatal: true,
          message: `the machine's worker stopped: ${e.message || "an error in the worker"}` });
        end(err);
        emit("error", { name: err.name, message: err.message, fatal: true });
      };
      started = request("init", [{ scripts: scripts.core, config, uploadWindow }]);
      return started;
    };
    const end = (why) => {
      if (!w) return;
      w.terminate();
      w = null;
      started = null;
      const err = why ?? errorFrom({ name: "AbortError", message: "the machine was put away" });
      rejectAll(err);
      // Its connections went with it: whoever reads them hears so
      try { onEnd(err); } catch {}
    };
    return {
      call: async (op, args = [], transfer) => {
        if (op === "destroy") {
          if (!w) return null;
          let r = null;
          // A worker that doesn't answer is ended all the same
          try { r = await within(request("destroy"), timeouts.destroy, "its end"); } catch {}
          end();
          return r;
        }
        if (op === "capture") {
          if (!w) throw errorFrom({ message: "the machine is not running", fatal: true });
          await started;
          return within(request(op, args), timeouts.capture, "a capture", () => end(errorFrom({ name: "TimeoutError", message: "the capture timed out", fatal: true })));
        }
        if (op === "boot") {
          try {
            await start();
            return await request(op, args);
          } catch (e) {
            // A machine that could not start leaves no worker holding memory
            end();
            throw e;
          }
        }
        if (!w) throw new Error("the machine is not running");
        await started;
        // Ended while it waited: nothing to hand anything to
        if (!w) throw new Error("the machine is not running");
        return request(op, args, transfer);
      },
      send: (op, args = []) => { if (w) post({ op, args }); },
      get emulator() { return null; },
      get alive() { return !!w; },
      end,
    };
  }

  /**
   * One machine. `base`: the site's directory (absolute). `config`: armless's options, relative
   * to base (wasm, filesystem, initial state, network), plus warm (the warm pack). `transport`:
   * "inline" or "worker"; a worker needs `scripts` { worker: URL of machine-worker.js, core: [URLs
   * it loads: armless.js, then machine-core.js and what it uses] }.
   */
  function createMachine({ base, config, transport = "inline", scripts, uploadWindow = 1, timeouts = {}, Worker }) {
    const cfg = Core()?.located ? Core().located(base, config) : config;
    const limits = { ...TIMEOUTS, ...timeouts };
    const listeners = new Map();
    const emit = (event, payload) => {
      for (const fn of listeners.get(event) ?? []) {
        try { fn(payload); } catch (e) { setTimeout(() => { throw e; }); }
      }
    };
    // Connections into the machine, by id: what the machine says about each goes to its stream.
    // Ids are given in the order asked (the machine's side numbers them as the opens arrive), so an
    // event for an id at or below the highest known one that has no stream is for a connection
    // already over (aborted here, say): dropped. Only an id not known yet waits, in `early`
    const streams = new Map();
    const early = new Map();
    let known = 0;
    /** Every open connection ends with `why`: the machine (its worker) is gone. */
    const dropStreams = (why) => {
      for (const s of [...streams.values()]) s.fail(why);
      streams.clear();
      early.clear();
      // And every link connection its guest had opened: whoever carried them lets go (said on
      // every end, a worker that crashed or never answered its destroy included; saying it twice is
      // harmless)
      emit("link", { kind: "gone" });
    };
    const t = transport === "worker"
      ? worker(cfg, emit, uploadWindow, scripts, limits, Worker ?? root.Worker, dropStreams)
      : inline(cfg, emit, uploadWindow, limits);
    let xid = 0;
    const xfer = (op, args, { signal, onProgress } = {}) => {
      const id = `x${++xid}`;
      const off = onProgress ? on("xfer", (p) => { if (p.xid === id) onProgress(p); }) : () => {};
      const abort = () => { t.call("abort", [id]).catch(() => {}); };
      signal?.addEventListener?.("abort", abort);
      if (signal?.aborted) abort();
      return t.call(op, [id, ...args]).finally(() => {
        off();
        signal?.removeEventListener?.("abort", abort);
      });
    };
    function on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event).delete(fn);
    }
    on("tcp", (e) => {
      const s = streams.get(e.sid);
      if (s) s.hear(e);
      else if (e.sid > known) {
        if (!early.has(e.sid)) early.set(e.sid, []);
        early.get(e.sid).push(e);
      }
    });
    /**
     * A TCP connection to `port` on the machine's network address: { onconnect, ondata(bytes),
     * onend, onclose, onerror(e), write(bytes), end(), abort() }, the callbacks set by whoever uses
     * it. A close with no connect before it: nothing listens there.
     */
    function tcpOpen(port) {
      let sid = null;
      let closed = false;
      let chain;
      const s = {
        onconnect: null, ondata: null, onend: null, onclose: null, onerror: null,
        hear(e) {
          if (closed) return;
          if (e.kind === "connect") s.onconnect?.();
          else if (e.kind === "data") s.ondata?.(e.bytes);
          else if (e.kind === "end") s.onend?.();
          else if (e.kind === "close") {
            closed = true;
            streams.delete(sid);
            s.onclose?.();
          }
        },
        /** The machine went away under it: an error, once. */
        fail(why) {
          if (closed) return;
          closed = true;
          if (sid !== null) streams.delete(sid);
          s.onerror?.(why ?? new Error("the machine was put away"));
        },
        /** Resolves once the machine's guest has taken most of it (false if it never got there):
         *  what a writer counts to know how much is still on its way. */
        write(bytes) {
          let done = Promise.resolve(false);
          chain = chain.then((id) => { if (!closed) done = t.call("tcpWrite", [id, bytes]).then(() => true, () => false); return id; });
          return chain.then(() => done, () => false);
        },
        end() { chain = chain.then((id) => { if (!closed) t.call("tcpEnd", [id]).catch(() => {}); return id; }); },
        abort() {
          if (closed) return;
          closed = true;
          if (sid !== null) streams.delete(sid);
          chain.then((id) => { streams.delete(id); early.delete(id); t.call("tcpAbort", [id]).catch(() => {}); }, () => {});
        },
      };
      chain = t.call("tcpOpen", [port]).then((id) => {
        sid = id;
        if (id > known) known = id;
        const heard = early.get(id) ?? [];
        early.delete(id);
        // Aborted before its id came back: nothing to hear, and nothing kept for it
        if (closed) return id;
        streams.set(id, s);
        for (const e of heard) s.hear(e);
        return id;
      });
      chain.catch((e) => {
        if (closed) return;
        closed = true;
        s.onerror?.(e);
      });
      return s;
    }
    return {
      transport,
      config: cfg,
      on,
      /** Boot from a state: a URL (default: the site's snapshot), or a captured Blob and its encoding. */
      boot: (state = cfg.initial_state, encoding = "raw") => t.call("boot", [state, encoding]),
      run: () => t.call("run"),
      input: (data) => t.send("input", [data]),
      resize: (cols, rows) => t.send("resize", [cols, rows]),
      /** { encoding, state: Blob }: its state, captured (stopped, unless keepRunning). */
      capture: (opts) => t.call("capture", [opts ?? {}]),
      /** End it and let its memory go. */
      destroy: () => t.call("destroy").finally(() => dropStreams(errorFrom({ name: "AbortError", message: "the machine was put away" }))),
      memory: () => t.call("memory"),
      /** What the memory holds, for memory-debug.js: { report, samples, info }, or null. */
      memoryReport: () => t.call("memoryReport"),
      runCommand: (input) => t.call("runCommand", [input]),
      readJob: (id) => t.call("readJob", [id]),
      cancelJob: (id) => t.call("cancelJob", [id]),
      status: () => t.call("status"),
      /** { blob, size, sha256 } of a file in the machine. */
      readFile: (path, opts) => xfer("readFile", [path], opts),
      /** { size, sha256 }: `blob` written to `path` in the machine. */
      writeFile: (path, blob, opts = {}) => xfer("writeFile", [path, blob, opts.sha256], opts),
      tcpOpen,
      /**
       * Answer a TCP connection the guest opened over a link (a `link` event { cid, kind: "open",
       * runtime, port }, then data, end and close): `kind` "connect", "data" (`bytes`, a Uint8Array
       * handed over: not to be used after), "end", "close" or "error". Resolves once the machine has
       * it; rejects if the machine is gone. A `link` event { kind: "gone" } says every connection
       * its guest had open is over (the machine ended).
       */
      linkIn(cid, kind, bytes) {
        if (bytes === undefined) return t.call("linkIn", [cid, kind]);
        // Only a buffer of its own is handed over whole
        const own = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && !(typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer);
        const b = own ? bytes : bytes.slice();
        return t.call("linkIn", [cid, kind, b], transport === "worker" ? [b.buffer] : undefined);
      },
      /** The armless machine itself, in this thread only (inline). */
      get emulator() { return t.emulator; },
      /** Connections it is tracking (live, and events waiting for an id): for tests. */
      get _tcpTracked() { return streams.size + early.size; },
    };
  }

  const SnowglobeHost = { createMachine, within, TIMEOUTS };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeHost;
  else root.SnowglobeHost = SnowglobeHost;
})(typeof window !== "undefined" ? window : globalThis);
