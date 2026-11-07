// The page's machines share one budget of memory: each awake machine is about 540 to 740 MB of
// WebAssembly memory (supabase, on 2 CPUs, about 730, its vCPU workers sharing it), and suspending
// one briefly needs another copy of its RAM (and its gzip). The limit counts machines, whatever
// their size: an open preview's machines are busy, so they count and are never suspended.
// The scheduler keeps at most `budget` machines awake (the awake limit: 2 unless the person or an
// agent changes it, for this page load), and puts machines to sleep and wakes them one at a time,
// so no two captures or boots ever overlap:
//  - waking one when the limit is reached first suspends the least recently used idle one;
//  - a busy machine (a job or a copy running in it) is never suspended: when every awake machine
//    is busy, the wake waits, and says so, until one is idle (out of the queue: other machines'
//    wakes and suspends go on meanwhile; a caller may bound the wait). A wake for the preview,
//    when the machines in its way include the preview's own, goes beyond the limit instead: the
//    machines a preview uses count as one;
//  - a lower limit suspends idle machines, least recently used first, one at a time; busy ones
//    that keep it over the limit are said so (`over`), and suspended as they finish;
//  - a wake that runs out of memory (a RangeError, or an error that says so) suspends one more
//    machine and tries again, once; then it fails, clearly;
//  - the machines' own idle and hidden-tab suspends come through here too.
//
// A machine is { name, lifecycle (a SnowglobeMachine.Machine), busy(): boolean, lastUsed: ms }.
(function (root) {
  "use strict";

  const AWAKE = ["running", "suspending", "waking"];
  // How often a wake waiting for a busy machine looks again (it is also told when one finishes)
  const RECHECK_MS = 1000;
  // Machines awake at once: by default, and the most it may be set to
  const DEFAULT_BUDGET = 2;
  const MAX_BUDGET = 8;

  /** An error that means the browser had no memory for a new machine. */
  function outOfMemory(e) {
    if (!e) return false;
    if (e.name === "RangeError" || e instanceof RangeError) return true;
    return /out of memory|could not allocate|allocation failed|array buffer allocation/i.test(String(e.message ?? e));
  }

  class Scheduler {
    constructor({ budget = DEFAULT_BUDGET, onchange, timers = root, now = () => Date.now() } = {}) {
      this._budget = budget;
      this.machines = [];
      this.onchange = onchange;
      this.timers = timers;
      this.now = now;
      this.chain = Promise.resolve();
      this.waiting = null; // what a queued wake waits for, as a sentence
      this.over = null; // busy machines that keep more than the limit awake, as a sentence
      this.pending = 0; // operations queued or under way
      this._wakeups = new Set();
      this._trimming = null;
    }

    get budget() { return this._budget; }
    set budget(n) { this.setBudget(n); }

    /** The awake limit, 1 to 8. Lower than what is awake: idle machines are suspended, least
     *  recently used first, one at a time (never a busy one: those follow as they finish). The
     *  promise resolves once the trim has done what it can now. */
    setBudget(n) {
      if (!Number.isInteger(n) || n < 1 || n > MAX_BUDGET) throw new Error(`the awake limit: a whole number of machines, 1 to ${MAX_BUDGET}`);
      this._budget = n;
      if (this.awake().length <= n) this.over = null;
      this._changed();
      return this._scheduleTrim();
    }

    // One trim queued at a time: asking again while one waits its turn joins it
    _scheduleTrim() {
      if (this.awake().length <= this._budget) {
        if (this.over) {
          this.over = null;
          this._changed();
        }
        return Promise.resolve();
      }
      this._trimming ??= this._enqueue(() => {
        this._trimming = null;
        return this._trim();
      }).catch(() => {});
      return this._trimming;
    }

    add(m) {
      this.machines.push(m);
      return m;
    }

    awake() {
      return this.machines.filter((m) => AWAKE.includes(m.lifecycle.state));
    }

    /** "2 of 2 awake", for the page. */
    summary() {
      return `${this.awake().length} of ${this._budget} awake`;
    }

    _changed() {
      try { this.onchange?.(this); } catch {}
    }

    /** Something about busy-ness changed (a job or a copy ended): a waiting wake looks again, and
     *  machines over the limit are suspended now that they can be. */
    notify() {
      for (const wake of this._wakeups) wake();
      this._wakeups.clear();
      if (this.awake().length > this._budget) this._scheduleTrim();
    }

    _sleep(signal) {
      return new Promise((resolve) => {
        let timer = null;
        const done = () => {
          this._wakeups.delete(done);
          if (timer !== null) this.timers.clearTimeout(timer);
          signal?.removeEventListener?.("abort", done);
          resolve();
        };
        this._wakeups.add(done);
        timer = this.timers.setTimeout(done, RECHECK_MS);
        signal?.addEventListener?.("abort", done);
      });
    }

    /** One operation at a time, in the order asked. */
    _enqueue(fn) {
      this.pending++;
      this._changed();
      const run = this.chain.then(fn);
      this.chain = run.catch(() => {}).then(() => {
        this.pending--;
        this._changed();
      });
      return run;
    }

    /** The least recently used awake machine that is idle, other than `except`. */
    _victim(except, skip) {
      const idle = this.machines.filter((m) => m !== except && !skip?.has(m) && m.lifecycle.state === "running" && !m.busy());
      idle.sort((a, b) => (a.lastUsed ?? 0) - (b.lastUsed ?? 0));
      return idle[0] ?? null;
    }

    /** Suspend the least recently used idle machine. False if there was none; one whose suspend
     *  didn't happen (it became busy, or its capture failed) is not asked again in this turn. */
    async _evict(except, skip = new Set()) {
      for (;;) {
        const victim = this._victim(except, skip);
        if (!victim) return false;
        const done = await victim.lifecycle.suspend("evicted");
        this._changed();
        if (done) return true;
        skip.add(victim);
      }
    }

    async _trim() {
      while (this.awake().length > this._budget) {
        if (!(await this._evict(null))) {
          // Only busy ones left: said so, and notify() trims again as each finishes
          const awake = this.awake();
          const busy = awake.filter((m) => m.busy()).map((m) => m.name);
          this.over = `${awake.length} machines are awake, over the limit of ${this._budget}: ${busy.join(", ")} ${busy.length === 1 ? "is" : "are"} busy, ` +
            `and will be suspended when ${busy.length === 1 ? "it finishes" : "they finish"}`;
          this._changed();
          return;
        }
      }
      if (this.over) {
        this.over = null;
        this._changed();
      }
    }

    /**
     * `m` awake, waking it if it isn't: at once when it is running, otherwise in turn, after
     * making room for it. Rejects if the wake fails, or `signal` aborts while it waits.
     *
     * When every awake machine is busy, the wake waits for one to be idle: outside the queue, so
     * the other machines' wakes and suspends go on meanwhile. `waitMs` bounds that wait (a
     * TimeoutError after it; no bound when not given). `preview`: the wake is for the page's
     * preview, whose machines count as one: when what fills the limit includes a machine the
     * preview holds (x.previewHeld()), it is woken beyond the limit rather than waiting for its own
     * preview to close (`over` says so, and the machines over it are suspended once idle).
     */
    async ensureAwake(m, { signal, waitMs, preview = false } = {}) {
      m.lastUsed = this.now();
      if (m.lifecycle.state === "running") {
        m.lifecycle.touch();
        return;
      }
      if (m.lifecycle.state === "failed") throw m.lifecycle.error ?? new Error(`${m.name} failed`);
      let expired = false;
      let deadline = null;
      if (waitMs > 0) {
        deadline = this.timers.setTimeout(() => {
          expired = true;
          this.notify();
        }, waitMs);
        deadline?.unref?.();
      }
      try {
        for (;;) {
          if (signal?.aborted) throw abortError();
          const woke = await this._enqueue(() => this._wakeIn(m, signal, preview));
          if (woke) return;
          // No room: wait for a machine to be idle, out of the queue
          const busy = this.awake().filter((x) => x !== m).map((x) => x.name);
          if (expired) {
            const e = new Error(`no machine slot free: ${m.name} waited ${Math.round(waitMs / 100) / 10} s to wake, and every awake machine is busy ` +
              `(${busy.join(", ")}) with ${this._budget} allowed at once; raise the awake limit, or close the preview`);
            e.name = "TimeoutError";
            throw e;
          }
          this.waiting = `${m.name} waits to wake: every awake machine is busy (${busy.join(", ")}), and ${this._budget} may be awake at once`;
          this._changed();
          await this._sleep(signal);
        }
      } finally {
        if (deadline !== null) this.timers.clearTimeout(deadline);
        if (this.waiting?.startsWith(`${m.name} `)) {
          this.waiting = null;
          this._changed();
        }
      }
    }

    /** In the queue: room made for `m` and `m` woken (true), or false when every other awake
     *  machine is busy (the caller waits, out of the queue, and asks again). */
    async _wakeIn(m, signal, preview) {
      let retried = false;
      for (;;) {
        if (signal?.aborted) throw abortError();
        if (m.lifecycle.state === "running") return true;
        if (m.lifecycle.state === "failed") throw m.lifecycle.error ?? new Error(`${m.name} failed`);
        // Room for it: suspend the least recently used idle machine until there is
        const skip = new Set();
        while (this.awake().filter((x) => x !== m).length >= this._budget) {
          if (signal?.aborted) throw abortError();
          if (await this._evict(m, skip)) continue;
          const others = this.awake().filter((x) => x !== m);
          if (preview && others.some((x) => x.previewHeld?.())) {
            this.over = `${others.length + 1} machines are awake, over the limit of ${this._budget}: ${m.name} was woken for the preview, ` +
              "beside the machines it holds; the ones over the limit are suspended once idle (close the preview to let them go)";
            this._changed();
            break;
          }
          return false;
        }
        if (this.waiting?.startsWith(`${m.name} `)) {
          this.waiting = null;
          this._changed();
        }
        try {
          m.lastUsed = this.now();
          await m.lifecycle.wake();
          this._changed();
          return true;
        } catch (e) {
          this._changed();
          // Out of memory: one more machine to sleep, then once more
          if (!outOfMemory(e) || retried) {
            if (outOfMemory(e)) throw new Error(`${m.name} could not wake: the browser has no memory for another machine (${e.message ?? e})`);
            throw e;
          }
          retried = true;
          if (!(await this._evict(m))) {
            throw new Error(`${m.name} could not wake: the browser has no memory for another machine, and no idle machine to suspend (${e.message ?? e})`);
          }
        }
      }
    }

    /** Suspend `m` in turn (never a busy one: that resolves false). For the idle and hidden
     *  timers, and for a person or an agent asking. */
    suspend(m, reason = "asked") {
      if (m.lifecycle.state !== "running") return Promise.resolve(false);
      return this._enqueue(async () => {
        if (m.lifecycle.state !== "running" || m.busy()) {
          // Busy: the machine's own timers look again later
          if (m.lifecycle.state === "running") m.lifecycle.touch();
          return false;
        }
        const r = await m.lifecycle.suspend(reason);
        this._changed();
        return r;
      });
    }

    /** Anything else that must not overlap a capture or a boot (start fresh, say), in turn. */
    exclusive(fn) {
      return this._enqueue(fn);
    }
  }

  function abortError() {
    const e = new Error("cancelled");
    e.name = "AbortError";
    return e;
  }

  const SnowglobeScheduler = { Scheduler, outOfMemory, abortError, defaults: { DEFAULT_BUDGET, MAX_BUDGET } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeScheduler;
  else root.SnowglobeScheduler = SnowglobeScheduler;
})(typeof window !== "undefined" ? window : globalThis);
