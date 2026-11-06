// window.snowglobeAgent as WebMCP tools (https://github.com/webmachinelearning/webmcp), for any
// client that reads a page's tools: a browser's own agent, an extension, a chat page. Registered
// with the standard API only: document.modelContext (navigator.modelContext in earlier drafts)
// .registerTool(tool, { signal, exposedTo }). A page without it registers nothing; a polyfill
// (MCP-B's @mcp-b/global, say) loaded before this file provides one.
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

  /**
   * Register the tools with the page's model context. `options.exposedTo` lists the origins the
   * tools are shared with beyond this one (none by default). Returns what happened, for
   * capabilities(): { available, registered, reason }.
   */
  async function register(agent, { jobText, exposedTo = [], doc = root.document, nav = root.navigator, confirm } = {}) {
    const ctx = doc?.modelContext ?? nav?.modelContext;
    if (!ctx || typeof ctx.registerTool !== "function") {
      return { available: false, registered: [], reason: "this browser has no WebMCP (document.modelContext); nothing registered" };
    }
    const caps = await agent.capabilities();
    if (!caps.supported) return { available: true, registered: [], reason: caps.reason };

    // Asked once per page: the first call that runs something
    let allowed = null;
    const ask = async (options) => {
      if (allowed === null) {
        allowed = (async () => {
          const message = "An agent wants to run commands in this tab's Linux machine. They run as root in the machine " +
            "(not on your computer) and can change or read anything in it.";
          const client = options?.client ?? options;
          if (typeof client?.requestUserInteraction === "function") {
            return client.requestUserInteraction(() => (confirm ?? ((m) => confirmInPage(doc, m)))(message));
          }
          return (confirm ?? ((m) => confirmInPage(doc, m)))(message);
        })();
      }
      if (!(await allowed)) {
        allowed = null; // ask again next time
        throw new Error("the person at the page did not allow it");
      }
    };

    const controller = new AbortController();
    const opts = { signal: controller.signal };
    if (exposedTo.length) opts.exposedTo = exposedTo;
    const registered = [];
    const result = (reason) => {
      const r = { available: true, registered, reason, exposedTo };
      Object.defineProperty(r, "unregister", { value: () => controller.abort() });
      return r;
    };
    for (const tool of tools(agent, jobText, ask)) {
      try {
        await ctx.registerTool(tool, opts);
        registered.push(tool.name);
      } catch (e) {
        return result(`registerTool ${tool.name}: ${e?.message ?? e}`);
      }
    }
    return result(null);
  }

  const SnowglobeWebMCP = { register, tools, confirmInPage };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeWebMCP;
  else root.SnowglobeWebMCP = SnowglobeWebMCP;
})(typeof window !== "undefined" ? window : globalThis);
