// window.snowglobeAgent as WebMCP tools (https://github.com/webmachinelearning/webmcp), for any
// client that reads a page's tools: a browser's own agent, an extension, a chat page. Registered
// with document.modelContext (navigator.modelContext in earlier drafts) .registerTool(tool,
// { signal, exposedTo }), or, where only the first drafts' shape is there, .provideContext({ tools }).
// A model context that an extension or a polyfill (MCP-B's @mcp-b/global, say) adds after the page
// starts is still found, for a while; a page that never gets one registers nothing.
//
// The tools are named as `snowglobe mcp` names its own: run_command starts a job and returns its
// id; job_status reads its state and output, which ends as run_command's does natively ([exit N],
// [timed out], [stopped]); cancel_job stops it. The first call asks the person at the page.
(function (root) {
  "use strict";

  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  const fail = (e) => text(String(e?.message ?? e), true);

  function tools(agent, jobText, ask) {
    const jobId = (input) => {
      const id = input?.job_id;
      if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) throw new Error("job_id: the id run_command returned");
      return id;
    };
    return [
      {
        name: "run_command",
        title: "Run a command",
        description: "Start a shell command (/bin/sh, as root) in the arm64 Linux machine running in this browser tab, and return its job id at once. " +
          "Poll job_status with that id for its output and exit status. One job runs at a time; each starts in a fresh working directory, " +
          "and files elsewhere (/root, /tmp, ...) persist between jobs. Give request_id to make a retry safe: the same id returns the same job.",
        inputSchema: {
          type: "object",
          properties: {
            command: { type: "string", description: "The command line" },
            timeout_seconds: { type: "number", description: "Kill it, and everything it started, after this long (default 300, at most 3600)" },
            request_id: { type: "string", description: "Optional: a retry with the same id returns the original job instead of running it twice" },
          },
          required: ["command"],
        },
        annotations: { readOnlyHint: false, consequentialHint: true },
        async execute(input, options) {
          try {
            if (!input || typeof input !== "object") throw new Error("expected { command, timeout_seconds?, request_id? }");
            const { command, timeout_seconds, request_id } = input;
            if (typeof command !== "string" || !command.trim()) throw new Error("command: a non-empty string");
            if (timeout_seconds !== undefined && (typeof timeout_seconds !== "number" || !Number.isFinite(timeout_seconds) || timeout_seconds < 0)) {
              throw new Error("timeout_seconds: a number of seconds, 0 or more");
            }
            if (request_id !== undefined && typeof request_id !== "string") throw new Error("request_id: a string");
            await ask(options);
            const { jobId } = await agent.runCommand({ command, timeoutSeconds: timeout_seconds, requestId: request_id });
            return text(`job ${jobId} started; call job_status with job_id "${jobId}" for its output`);
          } catch (e) {
            return fail(e);
          }
        },
      },
      {
        name: "job_status",
        title: "A job's status and output",
        description: "A job's state (running, exited, timed_out, cancelled, failed) and its output so far. A finished job's output ends with " +
          "[exit N], [timed out] or [stopped]; a running one's with [running]. Output beyond 1 MiB keeps the most recent part and says so.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string", description: "The id run_command returned" } },
          required: ["job_id"],
        },
        annotations: { readOnlyHint: true, untrustedContentHint: true },
        async execute(input) {
          try {
            const v = await agent.readJob(jobId(input));
            return text(jobText(v), v.state === "failed" || (v.state === "exited" && v.exitStatus !== 0) || v.state === "timed_out");
          } catch (e) {
            return fail(e);
          }
        },
      },
      {
        name: "cancel_job",
        title: "Cancel a job",
        description: "Stop a running job: the machine kills its command and everything it started. Returns the job's status, as job_status does.",
        inputSchema: {
          type: "object",
          properties: { job_id: { type: "string", description: "The id run_command returned" } },
          required: ["job_id"],
        },
        annotations: { readOnlyHint: false },
        async execute(input) {
          try {
            const v = await agent.cancelJob(jobId(input));
            return text(jobText(v));
          } catch (e) {
            return fail(e);
          }
        },
      },
    ];
  }

  /** An accessible confirm in the page: a modal <dialog>, focus on its safe choice. */
  function confirmInPage(doc, message) {
    return new Promise((resolve) => {
      const dialog = doc.createElement("dialog");
      dialog.setAttribute("aria-labelledby", "snowglobe-agent-ask-title");
      dialog.setAttribute("aria-describedby", "snowglobe-agent-ask-text");
      dialog.style.cssText = "max-width:28rem;font:14px/1.45 system-ui,sans-serif;border:1px solid #3b3b39;border-radius:8px;padding:16px;background:#161615;color:#e9e9e4";
      const title = doc.createElement("h2");
      title.id = "snowglobe-agent-ask-title";
      title.textContent = "Let an agent use this machine?";
      title.style.cssText = "font-size:16px;margin:0 0 8px";
      const p = doc.createElement("p");
      p.id = "snowglobe-agent-ask-text";
      p.textContent = message;
      p.style.margin = "0 0 14px";
      const row = doc.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
      const button = (label, value) => {
        const b = doc.createElement("button");
        b.type = "button";
        b.textContent = label;
        b.style.cssText = "font:inherit;padding:7px 12px;border-radius:4px;border:1px solid #3b3b39;background:#222221;color:inherit;cursor:pointer";
        b.addEventListener("click", () => dialog.close(value));
        row.append(b);
        return b;
      };
      const deny = button("Don't allow", "deny");
      const allow = button("Allow", "allow");
      allow.style.background = "#e9e9e4";
      allow.style.color = "#161615";
      dialog.append(title, p, row);
      dialog.addEventListener("close", () => {
        dialog.remove();
        resolve(dialog.returnValue === "allow");
      });
      doc.body.append(dialog);
      dialog.showModal();
      deny.focus();
    });
  }

  const ASK_MESSAGE = "An agent (or someone at this page) wants to run commands in this tab's Linux machine. They run as root " +
    "in the machine (not on your computer) and can change or read anything in it.";

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
    const list = tools(agent, jobText, ask);
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

  const SnowglobeWebMCP = { register, tools, confirmInPage, consent, findContext, waitForContext };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeWebMCP;
  else root.SnowglobeWebMCP = SnowglobeWebMCP;
})(typeof window !== "undefined" ? window : globalThis);
