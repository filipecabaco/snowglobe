// window.snowglobeAgent as WebMCP tools (https://github.com/webmachinelearning/webmcp), for any
// client that reads a page's tools: a browser's own agent, an extension, a chat page. Registered
// with document.modelContext (navigator.modelContext in earlier drafts) .registerTool(tool,
// { signal, exposedTo }), or, where only the first drafts' shape is there, .provideContext({ tools }).
// A model context that an extension or a polyfill (MCP-B's @mcp-b/global, say) adds after the page
// starts is still found, for a while; a page that never gets one registers nothing.
//
// One set of tools for every machine of the page (/agent/), registered once, each executing through
// one dispatch map: list_runtimes says what machines there are and their state; run_command starts
// a job in one (by runtime) and returns its id; job_status reads its state and output, which ends
// as `snowglobe mcp`'s run_command does natively ([exit N], [timed out], [stopped]); cancel_job
// stops it; copy_file copies a file from one machine to another; set_awake_limit says how many
// machines may be awake at once. The first run or copy asks the person at the page, once for the
// page load (and window.snowglobeAgent asks the same question, whoever calls it).
(function (root) {
  "use strict";

  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  const fail = (e) => text(String(e?.message ?? e), true);

  const jobIdOf = (input) => {
    const id = input?.job_id;
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw new Error("job_id: the id run_command returned");
    return id;
  };
  const runtimeOf = (input, key = "runtime") => {
    const r = input?.[key];
    if (typeof r !== "string" || !r) throw new Error(`${key}: a runtime's name, as list_runtimes gives it`);
    return r;
  };
  const pathOf = (input, key) => {
    const p = input?.[key];
    if (typeof p !== "string" || !p.trim()) throw new Error(`${key}: a file path in the machine`);
    return p;
  };
  const kb = (bytes, seconds) => !(seconds > 0) ? "-" : bytes / seconds < 1024 ? `${Math.round(bytes / seconds)} bytes/s` : `${Math.round(bytes / 1024 / seconds)} KiB/s`;

  /**
   * The tools, one set for every machine of the page: their definitions and one dispatch map.
   * `agent` is the page's window.snowglobeAgent (listRuntimes, runCommand, readJob, cancelJob,
   * copyFile); `jobText` how a job reads; `ask` the page's consent, asked before anything runs.
   */
  function definitions(agent, { jobText, ask }) {
    return {
      list_runtimes: {
        title: "The machines and their state",
        description: "The Linux machines (arm64, one CPU each) this page runs in the browser tab: each one's runtime name, what it is good for, " +
          "its state (asleep, waking, awake, busy, suspending, failed) and a sample command. A machine boots or wakes on its first command; " +
          "only a few are awake at once (awake_limit; set_awake_limit changes it), and the least recently used idle one is suspended (its files kept) to wake another.",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
        async run() {
          const list = await agent.listRuntimes();
          const st = await agent.capabilities();
          return text(JSON.stringify({ runtimes: list, awake: st.awake, awake_limit: st.awakeLimit, ...(st.overLimit ? { over_limit: st.overLimit } : {}) }, null, 2));
        },
      },
      run_command: {
        title: "Run a command",
        description: "Start a shell command (/bin/sh, as root) in one of the page's machines (runtime, from list_runtimes), and return its job id " +
          "at once. Poll job_status with that id for its output and exit status. One job at a time in each machine; each starts in the home " +
          "directory (/root), so relative paths work, and files persist between jobs. An asleep machine is woken (or booted) first. " +
          "Give request_id to make a retry safe: the same id returns the same job.",
        inputSchema: {
          type: "object",
          properties: {
            runtime: { type: "string", description: "The machine: a runtime name from list_runtimes (python, duckdb, postgres...)" },
            command: { type: "string", description: "The command line" },
            timeout_seconds: { type: "number", description: "Kill it, and everything it started, after this long (default 300, at most 3600)" },
            request_id: { type: "string", description: "Optional: a retry with the same id returns the original job instead of running it twice" },
          },
          required: ["runtime", "command"],
        },
        annotations: { readOnlyHint: false, consequentialHint: true },
        async run(input, options) {
          const runtime = runtimeOf(input);
          const { command, timeout_seconds, request_id } = input;
          if (typeof command !== "string" || !command.trim()) throw new Error("command: a non-empty string");
          if (timeout_seconds !== undefined && (typeof timeout_seconds !== "number" || !Number.isFinite(timeout_seconds) || timeout_seconds < 0)) {
            throw new Error("timeout_seconds: a number of seconds, 0 or more");
          }
          if (request_id !== undefined && typeof request_id !== "string") throw new Error("request_id: a string");
          await ask(options);
          const { jobId } = await agent.runCommand({ runtime, command, timeoutSeconds: timeout_seconds, requestId: request_id }, { source: "webmcp" });
          return text(`job ${jobId} started in ${runtime}; call job_status with job_id "${jobId}" for its output`);
        },
      },
      job_status: {
        title: "A job's status and output",
        description: "A job's state (running, exited, timed_out, cancelled, failed) and its output so far. A finished job's output ends with " +
          "[exit N], [timed out] or [stopped]; a running one's with [running]. Output beyond 1 MiB keeps the most recent part and says so.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string", description: "The id run_command returned" } },
          required: ["job_id"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async run(input) {
          const v = await agent.readJob(jobIdOf(input));
          return text(jobText(v), v.state === "failed" || (v.state === "exited" && v.exitStatus !== 0) || v.state === "timed_out");
        },
      },
      cancel_job: {
        title: "Cancel a job",
        description: "Stop a running job: its machine kills its command and everything it started. Returns the job's status, as job_status does.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string", description: "The id run_command returned" } },
          required: ["job_id"],
        },
        annotations: { readOnlyHint: false },
        async run(input) {
          return text(jobText(await agent.cancelJob(jobIdOf(input))));
        },
      },
      copy_file: {
        title: "Copy a file between machines",
        description: "Copy one file from a path in one machine to a path in another (or the same one), byte for byte (binary is fine), " +
          "in turn with what else runs in those machines, " +
          "checked by sha256 on both ends; the target is replaced only once the copy checks out, and its directory is made. Files of at " +
          "most 8 MiB. It goes over the machines' serial lines, so it takes a while: tens of KiB a second. Relative paths start in /root.",
        inputSchema: {
          type: "object",
          properties: {
            from_runtime: { type: "string", description: "The machine to copy from (list_runtimes)" },
            from_path: { type: "string", description: "The file there, e.g. /root/data.csv" },
            to_runtime: { type: "string", description: "The machine to copy to" },
            to_path: { type: "string", description: "Where it goes there, e.g. /root/data.csv" },
          },
          required: ["from_runtime", "from_path", "to_runtime", "to_path"],
        },
        annotations: { readOnlyHint: false, consequentialHint: true },
        async run(input, options) {
          const req = { fromRuntime: runtimeOf(input, "from_runtime"), fromPath: pathOf(input, "from_path"),
            toRuntime: runtimeOf(input, "to_runtime"), toPath: pathOf(input, "to_path") };
          await ask(options);
          // A client that can cancel a call passes its signal: the copy stops, and nothing lands
          const r = await agent.copyFile(req, { signal: options?.signal, source: "webmcp" });
          return text(`copied ${r.bytes} bytes from ${req.fromRuntime}:${req.fromPath} to ${req.toRuntime}:${req.toPath}; ` +
            `sha256 ${r.sha256}, the same on both ends. Read ${kb(r.bytes, r.readSeconds)}, wrote ${kb(r.bytes, r.writeSeconds)}.`);
        },
      },
      set_awake_limit: {
        title: "Set how many machines are awake at once",
        description: "How many of the page's machines may be awake at once, 1 to 8 (2 by default), for this page load. Each awake machine " +
          "holds about 650 to 720 MB of the browser's memory. Raise it to keep several machines warm for work that goes back and forth between " +
          "them; lower it to free memory: idle machines are suspended (their files kept), least recently used first, and busy ones once they " +
          "finish. It runs nothing.",
        inputSchema: {
          type: "object",
          properties: { count: { type: "integer", minimum: 1, maximum: 8, description: "Machines awake at once, 1 to 8" } },
          required: ["count"],
        },
        annotations: { readOnlyHint: false },
        async run(input) {
          const count = input?.count;
          if (!Number.isInteger(count) || count < 1 || count > 8) throw new Error("count: a whole number of machines, 1 to 8");
          const r = await agent.setAwakeLimit(count);
          return text(`up to ${r.awakeLimit} machines awake at once; ${r.awake} awake now` + (r.overLimit ? ` (${r.overLimit})` : ""));
        },
      },
    };
  }

  /** One dispatcher over the definitions: a tool's name and input to its result, errors as results. */
  function dispatcher(defs) {
    return async (name, input, options) => {
      const d = Object.prototype.hasOwnProperty.call(defs, name) ? defs[name] : null;
      if (!d) return fail(new Error(`no tool ${name}`));
      try {
        return await d.run(input && typeof input === "object" ? input : {}, options);
      } catch (e) {
        return fail(e);
      }
    };
  }

  /** The tools as registerTool takes them, each executing through the one dispatcher. */
  function tools(agent, opts) {
    const defs = definitions(agent, opts);
    const dispatch = dispatcher(defs);
    return Object.entries(defs).map(([name, d]) => ({
      name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations,
      execute: (input, options) => dispatch(name, input, options),
    }));
  }

  /** An accessible confirm in the page: a modal <dialog> (class sg-ask, for the page to style),
   *  focus on its safe choice. Resolves true only for the confirming choice. */
  function confirmInPage(doc, message, { title = "Let agents use these machines?", yes = "Allow", no = "Don't allow", danger = false } = {}) {
    return new Promise((resolve) => {
      const n = (confirmInPage.n = (confirmInPage.n ?? 0) + 1);
      const dialog = doc.createElement("dialog");
      dialog.className = "sg-ask";
      dialog.setAttribute("aria-labelledby", `sg-ask-title-${n}`);
      dialog.setAttribute("aria-describedby", `sg-ask-text-${n}`);
      const h = doc.createElement("h2");
      h.id = `sg-ask-title-${n}`;
      h.textContent = title;
      const p = doc.createElement("p");
      p.id = `sg-ask-text-${n}`;
      p.textContent = message;
      const row = doc.createElement("div");
      row.className = "sg-ask-actions";
      const button = (label, value, cls) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = label;
        b.addEventListener("click", () => dialog.close(value));
        row.append(b);
        return b;
      };
      const deny = button(no, "deny", "sg-ask-no");
      button(yes, "allow", danger ? "sg-ask-yes sg-ask-danger" : "sg-ask-yes");
      dialog.append(h, p, row);
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.returnValue === "allow");
      });
      doc.body.append(dialog);
      dialog.showModal();
      deny.focus();
    });
  }

  const ASK_MESSAGE = "An agent (or someone at this page) wants to run commands on these Linux machines and move files between them. " +
    "They run as root in the machines, in this tab (not on your computer), and can read or change anything in them. You are asked once for this page load.";

  /**
   * The page's one question, shared by everything that runs commands (the WebMCP tools and the
   * agent panel): asked at the first run, and not again in this page load once allowed. A refusal
   * asks again next time. `options` is what a tool's execute() was given: a client that has
   * requestUserInteraction is asked through it.
   */
  function consent({ doc = root.document, confirm } = {}) {
    let allowed = null;
    const show = (m) => (confirm ?? ((text) => confirmInPage(doc, text)))(m);
    return async (options) => {
      if (allowed === null) {
        allowed = (async () => {
          const client = options?.client ?? options;
          if (typeof client?.requestUserInteraction === "function") return client.requestUserInteraction(() => show(ASK_MESSAGE));
          return show(ASK_MESSAGE);
        })();
      }
      if (!(await allowed)) {
        allowed = null;
        throw new Error("the person at the page did not allow it");
      }
    };
  }

  /** The page's model context, if it has one with a way to add tools: document.modelContext
   *  (the current draft), else navigator.modelContext (earlier drafts, MCP-B's polyfill). */
  function findContext(doc, nav) {
    for (const ctx of [doc?.modelContext, nav?.modelContext]) {
      if (ctx && (typeof ctx.registerTool === "function" || typeof ctx.provideContext === "function")) return ctx;
    }
    return null;
  }

  /** Look for a model context every `pollMs` until `waitMs` has gone by: an extension or a
   *  polyfill can add one after the page has started. Resolves to it, or null. */
  function waitForContext(doc, nav, { waitMs = 0, pollMs = 250, timers = root } = {}) {
    const found = findContext(doc, nav);
    if (found || !(waitMs > 0)) return Promise.resolve(found);
    let left = Math.ceil(waitMs / pollMs);
    return new Promise((resolve) => {
      const look = () => {
        const ctx = findContext(doc, nav);
        if (ctx) return resolve(ctx);
        if (--left <= 0) return resolve(null);
        timers.setTimeout(look, pollMs);
      };
      timers.setTimeout(look, pollMs);
    });
  }

  /**
   * Register the tools with the page's model context. `options.exposedTo` lists the origins the
   * tools are shared with beyond this one (none by default). With `waitMs`, a model context that
   * appears within that long is still used. `ask` is the page's consent (one is made otherwise).
   * Returns what happened, for capabilities(): { available, registered, reason, api }.
   */
  async function register(agent, { jobText, exposedTo = [], doc = root.document, nav = root.navigator, confirm, ask,
    waitMs = 0, pollMs = 250, timers = root } = {}) {
    const ctx = await waitForContext(doc, nav, { waitMs, pollMs, timers });
    if (!ctx) {
      const waited = waitMs > 0 ? ` (looked for ${Math.round(waitMs / 1000)} s)` : "";
      return { available: false, registered: [], reason: `this browser has no WebMCP (document.modelContext)${waited}; nothing registered` };
    }
    const caps = await agent.capabilities();
    if (!caps.supported) return { available: true, registered: [], reason: caps.reason };

    ask ??= consent({ doc, confirm });
    const list = tools(agent, { jobText, ask });
    const controller = new AbortController();
    const registered = [];
    let api = "registerTool";
    let shared = exposedTo;
    const result = (reason) => {
      const r = { available: true, registered, reason, exposedTo: shared, api };
      Object.defineProperty(r, "unregister", { value: () => controller.abort() });
      return r;
    };

    if (typeof ctx.registerTool !== "function") {
      // The first drafts' shape (and older polyfills): every tool at once, replacing the page's
      // set. No per-origin sharing there
      api = "provideContext";
      shared = [];
      try {
        await ctx.provideContext({ tools: list });
      } catch (e) {
        return result(`provideContext: ${e?.message ?? e}`);
      }
      registered.push(...list.map((t) => t.name));
      controller.signal.addEventListener("abort", () => { try { ctx.clearContext?.(); } catch {} });
      return result(null);
    }

    for (const tool of list) {
      const opts = { signal: controller.signal };
      if (shared.length) opts.exposedTo = shared;
      try {
        await ctx.registerTool(tool, opts);
      } catch (e) {
        if (!shared.length) return result(`registerTool ${tool.name}: ${e?.message ?? e}`);
        // A browser that refuses the sharing still gets the tools, for this origin only
        try {
          await ctx.registerTool(tool, { signal: controller.signal });
          shared = [];
        } catch (e2) {
          return result(`registerTool ${tool.name}: ${e2?.message ?? e2}`);
        }
      }
      registered.push(tool.name);
    }
    return result(shared === exposedTo ? null : "exposedTo was refused; the tools are this origin's only");
  }

  const SnowglobeWebMCP = { register, tools, definitions, dispatcher, confirmInPage, consent, findContext, waitForContext, ASK_MESSAGE };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeWebMCP;
  else root.SnowglobeWebMCP = SnowglobeWebMCP;
})(typeof window !== "undefined" ? window : globalThis);
