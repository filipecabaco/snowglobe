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
  assert.equal(e.status.textContent, 'Asleep. The next command wakes it (about 1 s).');
  assert.equal(e.suspend.textContent, 'Wake');
  assert.equal(e.run.disabled, false, 'Run is offered: it wakes the machine');

  e.command.value = 'cat note.txt';
  e.form.fire('submit');
  await settle();
  assert.equal(e.status.textContent, 'Waking (about 1 s)…');
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
  assert.equal(e.status.textContent, 'Asleep. The next command wakes it (about 2 s).');
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
  assert.equal(e.status.textContent, 'Cancelled before it ran: nothing ran. Waking (about 1 s)…');
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

test('the guest network sends a link\'s name to the machine it names, through the page, and nothing else', async () => {
  const { guestFetch, linked } = require('./machine-core.js');
  const base = 'https://x.example/snowglobe/fleet/';
  const links = Object.assign(Object.create(null), { 'feed.internal': { runtime: 'python', port: 9000 } });
  assert.equal(linked('http://feed.internal/', links, base), 'https://x.example/snowglobe/fleet/preview/python/9000/');
  assert.equal(linked('https://feed.internal:8443/a/b?c=1', links, base), 'https://x.example/snowglobe/fleet/preview/python/9000/a/b?c=1', 'any port of the name goes to the link\'s');
  assert.equal(linked('http://other.internal/', links, base), 'http://other.internal/');
  assert.equal(linked('http://feed.internal.evil.example/', links, base), 'http://feed.internal.evil.example/');
  assert.equal(linked('http://constructor/', links, base), 'http://constructor/', 'names are own keys only');
  assert.equal(linked('http://feed.internal/', undefined, base), 'http://feed.internal/');
  assert.equal(linked('http://feed.internal/', links, undefined), 'http://feed.internal/');
  assert.equal(linked('not a url', links, base), 'not a url');
  const seen = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push([url, init]); return {}; };
  try {
    await guestFetch('http://feed.internal/x', { method: 'POST', body: 'b', headers: new Headers([['Accept', '*/*'], ['Pragma', 'no-cache']]) }, links, base);
    await guestFetch('https://pypi.org/x', undefined, links, base);
  } finally { globalThis.fetch = real; }
  assert.equal(seen[0][0], 'https://x.example/snowglobe/fleet/preview/python/9000/x');
  assert.equal(seen[0][1].method, 'POST');
  assert.deepEqual([...seen[0][1].headers.keys()], ['accept']);
  assert.equal(seen[1][0], 'https://pypi.org/x');
});

// ------------------------------------------------------------------ raw TCP over links

// armless as far as links go: it keeps the network options it was given, and its tunnel code
// (armless.js's _tunnel_open, as built) is played by `tunnel()` below
class LinkArmless {
  constructor(o) { this.options = o; this.ready = Promise.resolve(); LinkArmless.last = this; }
  on() {}
  run() {}
  destroy() {}
}
// What armless's _tunnel_open does with the WebSocket class: one argument, binaryType, the on*
// handlers, send() while readyState is 1, close(1000) while it is at most 1, on the guest's end and close
function tunnel(WS, url) {
  const g = { log: [], state: 'held' };
  const socket = new WS(url);
  socket.binaryType = 'arraybuffer';
  let opened = false;
  socket.onopen = () => { opened = true; g.state = 'open'; g.log.push('accept'); };
  socket.onmessage = ({ data }) => g.log.push(`write ${typeof data === 'string' ? data : new TextDecoder().decode(new Uint8Array(data))}${data instanceof ArrayBuffer ? '' : ' (not an ArrayBuffer)'}`);
  socket.onclose = () => { g.state = 'closed'; g.log.push(opened ? 'fin' : 'refuse'); };
  g.socket = socket;
  g.send = (s) => socket.readyState === 1 && socket.send(s);
  g.end = () => socket.readyState <= 1 && socket.close(1000);
  return g;
}
const tick = () => new Promise((r) => setImmediate(r));
const MC = require('./machine-core.js');
const db = MC.linkUrl('supabase', 5432);

async function linkCore(tunnels = [{ host: 'db.internal', port: 5432, url: db }], o = {}) {
  const events = [];
  const real = [];
  class RealWS { constructor(...a) { this.args = a; real.push(this); } }
  const core = new MC.Core({ config: { network: { tls: 't', tunnels }, filesystem: { json: 'f', baseurl: 'b' } }, Armless: LinkArmless, agent: null,
    emit: (e, p) => events.push([e, p]) });
  core.WebSocket = RealWS;
  await core.boot('s');
  core.run();
  return { core, events, real, RealWS, WS: LinkArmless.last.options.network.WebSocket, links: () => events.filter(([e]) => e === 'link').map(([, p]) => p), ...o };
}

test('links over TCP: armless\'s WebSocket for a link url is the page, as armless uses it: open, connect, bytes both ways, the guest\'s half-close, then its close', async () => {
  const { core, WS, links } = await linkCore();
  assert.equal(LinkArmless.last.options.network.tunnels[0].url, 'wss://link.invalid/supabase/5432', 'the tunnels as given');
  assert.equal(typeof LinkArmless.last.options.network.fetch, 'function', 'fetch still the guest\'s');
  const g = tunnel(WS, db);
  assert.equal(g.socket.readyState, WS.CONNECTING);
  assert.equal(g.socket.bufferedAmount, 0);
  assert.equal(g.socket.url, db);
  assert.deepEqual(links(), [{ cid: 1, kind: 'open', runtime: 'supabase', port: 5432 }]);
  assert.throws(() => g.socket.send(new Uint8Array([1])), /connecting/, 'as a WebSocket: no send before it opens');
  await core.linkIn(1, 'connect');
  assert.deepEqual(g.log, ['accept']);
  assert.equal(g.socket.readyState, WS.OPEN);
  // The guest's bytes: a copy of a view into a bigger buffer, as armless's are
  const buf = new TextEncoder().encode('xxSELECT 1yy');
  g.send(buf.subarray(2, 10));
  buf.fill(0);
  assert.equal(new TextDecoder().decode(links()[1].bytes), 'SELECT 1');
  assert.equal(links()[1].bytes.byteLength, links()[1].bytes.buffer.byteLength, 'a buffer of its own (handed over whole by the worker)');
  // The server's bytes, as an ArrayBuffer
  assert.equal(await core.linkIn(1, 'data', new TextEncoder().encode('row 1')), true);
  assert.deepEqual(g.log.at(-1), 'write row 1');
  // The guest's FIN: the page's side ends, and the server's answer still comes
  g.end();
  assert.deepEqual(links().at(-1), { cid: 1, kind: 'end' });
  assert.equal(g.socket.readyState, WS.OPEN, 'still open, so that the guest\'s close reaches it too');
  await core.linkIn(1, 'data', new TextEncoder().encode('bye'));
  assert.deepEqual(g.log.at(-1), 'write bye');
  // The guest's connection over (armless calls close again): closed at once
  g.end();
  assert.deepEqual(links().at(-1), { cid: 1, kind: 'close' });
  assert.equal(g.socket.readyState, WS.CLOSED);
  await tick();
  assert.equal(g.log.at(-1), 'fin');
  assert.equal(await core.linkIn(1, 'data', new TextEncoder().encode('late')), false, 'dropped: it is over');
  g.end();
  assert.equal(links().length, 4, 'nothing more said');
});

test('links over TCP: refused (nothing listens), the server\'s end and an error close the guest\'s side; addEventListener hears as on* does', async () => {
  const { core, WS, links } = await linkCore();
  // Refused: a close before any connect; never opened, so armless refuses the guest's SYN
  const r = tunnel(WS, db);
  const heard = [];
  r.socket.addEventListener('error', () => heard.push('error'));
  r.socket.addEventListener('close', (e) => heard.push(`close ${e.code} ${e.wasClean}`));
  await core.linkIn(1, 'close');
  assert.deepEqual(r.log, ['refuse']);
  assert.deepEqual(heard, ['error', 'close 1006 false']);
  // The server's end: the guest's side is closed after what came
  const s = tunnel(WS, db);
  await core.linkIn(2, 'connect');
  await core.linkIn(2, 'data', new TextEncoder().encode('last'));
  await core.linkIn(2, 'end');
  assert.deepEqual(s.log, ['accept', 'write last', 'fin']);
  assert.equal(s.socket.readyState, WS.CLOSED);
  s.end(); // armless won't, at readyState 3; and if it did, nothing is said
  // An error (the machine it reached went away): the guest's side closed
  const e = tunnel(WS, db);
  await core.linkIn(3, 'connect');
  await core.linkIn(3, 'error');
  assert.deepEqual(e.log, ['accept', 'fin']);
  // An abort of a half-open attempt (the guest gave up on its SYN): said, and refused
  const h = tunnel(WS, db);
  h.end();
  assert.deepEqual(links().at(-1), { cid: 4, kind: 'close' });
  await tick();
  assert.deepEqual(h.log, ['refuse']);
  await core.linkIn(4, 'connect');
  assert.deepEqual(h.log, ['refuse'], 'too late: nothing');
  assert.equal(core.links.size, 0, 'nothing kept');
});

test('links over TCP: only this machine\'s link urls are carried; anything else, and a guest\'s own WebSocket, is the real WebSocket', async () => {
  const { WS, real, RealWS, links } = await linkCore();
  const other = new WS('wss://example.com/socket');
  assert.ok(other instanceof RealWS);
  assert.deepEqual(other.args, ['wss://example.com/socket']);
  // A link url this machine wasn't given: never carried (the guest can't reach it through the page)
  const notMine = new WS(MC.linkUrl('python', 22));
  assert.ok(notMine instanceof RealWS);
  // The guest's own WebSocket naming its own link url (armless passes its protocols): not carried
  const guests = new WS(db, []);
  assert.ok(guests instanceof RealWS);
  assert.deepEqual(guests.args, [db, []]);
  assert.equal(real.length, 3);
  assert.deepEqual(links(), [], 'none reached the page');
  // The urls themselves: only the exact form
  assert.deepEqual(MC.parseLinkUrl('wss://link.invalid/supabase/5432'), { runtime: 'supabase', port: 5432 });
  for (const u of ['wss://link.invalid/supabase/0', 'wss://link.invalid/supabase/65536', 'wss://link.invalid/supabase/05432', 'wss://link.invalid/supabase/5432/x',
    'wss://link.invalid/supabase/5432?x', 'ws://link.invalid/supabase/5432', 'wss://link.invalid.example/supabase/5432', 'wss://link.invalid//5432', null]) {
    assert.equal(MC.parseLinkUrl(u), null, String(u));
  }
  // A machine with no links gets armless's own WebSocket (none injected)
  const plain = new MC.Core({ config: { network: { tls: 't' }, filesystem: { json: 'f', baseurl: 'b' } }, Armless: LinkArmless, agent: null });
  await plain.boot('s');
  assert.equal(LinkArmless.last.options.network.WebSocket, undefined);
  const odd = new MC.Core({ config: { network: { tls: 't', tunnels: [{ port: 22, url: 'wss://tunnel.example/ssh' }] }, filesystem: { json: 'f', baseurl: 'b' } }, Armless: LinkArmless, agent: null });
  await odd.boot('s');
  assert.equal(LinkArmless.last.options.network.WebSocket, undefined, 'a tunnel of another kind is armless\'s own business');
});

test('links over TCP: a guest that half-closed and never closes is given up after the linger; the machine ending says each connection closed', async () => {
  // The linger, on a clock the test moves
  const c = clock();
  const events = [];
  const core = { emit: (e, p) => events.push(p), links: new Map(), _linkAdd(s) { this.links.set(1, s); return 1; }, _linkDelete(cid) { this.links.delete(cid); } };
  const WS = MC.linkSockets(core, new Map([[db, { runtime: 'supabase', port: 5432 }]]), class {}, c);
  const g = tunnel(WS, db);
  g.socket._hear('connect');
  g.end();
  await c.advance(MC.LINK_LINGER_MS - 1000);
  g.socket._hear('data', new TextEncoder().encode('more')); // the server still talking: the clock starts again
  await c.advance(MC.LINK_LINGER_MS - 1000);
  assert.equal(events.at(-1).kind, 'end');
  await c.advance(1000);
  assert.equal(events.at(-1).kind, 'close', 'given up after a quiet linger');
  assert.equal(c.pending.size, 0);

  const { core: k, WS: W, links } = await linkCore();
  const a = tunnel(W, db);
  tunnel(W, db);
  await k.linkIn(1, 'connect');
  k.destroy();
  assert.deepEqual(links().slice(-2), [{ cid: 1, kind: 'close' }, { cid: 2, kind: 'close' }]);
  await tick();
  assert.deepEqual(a.log, ['accept'], 'armless, going away with it, hears nothing more');
});

test('links over TCP: the host carries link events and linkIn, inline and over a worker\'s messages (bytes handed over), and says gone when the machine ends', async () => {
  globalThis.SnowglobeMachineCore = MC;
  const { createMachine } = require('./machine-host.js');
  const SC = MC;
  const Core = class extends SC.Core { constructor(o) { super({ ...o, Armless: LinkArmless, agent: null }); } };
  globalThis.SnowglobeMachineCore = { ...SC, Core, located: (b, x) => x };
  try {
    // Inline: the core in this thread
    const host = createMachine({ base: 'https://x.example/', config: { network: { tls: 't', tunnels: [{ host: 'db.internal', port: 5432, url: db }] }, filesystem: { json: 'f', baseurl: 'b' } }, transport: 'inline' });
    const heard = [];
    host.on('link', (e) => heard.push(e.bytes ? { ...e, bytes: new TextDecoder().decode(e.bytes) } : e));
    await host.boot('s');
    await host.run();
    const g = tunnel(LinkArmless.last.options.network.WebSocket, db);
    // Answered at once, inside the open (inline, the page can): armless has its handlers by then
    assert.deepEqual(heard, [{ cid: 1, kind: 'open', runtime: 'supabase', port: 5432 }]);
    await host.linkIn(1, 'connect');
    g.send(new TextEncoder().encode('q'));
    const view = new TextEncoder().encode('__answer__').subarray(2, 8);
    await host.linkIn(1, 'data', view);
    assert.deepEqual(g.log, ['accept', 'write answer']);
    assert.deepEqual(heard[1], { cid: 1, kind: 'data', bytes: 'q' });
    await host.destroy();
    assert.deepEqual(heard.slice(-2), [{ cid: 1, kind: 'close' }, { kind: 'gone' }]);
  } finally {
    globalThis.SnowglobeMachineCore = SC;
  }

  // Over a worker: what is posted, and what it hands over
  const posted = [];
  let w;
  class FakeWorker {
    constructor() { w = this; this.terminated = false; }
    postMessage(msg, transfer) {
      posted.push({ msg, transfer });
      if (msg.id !== undefined) setImmediate(() => this.onmessage({ data: { id: msg.id, result: true } }));
    }
    terminate() { this.terminated = true; }
  }
  const wh = createMachine({ base: 'https://x.example/', config: { name: 'web', filesystem: { json: 'f', baseurl: 'b' } }, transport: 'worker', Worker: FakeWorker, scripts: { worker: 'w.js', core: [] } });
  const said = [];
  wh.on('link', (e) => said.push(e));
  await wh.boot('s');
  w.onmessage({ data: { event: 'link', payload: { cid: 7, kind: 'open', runtime: 'supabase', port: 5432 } } });
  assert.deepEqual(said, [{ cid: 7, kind: 'open', runtime: 'supabase', port: 5432 }]);
  const own = new TextEncoder().encode('rows');
  await wh.linkIn(7, 'data', own);
  let p = posted.at(-1);
  assert.equal(p.msg.op, 'linkIn');
  assert.deepEqual(p.msg.args.slice(0, 2), [7, 'data']);
  assert.equal(p.transfer[0], own.buffer, 'a buffer of its own: handed over as it is');
  const view = new TextEncoder().encode('xxrowsxx').subarray(2, 6);
  await wh.linkIn(7, 'data', view);
  p = posted.at(-1);
  assert.notEqual(p.transfer[0], view.buffer, 'a view: a copy handed over, the rest of its buffer kept');
  assert.equal(new TextDecoder().decode(p.msg.args[2]), 'rows');
  await wh.linkIn(7, 'close');
  assert.deepEqual(posted.at(-1).msg.args, [7, 'close']);
  // The worker crashes: every link connection of its guest is said over
  w.onerror({ message: 'boom', preventDefault() {} });
  assert.deepEqual(said.at(-1), { kind: 'gone' });
  await assert.rejects(wh.linkIn(7, 'connect'), /not running/);
});

test('links over TCP: the worker hands a link event\'s bytes over and takes linkIn', () => {
  const src = require('node:fs').readFileSync(require.resolve('./machine-worker.js'), 'utf8');
  const posted = [];
  const self = { postMessage: (m, t) => posted.push([m, t]), location: { origin: 'https://x.example' } };
  const run = new Function('self', 'importScripts', `${src}; return { emit, OPS };`);
  const { emit, OPS } = run(self, () => {});
  assert.ok(OPS.has('linkIn'));
  const bytes = new Uint8Array([1, 2, 3]);
  emit('link', { cid: 1, kind: 'data', bytes });
  assert.equal(posted[0][1][0], bytes.buffer);
  emit('link', { cid: 1, kind: 'close' });
  assert.equal(posted[1][1], undefined);
});

// ------------------------------------------------------------------ a guest's WebSocket to a link's name

test('links: a guest\'s own WebSocket to a link\'s name (armless\'s event 10, ports 80 and 443) is spoken by the machine over the link\'s connection', async () => {
  const WsC = require('./ws-client.js');
  const { server } = require('./ws-test-server.cjs');
  const settle = async () => { for (let i = 0; i < 10; i++) await tick(); };
  const links = [];
  let sv = null;
  let core;
  // The page's side, as orchestrator.js's linkOpen: connect, then bytes both ways
  const page = (p) => {
    links.push(p.bytes ? { ...p, bytes: p.bytes.length } : p);
    if (p.kind === 'open') {
      if (!sv) return core.linkIn(p.cid, 'close'); // nothing listens
      sv.stream.ondata = (b) => core.linkIn(p.cid, 'data', b);
      sv.stream.onclose = () => core.linkIn(p.cid, 'close');
      sv.stream.onend = () => core.linkIn(p.cid, 'end');
      core.linkIn(p.cid, 'connect').then(() => sv.stream.onconnect?.());
      sv.stream.onconnect = null;
    } else if (p.kind === 'data') sv._in(Buffer.from(p.bytes));
    else if (p.kind === 'end') sv.clientEnded = true;
    else if (p.kind === 'close') sv.aborted = true;
  };
  const real = [];
  class RealWS { constructor(...a) { this.args = a; real.push(this); } }
  core = new MC.Core({ config: { network: { tls: 't', tunnels: [{ host: 'feed.internal', port: 9200, url: MC.linkUrl('python', 9200) }] },
    links: { 'feed.internal': { runtime: 'python', port: 9200 } }, link_base: 'https://x.example/fleet/', filesystem: { json: 'f', baseurl: 'b' } },
  Armless: LinkArmless, agent: null, emit: (e, p) => e === 'link' && page(p) });
  core.WebSocket = RealWS;
  await core.boot('s');
  core.run();
  const WS = LinkArmless.last.options.network.WebSocket;

  // As armless's _websocket opens one: the url the guest asked for, and its protocols
  sv = server({ protocol: (offered) => offered.includes('chat') ? 'chat' : undefined, echo: true });
  const ws = new WS('ws://feed.internal/socket?vsn=1', ['chat']);
  assert.ok(ws instanceof WsC.WebSocketClient, 'spoken here, not the real WebSocket');
  ws.binaryType = 'arraybuffer';
  const heard = [];
  ws.onopen = () => heard.push(['open', ws.protocol]);
  ws.onmessage = ({ data }) => heard.push(['message', typeof data === 'string' ? data : new Uint8Array(data).join()]);
  ws.onclose = ({ code, wasClean }) => heard.push(['close', code, wasClean]);
  await settle();
  assert.deepEqual(links[0], { cid: 1, kind: 'open', runtime: 'python', port: 9200 }, 'a link connection to the port the name links to');
  assert.equal(sv.head.line, 'GET /socket?vsn=1 HTTP/1.1');
  assert.equal(sv.head.headers.host, 'feed.internal', 'the name the guest asked for');
  assert.equal(sv.head.headers['sec-websocket-protocol'], 'chat');
  assert.deepEqual(heard, [['open', 'chat']]);
  ws.send('hello');
  ws.send(new Uint8Array([1, 2, 3]));
  await settle();
  assert.deepEqual(heard.slice(1), [['message', 'hello'], ['message', '1,2,3']], 'echoed by the server in the other machine');
  // The server closes: a clean close for the guest
  sv.close(1000, 'bye');
  await settle();
  assert.deepEqual(heard.at(-1), ['close', 1000, true]);
  assert.equal(core.links.size, 0, 'nothing kept');

  // On an https page armless asks for wss:, and a port may be named: the same link, the same server
  sv = server({ echo: true });
  const s2 = new WS('wss://feed.internal:443/x', []);
  await new Promise((r) => { s2.onopen = r; });
  assert.deepEqual(links.filter((l) => l.kind === 'open').at(-1), { cid: 2, kind: 'open', runtime: 'python', port: 9200 });
  assert.equal(sv.head.headers.host, 'feed.internal', 'a default port is left out, as a browser does');
  s2.close();
  await settle();
  assert.equal(s2.readyState, WS.CLOSED);

  // Nothing listens there: error and close 1006, as a refused WebSocket
  sv = null;
  const s3 = new WS('ws://feed.internal/', []);
  const said = [];
  s3.onerror = () => said.push('error');
  s3.onclose = ({ code }) => said.push(code);
  await settle();
  assert.deepEqual(said, ['error', 1006]);

  // Another name, and a link's tunnel url with protocols: the real WebSocket
  assert.ok(new WS('ws://example.com/', []) instanceof RealWS);
  assert.ok(new WS('ws://feed.internal.example.com/', []) instanceof RealWS);
  assert.ok(new WS(MC.linkUrl('python', 9200), []) instanceof RealWS);
  assert.equal(MC.wsLinked('http://feed.internal/', { 'feed.internal': { runtime: 'python', port: 9200 } }), null, 'only ws: and wss:');
  assert.equal(MC.wsLinked('ws://constructor/', Object.create(null)), null);

  // The machine going: the guest's WebSocket hears nothing more, the page lets go
  sv = server();
  const s4 = new WS('ws://feed.internal/', []);
  await new Promise((r) => { s4.onopen = r; });
  core.destroy();
  assert.equal(links.at(-1).kind, 'close');
});

test('links: a machine with names but no tunnels still speaks a guest\'s WebSocket to them', async () => {
  const core = new MC.Core({ config: { network: { tls: 't' }, links: { 'feed.internal': { runtime: 'python', port: 80 } }, filesystem: { json: 'f', baseurl: 'b' } }, Armless: LinkArmless, agent: null });
  await core.boot('s');
  assert.equal(typeof LinkArmless.last.options.network.WebSocket, 'function');
});

// ---------------------------------------------------------------- the warm pack and reading ahead

/** A warm pack of `files` ([[name, bytes]]): [u32 index size][index][bytes]. */
function warmPack(files) {
  const index = new TextEncoder().encode(JSON.stringify(files.map(([n, b]) => [n, b.length, b.length])));
  const out = new Uint8Array(4 + index.length + files.reduce((s, [, b]) => s + b.length, 0));
  new DataView(out.buffer).setUint32(0, index.length, true);
  out.set(index, 4);
  let at = 4 + index.length;
  for (const [, b] of files) { out.set(b, at); at += b.length; }
  return out;
}
const bytesOf = (s) => new TextEncoder().encode(s);
const textOf = (b) => new TextDecoder().decode(b);

/** A machine's file side as armless has it: has_blob, provide_blob. */
function fakeVm() {
  return { stopped: false, blobs: new Map(), provided: [], has_blob(n) { return this.blobs.has(n); },
    provide_blob(n, b) { this.blobs.set(n, Uint8Array.from(b)); this.provided.push(n); } };
}

/** A Core whose fetch is `routes` (url -> response), with a fake machine; `fetched` lists the urls asked for. */
function fileCore(routes, config = {}) {
  const fetched = [];
  const core = new MC.Core({ config: { filesystem: { json: 'https://b/fs.json', baseurl: 'https://b/' }, ...config }, Armless: class {}, agent: null });
  core.fetch = async (url) => {
    fetched.push(String(url));
    const r = routes(String(url));
    if (!r) return { ok: false, status: 404, statusText: 'Not Found' };
    return r;
  };
  core.vm = fakeVm();
  return { core, fetched, vm: core.vm };
}
const blobResponse = (b) => ({ ok: true, arrayBuffer: async () => b.slice().buffer });

/** A response whose body the test feeds: push(bytes), close(). */
function streamed() {
  let controller;
  const body = new ReadableStream({ start(c) { controller = c; } });
  return { response: { ok: true, body }, push: (b) => controller.enqueue(b), close: () => controller.close() };
}

test('the warm pack is read as it arrives: a file it holds comes from it, not a request of its own, and every file goes in', async () => {
  const files = [['a.bin.zst', bytesOf('alpha')], ['b.bin.zst', bytesOf('bravo')], ['c.bin.zst', bytesOf('charlie')]];
  const pack = warmPack(files);
  const s = streamed();
  const { core, fetched, vm } = fileCore((url) => (url === 'w' ? s.response : null), { warm: 'w' });
  const warming = core.warm();
  // The index and the first file, split across reads at odd places
  const split = pack.length - 'bravocharlie'.length;
  s.push(pack.subarray(0, 3));
  s.push(pack.subarray(3, split));
  await tick();
  // b is in the pack but not here yet: the read waits for it rather than fetching it
  const reading = core.fetchBlob('b.bin.zst');
  await tick();
  s.push(pack.subarray(split, split + 2));
  s.push(pack.subarray(split + 2));
  s.close();
  assert.equal(textOf(await reading), 'bravo');
  await warming;
  assert.deepEqual(fetched, ['w'], 'only the pack was fetched');
  assert.deepEqual([...vm.blobs.keys()].sort(), ['a.bin.zst', 'b.bin.zst', 'c.bin.zst']);
  assert.equal(textOf(vm.blobs.get('c.bin.zst')), 'charlie');
  assert.deepEqual(core.filesStatus().warm, { loaded: pack.length, total: pack.length, done: true });
  assert.equal(core.filesStatus().fromPack, 1);
});

test('the pack\'s first 12 MB go into the machine; the rest stay in the pack for reads, until the machine goes', async () => {
  // Files that decompress to 8 MB each (the index says so; their bytes here are short)
  const files = [['a.bin.zst', 'alpha'], ['b.bin.zst', 'bravo'], ['c.bin.zst', 'charlie']];
  const index = new TextEncoder().encode(JSON.stringify(files.map(([n, s]) => [n, 8 << 20, s.length])));
  const pack = new Uint8Array(4 + index.length + files.reduce((n, [, s]) => n + s.length, 0));
  new DataView(pack.buffer).setUint32(0, index.length, true);
  pack.set(index, 4);
  let at = 4 + index.length;
  for (const [, s] of files) { pack.set(bytesOf(s), at); at += s.length; }
  const s = streamed();
  const { core, fetched, vm } = fileCore((url) => (url === 'w' ? s.response : null), { warm: 'w' });
  const warming = core.warm();
  s.push(pack);
  s.close();
  await warming;
  assert.deepEqual(vm.provided, ['a.bin.zst', 'b.bin.zst'], 'up to 12 MB decompressed, then no more');
  // The rest comes from the pack when the guest reads it, and isn't fetched ahead either
  assert.equal(textOf(await core.fetchBlob('c.bin.zst')), 'charlie');
  core._prefetch('c.bin.zst');
  assert.deepEqual(fetched, ['w'], 'only the pack was fetched');
  // The pack goes with the machine
  core.destroy();
  assert.equal(core.pack, null);
});

test('a file the pack lacks, or a pack that fails, goes back to fetching the file', async () => {
  const s = streamed();
  const { core, fetched } = fileCore((url) => (url === 'w' ? s.response : url === 'https://b/z.bin.zst' ? blobResponse(bytesOf('zulu')) : null), { warm: 'w' });
  core.warm();
  s.push(warmPack([['a.bin.zst', bytesOf('alpha')]]));
  await tick();
  assert.equal(textOf(await core.fetchBlob('z.bin.zst')), 'zulu');
  assert.ok(fetched.includes('https://b/z.bin.zst'));

  // A pack whose download fails: a read waiting on its index fetches the file instead
  const t = streamed();
  const second = fileCore((url) => (url === 'w' ? t.response : url === 'https://b/a.bin.zst' ? blobResponse(bytesOf('alpha')) : null), { warm: 'w' });
  const warming = second.core.warm();
  await tick();
  const reading = second.core.fetchBlob('a.bin.zst');
  t.push(new Uint8Array([1])); // not even its index size
  t.close();
  await warming;
  assert.equal(textOf(await reading), 'alpha');
});

test('a read doesn\'t wait for a file far off in the pack: at the rate it comes, more than 2 s away', async () => {
  let clock = 0;
  const p = new MC.WarmPack({ now: () => clock });
  const big = new Uint8Array(10 << 20);
  const pack = warmPack([['near.bin.zst', bytesOf('n')], ['far.bin.zst', big]]);
  const head = pack.length - big.length; // the index and the near file
  p.push(pack.subarray(0, head));
  clock = 1000; // ~ the head in a second: 10 MB would take far longer
  assert.equal(await p.get('far.bin.zst'), null, 'fetched on its own');
  assert.equal(textOf(await p.get('near.bin.zst')), 'n');
  assert.equal(await p.get('other.bin.zst'), null, 'not in the pack');
  // Before any rate, only what is within the next 4 MB is waited for
  const q = new MC.WarmPack({ now: () => 0 });
  q.push(pack.subarray(0, head));
  assert.equal(await q.get('far.bin.zst'), null);
  // A waiting read is let go when the pack ends short
  const r = new MC.WarmPack({ now: () => 0 });
  const small = warmPack([['x.bin.zst', bytesOf('xray')]]);
  r.push(small.subarray(0, small.length - 2));
  const waiting = r.get('x.bin.zst');
  r.end(false);
  assert.equal(await waiting, null);
});

/** filesystem.json for `tree` ({ name: blob | [chunk blobs] | { ...dir } }). */
function fsJson(tree) {
  const nodes = (t) => Object.entries(t).map(([name, v]) => typeof v === 'string' ? [name, 100, 0, 0o100644, 0, 0, v]
    : Array.isArray(v) ? [name, 3 << 20, 0, 0o100755, 0, 0, v.map((b) => [b, 1 << 20])]
    : [name, 0, 0, 0o040755, 0, 0, nodes(v)]);
  return { fsroot: nodes(tree) };
}

test('reading ahead: the chunks after a large file\'s, fetched alongside and handed over; a whole file\'s read fetches nothing more', async () => {
  const tree = { usr: { bin: { big: ['c0.bin.zst', 'c1.bin.zst', 'c2.bin.zst', 'c3.bin.zst', 'c4.bin.zst', 'c5.bin.zst', 'c6.bin.zst'] } },
    ebin: { 'a.beam': 'm1.bin.zst', 'b.beam': 'm2.bin.zst', 'c.beam': 'm3.bin.zst' } };
  const { core, fetched, vm } = fileCore((url) => url === 'https://b/fs.json' ? { ok: true, json: async () => fsJson(tree) }
    : url.startsWith('https://b/') ? blobResponse(bytesOf(url.slice(10))) : null);
  const settle = async () => { for (let i = 0; i < 20; i++) await tick(); };
  await core.fetchBlob('c1.bin.zst');
  await settle();
  // The next four chunks, not the one before nor the one past them
  assert.deepEqual(['c2.bin.zst', 'c3.bin.zst', 'c4.bin.zst', 'c5.bin.zst'].filter((b) => vm.has_blob(b)).length, 4);
  assert.equal(vm.has_blob('c6.bin.zst'), false);
  assert.equal(vm.has_blob('c0.bin.zst'), false);
  // Whole files: only what is read
  await core.fetchBlob('m1.bin.zst');
  await core.fetchBlob('m2.bin.zst');
  await settle();
  assert.equal(vm.has_blob('m3.bin.zst'), false);
  // Each file fetched once, the guest's own reads not handed over twice (armless hands them over)
  const blobs = fetched.filter((u) => u.endsWith('.bin.zst'));
  assert.equal(new Set(blobs).size, blobs.length, 'no file fetched twice');
  assert.deepEqual(vm.provided.filter((n) => ['c1.bin.zst', 'm1.bin.zst', 'm2.bin.zst'].includes(n)), []);
  const st = core.filesStatus();
  assert.equal(st.fetched, 3);
  assert.equal(st.prefetched, 4);
});

test('a read of a file being fetched ahead shares its request', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { core, fetched } = fileCore((url) => url === 'https://b/fs.json' ? { ok: true, json: async () => fsJson({ big: ['c0.bin.zst', 'c1.bin.zst'] }) }
    : url === 'https://b/c1.bin.zst' ? { ok: true, arrayBuffer: async () => { await gate; return bytesOf('one').buffer; } }
    : url.startsWith('https://b/') ? blobResponse(bytesOf('zero')) : null);
  await core.fetchBlob('c0.bin.zst');
  for (let i = 0; i < 10; i++) await tick();
  const reading = core.fetchBlob('c1.bin.zst'); // already on its way, ahead
  release();
  assert.equal(textOf(await reading), 'one');
  assert.equal(fetched.filter((u) => u === 'https://b/c1.bin.zst').length, 1);
});

test('a pack slow to start doesn\'t hold the guest\'s reads: past a short wait for its index, a read fetches its file', async () => {
  const s = streamed(); // never sends a byte
  const { core, fetched } = fileCore((url) => (url === 'w' ? s.response : url === 'https://b/a.bin.zst' ? blobResponse(bytesOf('alpha')) : null), { warm: 'w' });
  core.packOptions = { indexWaitMs: 20 };
  core.warm();
  await tick();
  const started = Date.now();
  assert.equal(textOf(await core.fetchBlob('a.bin.zst')), 'alpha');
  assert.ok(Date.now() - started < 1000, 'not held until the pack comes');
  assert.ok(fetched.includes('https://b/a.bin.zst'));
  s.close();
});
