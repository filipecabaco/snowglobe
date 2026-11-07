// A machine in a dedicated Web Worker of its own: machine-core.js behind a small message protocol,
// so a page of several machines runs each on a core of its own, and its main thread (the UI, the
// terminal) never waits for one. machine-host.js is the page's side.
//
// The page sends { id, op, args }, and { op, args } (no reply) for console input and size; the
// worker answers { id, result } or { id, error: { name, message } }, and says what the machine
// does as { event, payload }. The first op is init: the scripts to load (absolute URLs: armless.js
// from the machine's site, and this page's own) and the machine's configuration. Putting the
// machine away is ending the worker: its memory goes with it.
"use strict";

let core = null;
const OPS = new Set(["boot", "run", "input", "resize", "capture", "destroy", "memory", "runCommand", "readJob", "cancelJob", "status",
  "readFile", "writeFile", "abort"]);

function emit(event, payload) {
  if (event === "console" && payload instanceof Uint8Array) {
    // A copy of just these bytes (the machine's may be a view into its memory), handed over
    const copy = payload.slice();
    self.postMessage({ event, payload: copy }, [copy.buffer]);
    return;
  }
  self.postMessage({ event, payload });
}

self.onmessage = async ({ data }) => {
  const { id, op, args = [] } = data ?? {};
  try {
    let result;
    if (op === "init") {
      if (core) throw new Error("already started");
      const [{ scripts, config, uploadWindow }] = args;
      // The site's own scripts only
      for (const url of scripts) {
        if (new URL(url).origin !== self.location.origin) throw new Error(`refusing a script from another origin: ${url}`);
      }
      importScripts(...scripts);
      core = new self.SnowglobeMachineCore.Core({ config, emit, uploadWindow });
      result = true;
    } else {
      if (!core) throw new Error("not started");
      if (!OPS.has(op)) throw new Error(`no such operation: ${op}`);
      result = await core[op](...args);
    }
    if (id !== undefined) self.postMessage({ id, result });
  } catch (e) {
    if (id !== undefined) self.postMessage({ id, error: { name: e?.name ?? "Error", message: String(e?.message ?? e) } });
    else emit("error", { name: e?.name ?? "Error", message: String(e?.message ?? e) });
  }
};
