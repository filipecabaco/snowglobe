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
// says (progress, console, stop, error, job, xfer).
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
  function worker(config, emit, uploadWindow, scripts, timeouts, Worker = root.Worker) {
    let w = null;
    let started = null;
    let next = 1;
    const pending = new Map();
    const rejectAll = (why) => {
      for (const { reject } of pending.values()) reject(why);
      pending.clear();
    };
    const post = (msg, transfer) => w.postMessage(msg, transfer ?? []);
    const request = (op, args = []) => new Promise((resolve, reject) => {
      const id = next++;
      pending.set(id, { resolve, reject });
      try { post({ id, op, args }); } catch (e) { pending.delete(id); reject(e); }
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
      rejectAll(why ?? errorFrom({ name: "AbortError", message: "the machine was put away" }));
    };
    return {
      call: async (op, args = []) => {
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
        return request(op, args);
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
    const t = transport === "worker" ? worker(cfg, emit, uploadWindow, scripts, limits, Worker ?? root.Worker) : inline(cfg, emit, uploadWindow, limits);
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
      destroy: () => t.call("destroy"),
      memory: () => t.call("memory"),
      runCommand: (input) => t.call("runCommand", [input]),
      readJob: (id) => t.call("readJob", [id]),
      cancelJob: (id) => t.call("cancelJob", [id]),
      status: () => t.call("status"),
      /** { blob, size, sha256 } of a file in the machine. */
      readFile: (path, opts) => xfer("readFile", [path], opts),
      /** { size, sha256 }: `blob` written to `path` in the machine. */
      writeFile: (path, blob, opts = {}) => xfer("writeFile", [path, blob, opts.sha256], opts),
      /** The armless machine itself, in this thread only (inline). */
      get emulator() { return t.emulator; },
    };
  }

  const SnowglobeHost = { createMachine, within, TIMEOUTS };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeHost;
  else root.SnowglobeHost = SnowglobeHost;
})(typeof window !== "undefined" ? window : globalThis);
