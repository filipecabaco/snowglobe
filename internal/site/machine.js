// One machine's life in a page, so it can be put away when nothing needs it and brought back when
// something does: running, suspended (its state saved and its memory given back to the browser),
// and woken again from that state. A page makes one per machine, so a page of several machines
// keeps awake only the ones in use.
//
// The page supplies the two halves that touch the emulator: suspend() captures the machine's
// state, saves it and frees the machine (its workers ended, every reference to its memory
// dropped), returning what wake(saved) needs to restore it. Everything else is here: when to
// suspend (idle for a while with nothing running, or hidden for a while, or asked to), never while
// busy, and one wake at a time however many callers ask for it.
(function (root) {
  "use strict";

  // Suspend after this long with nothing run, and after this long hidden
  const IDLE_MS = 5 * 60 * 1000;
  const HIDDEN_MS = 60 * 1000;
  // What a wake is said to take before one has been measured in this page
  const WAKE_GUESS_MS = 1000;
  // Wakes that fail in a row before the machine is given up as failed: until then a failed wake
  // leaves it suspended, its saved state kept, and the next command tries again
  const MAX_WAKE_FAILURES = 3;

  class Machine {
    /**
     * `hooks` is { suspend(): Promise<saved>, wake(saved): Promise, busy(): boolean, onchange(state, machine) }.
     * The machine begins "starting"; the page calls started() once it runs, or failed(error).
     * States: starting, running, suspending, suspended, waking, failed.
     */
    constructor(hooks, { idleMs = IDLE_MS, hiddenMs = HIDDEN_MS, timers = root, now = () => Date.now(), state = "starting" } = {}) {
      this.hooks = hooks;
      this.idleMs = idleMs;
      this.hiddenMs = hiddenMs;
      this.timers = timers;
      this.now = now;
      // "starting" (the page boots it now), or "suspended": made lazily, by the first wake, from
      // whatever wake(null) finds (a save, or the site's snapshot)
      this.state = state;
      this.saved = null;
      this.reason = null; // why it was last suspended: idle, hidden, asked
      this.hidden = false;
      this.wakeMs = null; // the last wake, measured
      this.error = null;
      this.wakeFailures = 0; // failed wakes in a row
      this._idle = null;
      this._hiddenTimer = null;
      this._suspending = null;
      this._waking = null;
    }

    _set(state) {
      if (this.state === state) return;
      this.state = state;
      this.hooks.onchange?.(state, this);
    }

    _busy() {
      try { return !!this.hooks.busy?.(); } catch { return true; }
    }

    _clear(name) {
      if (this[name] !== null) this.timers.clearTimeout(this[name]);
      this[name] = null;
    }

    _arm() {
      this._clear("_idle");
      if (this.state !== "running" || !(this.idleMs > 0)) return;
      this._idle = this.timers.setTimeout(() => {
        this._idle = null;
        this._timedSuspend("idle");
      }, this.idleMs);
    }

    _armHidden() {
      this._clear("_hiddenTimer");
      if (!this.hidden || this.state !== "running" || !(this.hiddenMs > 0)) return;
      this._hiddenTimer = this.timers.setTimeout(() => {
        this._hiddenTimer = null;
        this._timedSuspend("hidden");
      }, this.hiddenMs);
    }

    // The idle and hidden timers' suspend: through the page's scheduler when it has one (hooks.
    // requestSuspend), so a page of several machines never captures two at once
    _timedSuspend(reason) {
      const r = this.hooks.requestSuspend ? this.hooks.requestSuspend(reason) : this.suspend(reason);
      Promise.resolve(r).catch(() => {});
    }

    /** The machine runs (first boot done): the idle clock starts. */
    started() {
      this._set("running");
      this._arm();
      this._armHidden();
    }

    failed(error) {
      this.error = error;
      this._clear("_idle");
      this._clear("_hiddenTimer");
      this._set("failed");
    }

    /** Something used the machine (a command, a key in its terminal): the idle clock restarts. */
    touch() {
      if (this.state === "running") this._arm();
    }

    /** The page was hidden or shown. Hidden long enough, the machine is suspended. */
    setHidden(hidden) {
      this.hidden = !!hidden;
      if (this.hidden) this._armHidden();
      else this._clear("_hiddenTimer");
    }

    /** About how long a wake takes, in ms: the last one measured, or a guess. */
    wakeEstimateMs() {
      return this.wakeMs ?? WAKE_GUESS_MS;
    }

    /**
     * Save the machine's state and free it. Only from running, and never while busy (a job, a
     * save): then it stays running, its timers re-armed, and this resolves false.
     */
    suspend(reason = "asked") {
      if (this.state === "suspending") return this._suspending;
      if (this.state !== "running") return Promise.resolve(false);
      if (this._busy()) {
        // Look again later: whatever holds it will touch() when it ends, or the timer comes round
        if (reason === "idle") this._arm();
        if (reason === "hidden") this._armHidden();
        return Promise.resolve(false);
      }
      this._clear("_idle");
      this._clear("_hiddenTimer");
      this._set("suspending");
      this._suspending = (async () => {
        try {
          this.saved = await this.hooks.suspend();
        } catch (e) {
          this._suspending = null;
          // The machine itself is gone (its worker crashed, or its capture hung and it was ended):
          // failed, not running
          if (e?.fatal) {
            this.failed(e);
            return false;
          }
          // Not suspended: the page left it running
          this.error = e;
          this._set("running");
          this._arm();
          this._armHidden();
          return false;
        }
        this.reason = reason;
        this._suspending = null;
        this._set("suspended");
        return true;
      })();
      return this._suspending;
    }

    /**
     * Running again: at once when it is, after the wake already under way when one is, and
     * otherwise from the saved state. A suspend under way finishes first. Rejects if it can't: a
     * failed wake leaves it suspended (its saved state kept, for the next wake to try again), and
     * only the third failure in a row fails the machine.
     */
    async wake() {
      if (this.state === "suspending") await this._suspending;
      if (this.state === "running") {
        this._arm();
        return;
      }
      if (this.state === "waking") return this._waking;
      if (this.state !== "suspended") throw new Error(`the machine is ${this.state}`);
      this._set("waking");
      const began = this.now();
      this._waking = (async () => {
        try {
          await this.hooks.wake(this.saved);
        } catch (e) {
          this._waking = null;
          this.wakeFailures++;
          if (this.wakeFailures >= MAX_WAKE_FAILURES) this.failed(e);
          else {
            this.error = e;
            this._set("suspended");
          }
          throw e;
        }
        this.wakeMs = this.now() - began;
        this.wakeFailures = 0;
        this.error = null;
        this.saved = null;
        this._waking = null;
        this.started();
      })();
      return this._waking;
    }

    /** A failed machine back to suspended, its failures forgotten, for the next wake to try again. */
    retry() {
      if (this.state !== "failed") return false;
      this.wakeFailures = 0;
      this.error = null;
      this._set("suspended");
      return true;
    }

    /** Back to suspended with nothing saved (start fresh): the next wake starts from the snapshot.
     *  Only from suspended or failed; the page frees a running machine first. */
    forget() {
      if (this.state !== "suspended" && this.state !== "failed") return false;
      this.saved = null;
      this.wakeFailures = 0;
      this.error = null;
      this.reason = null;
      if (this.state === "failed") this._set("suspended");
      return true;
    }

    /** For capabilities(): what the machine is doing and how it is put away. */
    describe() {
      return {
        state: this.state,
        suspendedBecause: this.state === "suspended" ? this.reason : null,
        suspendsAfterIdleSeconds: this.idleMs > 0 ? Math.round(this.idleMs / 1000) : null,
        suspendsAfterHiddenSeconds: this.hiddenMs > 0 ? Math.round(this.hiddenMs / 1000) : null,
        wakeSeconds: Math.round(this.wakeEstimateMs() / 100) / 10,
        wakeMeasured: this.wakeMs !== null,
        // Why the last wake failed, while the machine is still suspended after it
        lastWakeError: this.state === "suspended" && this.wakeFailures > 0 ? String(this.error?.message ?? this.error) : null,
      };
    }
  }

  const SnowglobeMachine = { Machine, defaults: { IDLE_MS, HIDDEN_MS, WAKE_GUESS_MS, MAX_WAKE_FAILURES } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeMachine;
  else root.SnowglobeMachine = SnowglobeMachine;
})(typeof window !== "undefined" ? window : globalThis);
