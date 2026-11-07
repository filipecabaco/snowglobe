// The page's memory budget (scheduler.js) over lifecycles (machine.js) whose suspend and wake are stand-ins
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Scheduler, outOfMemory, defaults } = require('./scheduler.js');
const { Machine } = require('./machine.js');

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

// Timers that never fire on their own (the idle and hidden clocks), but can be stepped
function timers() {
  let n = 1;
  const pending = new Map();
  return { pending, setTimeout: (fn) => { const id = n++; pending.set(id, fn); return id; }, clearTimeout: (id) => pending.delete(id),
    fire() { const due = [...pending.values()]; pending.clear(); due.forEach((fn) => fn()); } };
}

// A page of machines; `log` says what happened, in order. A wake or a suspend takes a tick, and
// records how many captures and boots overlap
function page(names, { budget = 2, wakeFails = {} } = {}) {
  const log = [];
  const t = timers();
  let clock = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const s = new Scheduler({ budget, timers: t, now: () => ++clock });
  const ms = names.map((name) => {
    const m = { name, job: false, lastUsed: 0, busy() { return this.job; } };
    const op = async (what) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setImmediate(r));
      inFlight--;
      log.push(`${what} ${name}`);
    };
    m.lifecycle = new Machine({
      busy: () => m.busy(),
      suspend: () => op('suspend'),
      wake: async () => {
        const fails = wakeFails[name];
        if (fails && fails.length) {
          const e = fails.shift();
          log.push(`wake ${name} failed`);
          throw e;
        }
        await op('wake');
      },
      requestSuspend: (reason) => s.suspend(m, reason),
    }, { state: 'suspended', timers: t, idleMs: 1000, hiddenMs: 1000 });
    return s.add(m);
  });
  return { s, ms, log, t, get maxInFlight() { return maxInFlight; }, by: (n) => ms.find((m) => m.name === n) };
}

test('the awake limit is 2 unless set, 1 to 8; and what an out-of-memory error looks like', () => {
  assert.equal(new Scheduler().budget, 2);
  assert.deepEqual(defaults, { DEFAULT_BUDGET: 2, MAX_BUDGET: 8 });
  for (const bad of [0, 9, 1.5, '2', null]) assert.throws(() => new Scheduler().setBudget(bad), /the awake limit: a whole number of machines, 1 to 8/);
  assert.ok(outOfMemory(new RangeError('WebAssembly.Memory(): could not allocate memory')));
  assert.ok(outOfMemory({ name: 'RangeError', message: 'x' }), 'a RangeError from a worker, as a structured error');
  assert.ok(outOfMemory(new Error('Array buffer allocation failed')));
  assert.ok(!outOfMemory(new Error('404')));
});

test('waking a third machine suspends the least recently used idle one first, then wakes it', async () => {
  const p = page(['a', 'b', 'c']);
  await p.s.ensureAwake(p.by('a'));
  await p.s.ensureAwake(p.by('b'));
  await p.s.ensureAwake(p.by('a')); // a used again: b is now the least recently used
  assert.equal(p.s.summary(), '2 of 2 awake');
  await p.s.ensureAwake(p.by('c'));
  assert.deepEqual(p.log, ['wake a', 'wake b', 'suspend b', 'wake c']);
  assert.deepEqual(p.ms.map((m) => m.lifecycle.state), ['running', 'suspended', 'running']);
});

test('a busy machine is never suspended: the wake waits, says so, and goes on once one is idle', async () => {
  const p = page(['a', 'b', 'c']);
  await p.s.ensureAwake(p.by('a'));
  await p.s.ensureAwake(p.by('b'));
  p.by('a').job = p.by('b').job = true;
  let done = false;
  const woken = p.s.ensureAwake(p.by('c')).then(() => { done = true; });
  await settle();
  assert.equal(done, false);
  assert.match(p.s.waiting, /^c waits to wake: every awake machine is busy \(a, b\), and 2 may be awake at once$/);
  assert.deepEqual(p.log, ['wake a', 'wake b'], 'nothing suspended mid-job');
  p.by('b').job = false;
  p.s.notify();
  await woken;
  assert.deepEqual(p.log, ['wake a', 'wake b', 'suspend b', 'wake c']);
  assert.equal(p.s.waiting, null);
});

test('one capture or boot at a time, however many ask at once', async () => {
  const p = page(['a', 'b', 'c', 'd'], { budget: 1 });
  await Promise.all(p.ms.map((m) => p.s.ensureAwake(m)));
  assert.equal(p.maxInFlight, 1);
  assert.equal(p.s.awake().length, 1);
  assert.deepEqual(p.log, ['wake a', 'suspend a', 'wake b', 'suspend b', 'wake c', 'suspend c', 'wake d']);
});

test('out of memory on a wake: one more machine suspended, then once more; then a clear failure', async () => {
  const oom = () => new RangeError('could not allocate memory');
  const p = page(['a', 'b', 'c'], { budget: 3, wakeFails: { c: [oom()] } });
  await p.s.ensureAwake(p.by('a'));
  await p.s.ensureAwake(p.by('b'));
  await p.s.ensureAwake(p.by('c'));
  assert.deepEqual(p.log, ['wake a', 'wake b', 'wake c failed', 'suspend a', 'wake c']);

  const q = page(['a', 'b'], { budget: 3, wakeFails: { b: [oom(), oom()] } });
  await q.s.ensureAwake(q.by('a'));
  await assert.rejects(q.s.ensureAwake(q.by('b')), /b could not wake: the browser has no memory for another machine/);
  assert.deepEqual(q.log, ['wake a', 'wake b failed', 'suspend a', 'wake b failed']);
  assert.equal(q.by('b').lifecycle.state, 'suspended', 'its save kept, for the next try');

  const r = page(['a'], { wakeFails: { a: [new Error('state unreadable')] } });
  await assert.rejects(r.s.ensureAwake(r.by('a')), /state unreadable/, 'another failure is not retried');
});

test('the idle and hidden suspends go through the scheduler, one at a time, never a busy machine', async () => {
  const p = page(['a', 'b'], { budget: 2 });
  await p.s.ensureAwake(p.by('a'));
  await p.s.ensureAwake(p.by('b'));
  p.by('b').job = true;
  p.t.fire(); // both idle clocks run out
  await settle();
  assert.deepEqual(p.log, ['wake a', 'wake b', 'suspend a']);
  assert.equal(p.by('b').lifecycle.state, 'running', 'busy: left running, its clock re-armed');
  assert.ok(p.t.pending.size > 0);
  assert.equal(p.maxInFlight, 1);
});

test('a lower budget suspends idle machines down to it; a cancelled wake gives up', async () => {
  const p = page(['a', 'b', 'c'], { budget: 3 });
  for (const m of p.ms) await p.s.ensureAwake(m);
  p.s.budget = 1;
  await settle();
  assert.equal(p.s.awake().length, 1);
  assert.throws(() => { p.s.budget = 0; });

  const q = page(['a', 'b'], { budget: 1 });
  await q.s.ensureAwake(q.by('a'));
  q.by('a').job = true;
  const c = new AbortController();
  const w = q.s.ensureAwake(q.by('b'), { signal: c.signal });
  await settle();
  c.abort();
  await assert.rejects(w, { name: 'AbortError' });
  assert.equal(q.by('b').lifecycle.state, 'suspended');
});

test('a wake waiting for a slot waits out of the queue: other operations go on; a bounded wait fails clearly', async () => {
  const p = page(['a', 'b', 'c'], { budget: 2 });
  await p.s.ensureAwake(p.by('a'));
  await p.s.ensureAwake(p.by('b'));
  p.by('a').job = p.by('b').job = true;
  let failed = null;
  const c = p.s.ensureAwake(p.by('c'), { waitMs: 30000 }).catch((e) => { failed = e; });
  await settle();
  assert.match(p.s.waiting, /^c waits to wake/);
  // Something else that must not overlap a boot runs meanwhile: the queue is not held
  assert.equal(await p.s.exclusive(async () => 'ran'), 'ran');
  p.t.fire(); // the 30 s bound (and every other clock) runs out
  await c;
  assert.equal(failed?.name, 'TimeoutError');
  assert.match(failed.message, /^no machine slot free: c waited 30 s to wake, and every awake machine is busy \(a, b\) with 2 allowed at once; raise the awake limit, or close the preview$/);
  assert.equal(p.s.waiting, null);
  assert.equal(p.by('c').lifecycle.state, 'suspended');
});

test('a wake for the preview goes beyond the limit when the preview\'s own machines fill it; any other waits', async () => {
  const p = page(['web', 'supabase', 'python'], { budget: 1 });
  const web = p.by('web');
  await p.s.ensureAwake(web);
  web.previewHeld = () => true;
  web.job = true; // held by the preview: busy
  await p.s.ensureAwake(p.by('supabase'), { preview: true });
  assert.equal(p.by('supabase').lifecycle.state, 'running');
  assert.equal(p.s.awake().length, 2);
  assert.match(p.s.over, /over the limit of 1: supabase was woken for the preview/);
  // A run elsewhere is not the preview's: it waits (supabase is idle, so it is made room for)
  p.by('supabase').job = true;
  let woke = false;
  const py = p.s.ensureAwake(p.by('python')).then(() => { woke = true; });
  await settle();
  assert.equal(woke, false);
  assert.match(p.s.waiting, /python waits to wake/);
  // The preview closes: its machines are idle again, and python gets a slot
  web.previewHeld = () => false;
  web.job = p.by('supabase').job = false;
  p.s.notify();
  await py;
  assert.equal(woke, true);
});
