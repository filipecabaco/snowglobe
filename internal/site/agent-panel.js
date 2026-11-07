// The agent panel: window.snowglobeAgent as ordinary labelled controls, for an agent that drives
// the page's UI (clicks, types, reads) rather than calling tools, and for anyone using a screen
// reader. A command box with Run and Cancel, a status line, the latest run under "Result" (its
// exit status and output, as the WebMCP tools have it) and the runs before it under "Earlier runs".
// The same job runner, and the same question to the person at the page before the first run.
(function (root) {
  "use strict";

  const POLL_MS = 300;
  const STATUS_MS = 1000;
  // Runs the panel keeps, newest first
  const MAX_RUNS = 30;

  /** What a run's result says: "Exit status: N", or how it ended. */
  function resultLine(v) {
    switch (v.state) {
      case "copied": return "Copied";
      case "exited": return `Exit status: ${v.exitStatus}`;
      case "timed_out": return "Timed out";
      case "cancelled": return "Cancelled";
      case "running": return "Running";
      case "not_allowed": return "Not allowed";
      default: return `Failed: ${v.error}`;
    }
  }

  /** A run's badge: short, the same words as its result. */
  function badge(v) {
    switch (v.state) {
      case "copied": return { text: "copied", tone: "ok" };
      case "exited": return { text: `exit ${v.exitStatus}`, tone: v.exitStatus === 0 ? "ok" : "bad" };
      case "timed_out": return { text: "timed out", tone: "bad" };
      case "cancelled": return { text: "cancelled", tone: "bad" };
      case "running": return { text: "running", tone: "live" };
      case "not_allowed": return { text: "not allowed", tone: "bad" };
      default: return { text: "failed", tone: "bad" };
    }
  }

  /** "0.4 s", "12 s", "3 min 4 s". */
  function duration(ms) {
    if (!(ms >= 0)) return "";
    if (ms < 10000) return `${(ms / 1000).toFixed(1)} s`;
    const s = Math.round(ms / 1000);
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
  }

  const about = (st) => st.wakeSeconds == null ? "a few seconds" : st.wakeSeconds < 0.95 ? "under a second" : `about ${Math.round(st.wakeSeconds)} s`;

  /** What the status line says when no run of the panel's is under way. */
  function idleText(st) {
    switch (st.state) {
      case "ready": return "Ready.";
      case "booting": return "The machine is starting. Run is available once it is running.";
      case "saving": return "Saving the workspace. Run is available again in a moment.";
      case "busy": return `Busy: job ${st.jobId} is running. Wait for it, or cancel it.`;
      case "suspended": return st.fresh ? "Asleep, with nothing saved. Run starts it from the machine as built (a few seconds)."
        : `Suspended to free memory. The next command wakes it (${about(st)}).`;
      case "suspending": return "Suspending: saving the machine's state to free its memory…";
      case "waking": return `Waking the machine from its saved state (${about(st)})…`;
      default: return `Unavailable: ${st.reason ?? "the machine is not running"}.`;
    }
  }

  /**
   * The panel's behaviour over its elements: `els` is { form, command, run, cancel, status,
   * result, output, suspend? } (anything with value, disabled, textContent, addEventListener).
   * `render(runs)`, if given, draws the runs (newest first). `ask` is the page's consent;
   * `jobText` how a job reads (SnowglobeAgent.jobText).
   */
  class Panel {
    /**
     * `label()`, if given, names where a run runs (the selected runtime): each run is tagged with
     * it. `hold()`, if given, is a sentence the status line says instead of the machine's state
     * (a copy under way, a wake waiting its turn).
     */
    constructor(agent, els, { ask, jobText, render, label, hold, timers = root, now = () => Date.now() } = {}) {
      this.agent = agent;
      this.els = els;
      this.ask = ask;
      this.jobText = jobText;
      this.render = render;
      this.label = label;
      this.hold = hold;
      this.timers = timers;
      this.now = now;
      this.jobId = null;
      this.starting = false;
      this.runs = [];
      els.form.addEventListener("submit", (e) => {
        e.preventDefault?.();
        this.run();
      });
      els.command.addEventListener("keydown", (e) => {
        // Enter adds a line; ctrl/cmd+Enter runs, when Run would
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault?.();
          if (!els.run.disabled) this.run();
        }
      });
      els.cancel.addEventListener("click", () => this.cancel());
      els.cancel.disabled = true;
      els.suspend?.addEventListener("click", () => this.toggleSuspend());
      this.statusTimer = timers.setInterval(() => this.refresh(), STATUS_MS);
      this.refresh();
    }

    _say(text) {
      if (this.els.status.textContent !== text) this.els.status.textContent = text;
    }

    _draw(latestOnly = false) {
      this.render?.(this.runs, latestOnly);
    }

    _add(run) {
      this.runs.unshift(run);
      if (this.runs.length > MAX_RUNS) this.runs.length = MAX_RUNS;
      this._draw();
    }

    /** Suspend or Wake, as the machine is. */
    _suspendControl(st) {
      const b = this.els.suspend;
      if (!b) return;
      const asleep = st.state === "suspended";
      const label = asleep ? "Wake" : "Suspend";
      if (b.textContent !== label) b.textContent = label;
      b.disabled = !(asleep || st.state === "ready") || !!this.jobId || this.starting;
    }

    /** Show the machine's state while no run of the panel's is under way. */
    async refresh() {
      if (this.jobId || this.starting) return;
      const st = await this.agent.status(this.label?.());
      if (this.jobId || this.starting) return;
      // A suspended machine can run: Run wakes it
      this.els.run.disabled = !(st.state === "ready" || st.state === "suspended");
      this._suspendControl(st);
      const held = this.hold?.();
      if (held) return this._say(held);
      // The last outcome stays in the status line until the next run
      // (a run cancelled while the machine woke: the wake goes on, and the status line says both)
      this._say(st.state === "ready" && this.last ? `${this.last} Ready for the next command.`
        : st.state === "waking" && this.last ? `${this.last} ${idleText(st)}` : idleText(st));
    }

    /** Say something in the status line now (a copy's progress): until the next refresh. */
    say(text) {
      this._say(text);
    }

    /** A run that didn't come from the form (a copy) becomes the latest, as a run does. */
    record(run, outcome) {
      // The run itself (not a copy), so update() finds it as it goes
      run.startedAt ??= this.now();
      if (run.endedAt === undefined) run.endedAt = run.state === "running" ? null : this.now();
      run.output ??= "";
      this._show(run);
      if (outcome) {
        this.last = outcome;
        this._say(outcome);
      }
    }

    /** The latest run, whose output and result change as it goes (a copy's progress). */
    update(run, fields) {
      Object.assign(run, fields);
      if (this.runs[0] === run) {
        this.els.result.textContent = resultLine(run);
        this.els.output.textContent = run.output;
      }
      this._draw();
    }

    async toggleSuspend() {
      const st = await this.agent.status(this.label?.());
      if (this.els.suspend) this.els.suspend.disabled = true;
      try {
        if (st.state === "suspended") {
          this._say(idleText({ ...st, state: "waking" }));
          await this.agent.wake();
        } else {
          this._say(idleText({ state: "suspending" }));
          if (!(await this.agent.suspend())) this._say("Not suspended: the machine is busy.");
        }
      } catch (e) {
        this._say(`Could not ${st.state === "suspended" ? "wake" : "suspend"}: ${e?.message ?? e}.`);
      }
      this.last = null;
      await this.refresh();
    }

    async run() {
      if (this.jobId || this.starting) return;
      const command = this.els.command.value;
      const runtime = this.label?.();
      if (!command.trim()) {
        this._say("Type a command first, then press Run.");
        this.els.command.focus?.();
        return;
      }
      this.starting = true;
      this.last = null;
      this.els.run.disabled = true;
      if (this.els.suspend) this.els.suspend.disabled = true;
      const startedAt = this.now();
      // This run until it has a job: Cancel can drop it while it waits for a wake
      const pending = { command, runtime, startedAt, aborted: false };
      this.pending = pending;
      try {
        this._say("Waiting for the person at this page to allow commands…");
        try {
          await this.ask();
        } catch (e) {
          // Refused: nothing ran, and the list says so
          this._show({ command, runtime, state: "not_allowed", output: "", startedAt, endedAt: this.now() });
          throw e;
        }
        const st = await this.agent.status(runtime);
        if (["suspended", "suspending", "waking"].includes(st.state)) {
          this._say(idleText({ ...st, state: "waking" }));
          // The wake first, so a Cancel meanwhile leaves nothing to run once it is done
          this.els.cancel.disabled = false;
          await this.agent.wake(runtime);
          if (pending.aborted) return;
          this.els.cancel.disabled = true;
        }
        const { jobId } = await this.agent.runCommand(runtime === undefined ? { command } : { command, runtime });
        this.jobId = jobId;
      } catch (e) {
        if (pending.aborted) return; // Cancel has said what became of it
        this.pending = null;
        this.els.cancel.disabled = true;
        this.starting = false;
        this.last = `Not run: ${e?.message ?? e}.`;
        this._say(this.last);
        this.els.run.disabled = false;
        if (this.els.suspend) this.els.suspend.disabled = false;
        return;
      }
      this.pending = null;
      this.starting = false;
      this.els.cancel.disabled = false;
      this._show({ jobId: this.jobId, command, runtime, state: "running", output: "", startedAt: this.now(), endedAt: null });
      this._say(`Running job ${this.jobId}…`);
      await this.poll();
    }

    /** A run becomes the latest: under Result, with the one before it moved to Earlier runs. */
    _show(run) {
      this.els.result.textContent = resultLine(run);
      this.els.output.textContent = run.output;
      this._add(run);
    }

    async poll() {
      const id = this.jobId;
      if (!id) return;
      const v = await this.agent.readJob(id);
      if (this.jobId !== id) return; // another poll finished it
      const run = this.runs.find((r) => r.jobId === id);
      // The Result region shows the latest run: an agent's, recorded meanwhile, may have taken it
      const latest = !run || this.runs[0] === run;
      if (v.state === "running") {
        if (latest && this.els.output.textContent !== v.output) this.els.output.textContent = v.output;
        if (run) run.output = v.output;
        this._draw(true);
        // One timer at a time, whichever poll set it
        if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
        this.pollTimer = this.timers.setTimeout(() => this.poll(), POLL_MS);
        return;
      }
      this.jobId = null;
      this.els.cancel.disabled = true;
      // As the tools have it, less the blank line a command that printed nothing leaves before its status
      const text = this.jobText(v).replace(/^\n(?=\[)/, "");
      if (latest) {
        this.els.output.textContent = text;
        this.els.result.textContent = resultLine(v);
      }
      if (run) Object.assign(run, { state: v.state, exitStatus: v.exitStatus, error: v.error, output: text, endedAt: v.endedAt ?? this.now() });
      this._draw();
      this.last = `Finished. ${resultLine(v)}.`;
      this._say(this.last);
      await this.refresh();
    }

    async cancel() {
      const pending = this.pending;
      if (!this.jobId && pending) {
        // Still waiting for the machine to wake: the run is dropped now. The wake goes on (the
        // machine is on its way back), but nothing runs once it is done
        pending.aborted = true;
        this.pending = null;
        this.starting = false;
        this.els.cancel.disabled = true;
        this._show({ command: pending.command, runtime: pending.runtime, state: "cancelled", output: "", startedAt: pending.startedAt, endedAt: this.now() });
        this.last = "Cancelled before it ran: nothing ran.";
        this._say(this.last);
        await this.refresh();
        return;
      }
      if (!this.jobId) return;
      this._say(`Cancelling job ${this.jobId}…`);
      this.els.cancel.disabled = true;
      try {
        await this.agent.cancelJob(this.jobId);
      } catch (e) {
        this._say(`Could not cancel: ${e?.message ?? e}.`);
      }
      if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
      await this.poll();
    }
  }

  // ------------------------------------------------------------- the page's elements

  // Longer than this, an earlier run's output is behind a disclosure
  const FOLD_LINES = 8;

  /** Draws the runs into a panel's container: the latest into its Result region's own parts, the
   *  rest as a list under Earlier runs, each tagged with its runtime. Rebuilt on each change; a
   *  run's open disclosure stays open. Parts are found by data-part, within `container`. */
  function domRenderer(container) {
    const doc = container.ownerDocument;
    const $ = (part) => container.querySelector(`[data-part="${part}"]`);
    // The latest run's result line is the panel's; here it only gets its tone
    const latest = { command: $("latest-command"), runtime: $("latest-runtime"), result: $("result"), time: $("latest-time"),
      head: $("latest-head"), output: $("output"), empty: $("empty") };
    const history = $("history");
    const list = $("runs");
    const opened = new Set();
    const el = (tag, cls, text) => {
      const e = doc.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    const setBadge = (node, run) => {
      const b = badge(run);
      node.textContent = b.text;
      node.dataset.tone = b.tone;
    };
    const took = (run, now) => duration((run.endedAt ?? now) - run.startedAt);
    return (runs, latestOnly) => {
      const now = Date.now();
      const [first, ...rest] = runs;
      latest.head.hidden = !first;
      if (latest.empty) latest.empty.hidden = !!first;
      if (first) {
        latest.command.textContent = first.command;
        if (latest.runtime) {
          latest.runtime.textContent = first.runtime ?? "";
          latest.runtime.hidden = !first.runtime;
        }
        latest.result.dataset.tone = badge(first).tone;
        latest.time.textContent = took(first, now);
        latest.time.dateTime = `PT${(((first.endedAt ?? now) - first.startedAt) / 1000).toFixed(1)}S`;
      }
      latest.output.hidden = !first || (!first.output && first.state !== "running");
      history.hidden = rest.length === 0;
      if (latestOnly) return;
      for (const d of list.querySelectorAll("details[open]")) opened.add(d.dataset.key);
      list.replaceChildren(...rest.map((run) => {
        const li = el("li", "run");
        const head = el("div", "run-head");
        const cmd = el("code", "run-cmd", run.command);
        const meta = el("span", "run-meta");
        if (run.runtime) meta.append(el("span", "tag", run.runtime));
        const b = el("span", "badge");
        setBadge(b, run);
        const t = el("time", "run-time", took(run, now));
        meta.append(b, t);
        head.append(cmd, meta);
        li.append(head);
        if (run.output) {
          const pre = el("pre", "run-out", run.output);
          pre.tabIndex = 0;
          pre.setAttribute("aria-label", "Output");
          const lines = run.output.split("\n").length;
          if (lines > FOLD_LINES) {
            const d = el("details", "run-fold");
            d.dataset.key = String(run.startedAt) + run.command;
            d.open = opened.has(d.dataset.key);
            d.append(el("summary", null, `Output, ${lines} lines`), pre);
            li.append(d);
          } else li.append(pre);
        }
        return li;
      }));
    };
  }

  /** The panel in `container` (an element holding its parts, by data-part): form, command, run,
   *  cancel, status, result, output, suspend (optional), and the runs' parts domRenderer draws. */
  function attach(agent, { container, ask, jobText, label, hold } = {}) {
    const $ = (part) => container?.querySelector(`[data-part="${part}"]`) ?? null;
    if (!$("form")) return null;
    return new Panel(agent, {
      form: $("form"), command: $("command"), run: $("run"), cancel: $("cancel"),
      status: $("status"), result: $("result"), output: $("output"), suspend: $("suspend") ?? undefined,
    }, { ask, jobText, label, hold, render: $("runs") ? domRenderer(container) : undefined });
  }

  const SnowglobeAgentPanel = { attach, Panel, domRenderer, resultLine, idleText, badge, duration };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeAgentPanel;
  else root.SnowglobeAgentPanel = SnowglobeAgentPanel;
})(typeof window !== "undefined" ? window : globalThis);
