// Suspend and wake: the machine's life on a page (machine.js), and the agent API over it
const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./machine.js');
const A = require('./agent.js');
const P = require('./agent-panel.js');

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

// A clock and timers the test moves by hand
function clock() {
  let now = 0;
  let next = 1;
  const pending = new Map();
  return {
    now: () => now,
    setTimeout: (fn, ms) => { const id = next++; pending.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => pending.delete(id),
    setInterval: () => next++,
    clearInterval: () => {},
    pending,
    // Move time on without running anything
    skip: (ms) => { now += ms; },
    pending,
    // Move time on, running what falls due
    advance: async (ms) => {
      now += ms;
      for (const [id, t] of [...pending].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && pending.has(id)) { pending.delete(id); t.fn(); }
      }
      await settle();
    },
  };
}

// A machine with page hooks that record what they were asked to do
function life(o = {}) {
  const c = clock();
  const calls = { suspend: 0, wake: 0, states: [] };
  let busy = false;
  let release = null;
  const m = new M.Machine({
    busy: () => busy,
    suspend: async () => { calls.suspend++; return { saved: calls.suspend }; },
    wake: (saved) => {
      calls.wake++;
      calls.woke = saved;
      // Each wake takes as long as the test says: it resolves when released
      return new Promise((resolve) => { release = () => { c.advance(1500); resolve(); }; });
    },
    onchange: (s) => calls.states.push(s),
    ...o.hooks,
  }, { idleMs: 300000, hiddenMs: 60000, timers: c, now: c.now, ...o.opts });
  return { m, c, calls, setBusy: (b) => { busy = b; }, release: () => release?.() };
}

test('idle: suspended after the idle time with nothing run; activity starts the clock again', async () => {
  const { m, c, calls } = life();
  assert.equal(m.state, 'starting');
  await c.advance(400000);
  assert.equal(calls.suspend, 0, 'not before it has started');
  m.started();
  await c.advance(299000);
  m.touch();
  await c.advance(299000);
  assert.equal(m.state, 'running', 'touched: the clock started again');
  await c.advance(1000);
  assert.equal(m.state, 'suspended');
  assert.equal(calls.suspend, 1);
  assert.equal(m.reason, 'idle');
  assert.deepEqual(calls.states, ['running', 'suspending', 'suspended']);
  assert.equal(c.pending.size, 0, 'no timers left while suspended');
});

test('hidden: suspended once the page has been hidden for a while, not when shown again before', async () => {
  const { m, c, calls } = life();
  m.started();
  m.setHidden(true);
  await c.advance(59000);
  m.setHidden(false);
  await c.advance(59000);
  assert.equal(m.state, 'running');
  m.setHidden(true);
  await c.advance(60000);
  assert.equal(m.state, 'suspended');
  assert.equal(m.reason, 'hidden');
  assert.equal(calls.suspend, 1);
});

test('never mid-job: a busy machine stays running, and is suspended once the job is over and it idles', async () => {
  const { m, c, calls, setBusy } = life();
  m.started();
  setBusy(true);
  await c.advance(300000);
  assert.equal(m.state, 'running');
  assert.equal(await m.suspend('asked'), false, 'asked to: refused while busy');
  m.setHidden(true);
  await c.advance(60000);
  assert.equal(m.state, 'running', 'hidden and busy: still running');
  assert.equal(calls.suspend, 0);
  setBusy(false);
  m.setHidden(false);
  m.touch(); // the job ended
  await c.advance(300000);
  assert.equal(m.state, 'suspended');
  assert.equal(calls.suspend, 1);
});

test('a suspend that fails leaves the machine running, its clock re-armed', async () => {
  const { m, c } = life({ hooks: { suspend: async () => { throw new Error('quota'); } } });
  m.started();
  assert.equal(await m.suspend(), false);
  assert.equal(m.state, 'running');
  assert.equal(m.error.message, 'quota');
  assert.equal(c.pending.size, 1, 'the idle clock again');
});

test('wake: from the saved state, once however many ask, and timed', async () => {
  const { m, c, calls, release } = life();
  m.started();
  await m.suspend();
  assert.equal(m.state, 'suspended');
  const a = m.wake();
  const b = m.wake();
  await settle();
  assert.equal(m.state, 'waking');
  assert.equal(calls.wake, 1, 'one wake');
  assert.deepEqual(calls.woke, { saved: 1 }, 'from what the suspend saved');
  release();
  await Promise.all([a, b]);
  assert.equal(m.state, 'running');
  assert.equal(m.wakeMs, 1500);
  assert.equal(m.describe().wakeSeconds, 1.5);
  assert.equal(m.saved, null, 'the saved state let go once running');
  assert.ok(c.pending.size >= 1, 'the idle clock runs again');
  await m.wake();
  assert.equal(calls.wake, 1, 'awake already: nothing to do');
});

test('a wake asked for while it suspends waits for the suspend, then wakes', async () => {
  let finish;
  const { m, calls, release } = life({ hooks: { suspend: () => new Promise((r) => { finish = () => r('s'); }) } });
  m.started();
  m.suspend();
  assert.equal(m.state, 'suspending');
  const w = m.wake();
  finish();
  await settle();
  assert.equal(m.state, 'waking');
  assert.equal(calls.woke, 's');
  release();
  await w;
  assert.equal(m.state, 'running');
});

test('a failed wake leaves it suspended, its state kept, and the next wake tries again', async () => {
  let fail = 1;
  const woke = [];
  const { m } = life({ hooks: { wake: async (saved) => {
    woke.push(saved);
    // As new Armless throws when the browser has no memory for it
    if (fail-- > 0) throw new RangeError('WebAssembly.Memory(): could not allocate memory');
  } } });
  m.started();
  await m.suspend();
  await assert.rejects(m.wake(), RangeError);
  assert.equal(m.state, 'suspended');
  assert.match(m.describe().lastWakeError, /could not allocate memory/);
  assert.deepEqual(m.saved, { saved: 1 }, 'the saved state kept for the next try');
  await m.wake();
  assert.equal(m.state, 'running');
  assert.deepEqual(woke, [{ saved: 1 }, { saved: 1 }], 'both from the same state');
  assert.equal(m.error, null);
  assert.equal(m.describe().lastWakeError, null);
});

test('three failed wakes in a row fail the machine, and say why; one that works in between starts the count again', async () => {
  let fail = 0;
  const { m } = life({ hooks: { wake: async () => { if (fail-- > 0) throw new Error('restore failed'); } } });
  m.started();
  fail = 2;
  await m.suspend();
  await assert.rejects(m.wake(), /restore failed/);
  await assert.rejects(m.wake(), /restore failed/);
  await m.wake();
  assert.equal(m.state, 'running');
  fail = 3;
  await m.suspend();
  await assert.rejects(m.wake(), /restore failed/);
  await assert.rejects(m.wake(), /restore failed/);
  assert.equal(m.state, 'suspended');
  await assert.rejects(m.wake(), /restore failed/);
  assert.equal(m.state, 'failed');
  assert.equal(m.error.message, 'restore failed');
  await assert.rejects(m.wake(), /the machine is failed/);
});

// The agent API over a machine that suspends: each wake makes a new emulator, as the page does
function page() {
  const c = clock();
  const emulators = [];
  const make = () => {
    const listeners = {};
    const e = {
      typed: [],
      on: (name, fn) => { (listeners[name] ??= []).push(fn); },
      serial_input: (s) => e.typed.push(s),
      print: (text) => listeners.serial?.forEach((fn) => fn(new TextEncoder().encode(text))),
    };
    emulators.push(e);
    return e;
  };
  let emulator = make();
  let run = 'ready';
  let agent;
  let release = null;
  let fail = null;
  const lifecycle = new M.Machine({
    busy: () => !!agent._controller.current,
    suspend: async () => { emulator = null; return 'state'; },
    wake: () => new Promise((resolve, reject) => {
      release = () => { c.skip(1500); emulator = make(); agent._controller.bind(emulator); resolve(); };
      // A wake that fails makes no machine
      fail = (e) => reject(e);
    }),
    onchange: (s) => { run = { running: 'ready', failed: 'error' }[s] ?? s; },
  }, { timers: c, now: c.now });
  agent = A.attach({ get emulator() { return emulator; }, lifecycle, cpus: 1, network: 'none', buildId: 'b', version: 'v0',
    state: () => run, saving: () => false }, { timers: c, now: c.now });
  lifecycle.started();
  return { agent, lifecycle, emulators, c, release: () => release(), fail: (e) => fail(e) };
}

// Plays the guest on `e` for the current job, to its end with `status`
function play(agent, e, out, status) {
  const job = agent._controller.current;
  for (;;) {
    const line = e.typed[e.typed.length - 1];
    let m;
    if ((m = /^echo SGSYNC_(\w+)_/.exec(line))) e.print(`SGSYNC_${m[1]}_42\r\n`);
    else if ((m = /echo SGACK_(\w+)_(\d+)_/.exec(line))) e.print(`SGACK_${m[1]}_${m[2]}_0_42\r\n`);
    else if (line.startsWith('sh /sgjob/')) { e.print(`\nSGNONCE_${job.id}\n`); break; }
  }
  e.print(`SGOUT_${job.id}_${job.nonce}\n${out}\nSGDONE_${job.id}_${job.nonce}_${status}_0\n`);
  return job;
}

test('agent: status and capabilities say suspended and waking; a command wakes the machine, then runs in the new one', async () => {
  const { agent, lifecycle, emulators, release } = page();
  assert.deepEqual((await agent.capabilities()).features, ['runCommand', 'readJob', 'cancelJob', 'suspend']);
  assert.equal(await agent.suspend(), true);
  assert.equal((await agent.status()).state, 'suspended');
  assert.equal((await agent.status()).wakeSeconds, 1, 'a guess until a wake is measured');
  const caps = await agent.capabilities();
  assert.equal(caps.machine.state, 'suspended');
  assert.equal(caps.machine.suspendedBecause, 'asked');
  assert.equal(caps.machine.suspendsAfterIdleSeconds, 300);
  assert.equal(caps.workingDirectory, 'home');

  // A bad command wakes nothing
  await assert.rejects(agent.runCommand({ command: '' }), /non-empty/);
  assert.equal(lifecycle.state, 'suspended');

  const first = agent.runCommand({ command: 'cat note.txt' });
  const second = agent.runCommand({ command: 'echo again' });
  await settle();
  assert.equal((await agent.status()).state, 'waking');
  assert.equal((await agent.capabilities()).machine.state, 'waking');
  assert.equal(emulators.length, 1, 'nothing typed, no new machine yet');
  release();
  const { jobId } = await first;
  // The second waited for the same wake (not one of its own), then found the one job running
  await assert.rejects(second, /busy: job/);
  assert.equal(emulators.length, 2, 'one wake');
  assert.equal(emulators[0].typed.length, 0, 'nothing typed into the suspended machine');
  assert.match(emulators[1].typed[0], /^echo SGSYNC_/);
  play(agent, emulators[1], 'hi', 0);
  const v = await agent.readJob(jobId);
  assert.equal(v.state, 'exited');
  assert.equal(v.output, 'hi');
  assert.equal(lifecycle.state, 'running');
});

test('agent: never suspended mid-job, by the API or the idle clock', async () => {
  const { agent, lifecycle, emulators, c } = page();
  await agent.runCommand({ command: 'sleep 1000' });
  assert.equal(await agent.suspend(), false);
  await c.advance(10 * 60 * 1000);
  assert.equal(lifecycle.state, 'running');
  assert.equal((await agent.status()).state, 'busy');
  play(agent, emulators[0], '', 0);
  // The job's end starts the idle clock again
  await c.advance(299000);
  assert.equal(lifecycle.state, 'running');
  await c.advance(1000);
  assert.equal(lifecycle.state, 'suspended');
});

test('agent: a retried request id returns its job without waking the machine', async () => {
  const { agent, lifecycle, emulators } = page();
  const { jobId } = await agent.runCommand({ command: 'true', requestId: 'r1' });
  play(agent, emulators[0], '', 0);
  await agent.suspend();
  assert.deepEqual(await agent.runCommand({ command: 'true', requestId: 'r1' }), { jobId, repeated: true });
  assert.equal(lifecycle.state, 'suspended');
});

test('jobs start in the home directory, with their own scratch directory as $EXCLAVE_WORKSPACE', () => {
  const { launcher, cmd } = A.scripts('id', '/sgjob/id', 'cat data/sales.csv');
  const lines = cmd.trim().split('\n');
  assert.equal(lines.at(-1), 'cat data/sales.csv');
  assert.equal(lines.at(-2), 'cd "${HOME:-/root}" 2>/dev/null || cd /', 'after the image env, which may set HOME');
  assert.ok(lines.indexOf("export EXCLAVE_WORKSPACE='/sgjob/id'") > lines.findIndex((l) => l.includes('/etc/snowglobe/env')));
  assert.ok(!cmd.includes("cd '/sgjob/id'"));
  // The launcher still keeps its files in the job's directory
  assert.match(launcher, /cd '\/sgjob\/id' \|\| exit 1/);
});

// The panel's elements, as plain objects
function els() {
  const el = (o = {}) => {
    const handlers = {};
    return { value: '', disabled: false, textContent: '', ...o,
      addEventListener: (n, fn) => { (handlers[n] ??= []).push(fn); },
      fire: (n, e = {}) => handlers[n]?.forEach((fn) => fn({ preventDefault() {}, ...e })), focus() {} };
  };
  return { form: el(), command: el(), run: el(), cancel: el(), status: el(), result: el(), output: el(), suspend: el() };
}

test('panel: Suspend and Wake, the status line says how long a wake takes, and Run wakes it', async () => {
  const { agent, lifecycle, emulators, release, c } = page();
  const e = els();
  const drawn = [];
  const p = new P.Panel(agent, e, { ask: async () => {}, jobText: A.jobText, timers: c, now: c.now, render: (runs) => drawn.push(runs.map((r) => r.state)) });
  await settle();
  assert.equal(e.suspend.textContent, 'Suspend');
  assert.equal(e.suspend.disabled, false);
  e.suspend.fire('click');
  await settle();
  assert.equal(lifecycle.state, 'suspended');
  assert.equal(e.status.textContent, 'Suspended to free memory. The next command wakes it (about 1 s).');
  assert.equal(e.suspend.textContent, 'Wake');
  assert.equal(e.run.disabled, false, 'Run is offered: it wakes the machine');

  e.command.value = 'cat note.txt';
  e.form.fire('submit');
  await settle();
  assert.equal(e.status.textContent, 'Waking the machine from its saved state (about 1 s)…');
  assert.ok(e.run.disabled);
  assert.ok(e.suspend.disabled);
  release();
  await settle();
  assert.match(e.status.textContent, /^Running job/);
  play(agent, emulators[1], 'hi', 0);
  await c.advance(300);
  assert.equal(e.result.textContent, 'Exit status: 0');
  assert.equal(e.output.textContent, 'hi\n[exit 0]');
  assert.deepEqual(drawn.at(-1), ['exited']);
  // The wake was measured (1.5 s on this clock): the next estimate is that
  await agent.suspend();
  await p.refresh();
  assert.equal(e.status.textContent, 'Suspended to free memory. The next command wakes it (about 2 s).');
  assert.equal(p.runs[0].command, 'cat note.txt');
});

test('panel: runs are listed newest first, with a refusal as not allowed', async () => {
  const { agent, emulators, c } = page();
  const e = els();
  let allow = true;
  const p = new P.Panel(agent, e, { ask: async () => { if (!allow) throw new Error('the person at the page did not allow it'); }, jobText: A.jobText, timers: c, now: c.now });
  await settle();
  e.command.value = "python3 -c 'print(6*7)'";
  e.form.fire('submit');
  await settle();
  play(agent, emulators[0], '42', 0);
  await c.advance(300);
  e.command.value = 'exit 3';
  e.form.fire('submit');
  await settle();
  play(agent, emulators[0], '', 3);
  await c.advance(300);
  allow = false;
  e.command.value = 'rm -rf /';
  e.form.fire('submit');
  await settle();
  assert.deepEqual(p.runs.map((r) => [r.command, P.badge(r).text]),
    [['rm -rf /', 'not allowed'], ['exit 3', 'exit 3'], ["python3 -c 'print(6*7)'", 'exit 0']]);
  assert.equal(e.result.textContent, 'Not allowed');
  assert.equal(P.duration(400), '0.4 s');
  assert.equal(P.duration(184000), '3 min 4 s');
});

test('agent: a command whose wake fails is refused, the machine stays suspended, and the next command wakes it and runs', async () => {
  const { agent, lifecycle, emulators, release, fail } = page();
  await agent.suspend();
  const first = agent.runCommand({ command: 'cat note.txt' });
  await settle();
  fail(new RangeError('out of memory'));
  await assert.rejects(first, /out of memory/);
  assert.equal(lifecycle.state, 'suspended');
  const st = await agent.status();
  assert.equal(st.state, 'suspended');
  assert.equal(st.lastWakeError, 'out of memory');
  assert.equal(emulators.length, 1, 'no machine made');

  const second = agent.runCommand({ command: 'cat note.txt' });
  await settle();
  release();
  const { jobId } = await second;
  play(agent, emulators[1], 'kept', 0);
  assert.equal((await agent.readJob(jobId)).output, 'kept');
  assert.equal((await agent.status()).lastWakeError, undefined);
});

test('panel: Cancel while the machine wakes drops the run; the wake finishes, and nothing runs', async () => {
  const { agent, lifecycle, emulators, release, c } = page();
  const e = els();
  const p = new P.Panel(agent, e, { ask: async () => {}, jobText: A.jobText, timers: c, now: c.now });
  await settle();
  await agent.suspend();
  await p.refresh();
  assert.equal(e.cancel.disabled, true, 'nothing to cancel yet');
  e.command.value = 'touch /root/should-not-exist';
  e.form.fire('submit');
  await settle();
  assert.equal(lifecycle.state, 'waking');
  assert.equal(e.cancel.disabled, false, 'Cancel is offered while it wakes');
  e.cancel.fire('click');
  await settle();
  assert.equal(e.status.textContent, 'Cancelled before it ran: nothing ran. Waking the machine from its saved state (about 1 s)…');
  assert.equal(e.result.textContent, 'Cancelled');
  assert.equal(e.cancel.disabled, true);
  assert.deepEqual(p.runs.map((r) => [r.command, r.state]), [['touch /root/should-not-exist', 'cancelled']]);
  release();
  await settle();
  await p.refresh(); // as the page's lifecycle does on each change
  assert.equal(lifecycle.state, 'running', 'the wake went on');
  assert.equal(emulators.length, 2);
  assert.equal(emulators[1].typed.length, 0, 'nothing typed into the woken machine');
  assert.equal(agent._controller.current, null);
  assert.equal(e.status.textContent, 'Cancelled before it ran: nothing ran. Ready for the next command.');
  assert.equal(e.run.disabled, false);

  // The next run runs
  e.command.value = 'echo ok';
  e.form.fire('submit');
  await settle();
  play(agent, emulators[1], 'ok', 0);
  await c.advance(300);
  assert.equal(e.output.textContent, 'ok\n[exit 0]');
});

test('panel: a failed wake says so, and Run is offered again to retry it', async () => {
  const { agent, lifecycle, emulators, release, fail, c } = page();
  const e = els();
  new P.Panel(agent, e, { ask: async () => {}, jobText: A.jobText, timers: c, now: c.now });
  await settle();
  await agent.suspend();
  e.command.value = 'ls';
  e.form.fire('submit');
  await settle();
  fail(new Error('the saved state could not be read'));
  await settle();
  assert.equal(e.status.textContent, 'Not run: the saved state could not be read.');
  assert.equal(lifecycle.state, 'suspended');
  assert.equal(e.run.disabled, false);
  assert.equal(e.cancel.disabled, true);
  e.form.fire('submit');
  await settle();
  release();
  await settle();
  assert.match(e.status.textContent, /^Running job/);
  play(agent, emulators[1], 'a', 0);
  await c.advance(300);
  assert.equal(e.result.textContent, 'Exit status: 0');
});

test('panel: Ctrl+Enter runs only when Run would', async () => {
  const { agent, emulators, c } = page();
  const e = els();
  new P.Panel(agent, e, { ask: async () => {}, jobText: A.jobText, timers: c, now: c.now });
  await settle();
  e.command.value = 'true';
  e.run.disabled = true; // as while the machine starts, or has failed
  e.command.fire('keydown', { key: 'Enter', ctrlKey: true });
  await settle();
  assert.equal(emulators[0].typed.length, 0, 'nothing ran');
  e.run.disabled = false;
  e.command.fire('keydown', { key: 'Enter', metaKey: true });
  await settle();
  assert.match(emulators[0].typed[0], /^echo SGSYNC_/);
});

test('the guest network drops cache-hint headers (pip sends them, and they would force a CORS preflight)', async () => {
  const { guestFetch } = require('./machine-core.js');
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push([url, init]); return {}; };
  try {
    await guestFetch('https://pypi.org/simple/rich/', { method: 'GET', headers: new Headers([['Accept', 'text/html'], ['Cache-Control', 'max-age=0'], ['Pragma', 'no-cache'], ['Authorization', 'x']]) });
    await guestFetch('https://pypi.org/x');
  } finally { globalThis.fetch = real; }
  assert.deepEqual([...seen[0][1].headers.keys()].sort(), ['accept', 'authorization']);
  assert.equal(seen[0][1].method, 'GET');
  assert.equal(seen[1][1], undefined);
});
