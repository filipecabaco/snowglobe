// The agent panel: window.snowglobeAgent as ordinary labelled controls, for an agent that drives
// the page's UI (clicks, types, reads) rather than calling tools, and for anyone using a screen
// reader. A command box with Run and Cancel, a status line, and the job's output ending with its
// exit status, as the WebMCP tools have it. The same job runner, and the same question to the
// person at the page before the first run.
(function (root) {
  "use strict";

  const POLL_MS = 300;
  const STATUS_MS = 1000;

  /** What a finished job's result line says. */
  function resultLine(v) {
    switch (v.state) {
      case "exited": return `Exit status: ${v.exitStatus}`;
      case "timed_out": return "Timed out: the command and everything it started were stopped";
      case "cancelled": return "Cancelled: the command and everything it started were stopped";
      case "running": return "Running";
      default: return `Failed: ${v.error}`;
    }
  }

  /** What the status line says when no job of the panel's is running. */
  function idleText(st) {
    switch (st.state) {
      case "ready": return "Ready. Type a command and press Run.";
      case "booting": return "The machine is starting. Run is available once it is running.";
      case "saving": return "Saving the workspace. Run is available again in a moment.";
      case "busy": return `Busy: job ${st.jobId} is running. Wait for it, or cancel it.`;
      default: return `Unavailable: ${st.reason ?? "the machine is not running"}.`;
    }
  }

  /**
   * The panel's behaviour over its elements: `els` is { form, command, run, cancel, status,
   * result, output } (anything with value, disabled, textContent, addEventListener). `ask` is the
   * page's consent; `jobText` how a job reads (SnowglobeAgent.jobText).
   */
  class Panel {
    constructor(agent, els, { ask, jobText, timers = root } = {}) {
      this.agent = agent;
      this.els = els;
      this.ask = ask;
      this.jobText = jobText;
      this.timers = timers;
      this.jobId = null;
      this.starting = false;
      els.form.addEventListener("submit", (e) => {
        e.preventDefault?.();
        this.run();
      });
      els.command.addEventListener("keydown", (e) => {
        // Enter adds a line; ctrl/cmd+Enter runs
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault?.();
          this.run();
        }
      });
      els.cancel.addEventListener("click", () => this.cancel());
      els.cancel.disabled = true;
      this.statusTimer = timers.setInterval(() => this.refresh(), STATUS_MS);
      this.refresh();
    }

    _say(text) {
      if (this.els.status.textContent !== text) this.els.status.textContent = text;
    }

    /** Show the machine's state while no run of the panel's is under way. */
    async refresh() {
      if (this.jobId || this.starting) return;
      const st = await this.agent.status();
      if (this.jobId || this.starting) return;
      this.els.run.disabled = st.state !== "ready";
      // The last outcome stays in the status line until the next run
      this._say(st.state === "ready" && this.last ? `${this.last} Ready for the next command.` : idleText(st));
    }

    async run() {
      if (this.jobId || this.starting) return;
      const command = this.els.command.value;
      if (!command.trim()) {
        this._say("Type a command first, then press Run.");
        this.els.command.focus?.();
        return;
      }
      this.starting = true;
      this.last = null;
      this.els.run.disabled = true;
      try {
        this._say("Waiting for the person at this page to allow commands…");
        await this.ask();
        const { jobId } = await this.agent.runCommand({ command });
        this.jobId = jobId;
      } catch (e) {
        this.starting = false;
        this.last = `Not run: ${e?.message ?? e}.`;
        this._say(this.last);
        this.els.run.disabled = false;
        return;
      }
      this.starting = false;
      this.els.cancel.disabled = false;
      this.els.result.textContent = "Running";
      this.els.output.textContent = "";
      this._say(`Running job ${this.jobId}…`);
      await this.poll();
    }

    async poll() {
      const id = this.jobId;
      if (!id) return;
      const v = await this.agent.readJob(id);
      if (this.jobId !== id) return; // another poll finished it
      if (v.state === "running") {
        if (this.els.output.textContent !== v.output) this.els.output.textContent = v.output;
        // One timer at a time, whichever poll set it
        if (this.pollTimer) this.timers.clearTimeout(this.pollTimer);
        this.pollTimer = this.timers.setTimeout(() => this.poll(), POLL_MS);
        return;
      }
      this.jobId = null;
      this.els.cancel.disabled = true;
      this.els.output.textContent = this.jobText(v);
      this.els.result.textContent = resultLine(v);
      this.last = `Finished. ${resultLine(v)}.`;
      this._say(this.last);
      await this.refresh();
    }

    async cancel() {
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

  /** The panel in this page: its elements by id, opened by the link #agent. */
  function attach(agent, { doc = root.document, ask, jobText, loc = root.location } = {}) {
    const $ = (id) => doc.getElementById(id);
    const details = $("agent-panel");
    if (!details) return null;
    const open = () => { if (loc?.hash === "#agent") details.open = true; };
    open();
    root.addEventListener?.("hashchange", open);
    return new Panel(agent, {
      form: $("agent-form"), command: $("agent-command"), run: $("agent-run"), cancel: $("agent-cancel"),
      status: $("agent-status"), result: $("agent-result"), output: $("agent-output"),
    }, { ask, jobText });
  }

  const SnowglobeAgentPanel = { attach, Panel, resultLine, idleText };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeAgentPanel;
  else root.SnowglobeAgentPanel = SnowglobeAgentPanel;
})(typeof window !== "undefined" ? window : globalThis);
