// The agent page's machines (orchestrator.js) over stand-in hosts, and its form (agent-panel.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./sessions.js');
globalThis.SnowglobeMachine = require('./machine.js');
const { createAgents } = require('./orchestrator.js');
const { Scheduler } = require('./scheduler.js');
const P = require('./agent-panel.js');

const manifest = {
  runtimes: ['python', 'duckdb', 'postgres'].map((name) => ({ name, title: `${name} in the browser`, purpose: `${name} things`, sample: `echo ${name}`,
    base: `../${name}/`, baseurl: 'https://blobs.example/', build_id: 'b-' + name, memory_mb: 512, network: 'none' })),
  armless: { js: '../python/armless/armless.js', wasm: '../python/armless/armless.wasm' }, xterm: '../python/xterm/', exposed_to: [],
};

// Hosts that pretend: each boot, capture and job is logged; a job ends when the test says so
function setup({ budget = 2, confirm = true } = {}) {
  const log = [];
  const activity = [];
  let asked = 0;
  const hosts = [];
  let n = 0;
  const createMachine = ({ base, config, transport, scripts }) => {
    const listeners = {};
    const jobs = {};
    const h = {
      base, config, transport, scripts,
      on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return () => {}; },
      emit: (ev, p) => (listeners[ev] ?? []).forEach((fn) => fn(p)),
      boot: async (state = config.initial_state) => { log.push(`boot ${config.name} from ${state instanceof Blob ? await state.text() : state}`); },
      run: async () => {},
      alive: true,
      capture: async () => {
        if (h.captureFails) throw h.captureFails;
        log.push(`capture ${config.name}`);
        return { encoding: 'raw', state: new Blob([`saved-${config.name}`]) };
      },
      destroy: async () => { if (h.alive) log.push(`end ${config.name}`); h.alive = false; },
      memory: async () => ({ wasmBytes: 600 << 20 }),
      runCommand: async ({ command }) => {
        const jobId = (++n).toString(16).padStart(16, '0');
        jobs[jobId] = { jobId, command, state: 'running', output: '', exitStatus: null };
        return { jobId };
      },
      readJob: async (id) => ({ ...jobs[id] }),
      cancelJob: async (id) => { jobs[id].state = 'cancelled'; h.emit('job', { jobId: id }); return { ...jobs[id] }; },
      finish: (id, output) => { Object.assign(jobs[id], { state: 'exited', exitStatus: 0, output }); h.emit('job', { jobId: id }); },
      readFile: async (path) => {
        if (h.readGate) await h.readGate;
        log.push(`read ${config.name}:${path}`);
        return { blob: new Blob(['abc']), size: 3, sha256: 'a'.repeat(64) };
      },
      writeFile: async (path, blob, o) => { log.push(`write ${config.name}:${path} ${await blob.text()}`); return { size: 3, sha256: o.sha256 }; },
    };
    hosts.push(h);
    return h;
  };
  const scheduler = new Scheduler({ budget });
  const api = createAgents(manifest, { pageUrl: 'https://x.example/snowglobe/agent/?runtime=duckdb', scheduler, Machine: globalThis.SnowglobeMachine.Machine,
    createMachine, ask: async () => { asked++; }, confirmFresh: async () => confirm, machineOptions: { idleMs: 0, hiddenMs: 0 }, onactivity: (e) => activity.push(e) });
  const host = (name) => hosts.filter((h) => h.config.name === name).at(-1);
  return { api, log, hosts, host, scheduler, activity, get asked() { return asked; } };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test('nothing boots until a command needs it; each machine is its site, in a worker, its files absolute', async () => {
  const { api, log, hosts, host } = setup();
  assert.deepEqual((await api.listRuntimes()).map((r) => [r.name, r.state, r.purpose, r.sample]),
    [['python', 'asleep', 'python things', 'echo python'], ['duckdb', 'asleep', 'duckdb things', 'echo duckdb'], ['postgres', 'asleep', 'postgres things', 'echo postgres']]);
  assert.equal(hosts.length, 0);
  const { jobId, runtime } = await api.runCommand({ runtime: 'duckdb', command: 'echo hi' });
  assert.equal(runtime, 'duckdb');
  assert.deepEqual(log, ['boot duckdb from system/state.bin.zst']);
  const h = host('duckdb');
  assert.equal(h.base, 'https://x.example/snowglobe/duckdb/');
  assert.equal(h.transport, 'worker');
  assert.equal(h.config.wasm, 'https://x.example/snowglobe/python/armless/armless.wasm', 'one armless for all of them');
  assert.equal(h.config.filesystem.baseurl, 'https://blobs.example/');
  assert.deepEqual(h.scripts.core, ['https://x.example/snowglobe/python/armless/armless.js', 'https://x.example/snowglobe/agent/sessions.js',
    'https://x.example/snowglobe/agent/agent.js', 'https://x.example/snowglobe/agent/transfer.js', 'https://x.example/snowglobe/agent/machine-core.js']);
  assert.equal(api._status('duckdb').state, 'busy');
  await assert.rejects(api.runCommand({ runtime: 'duckdb', command: 'x' }), /busy: job .* one job at a time in each machine/);
  await assert.rejects(api.runCommand({ runtime: 'nope', command: 'x' }), /no runtime "nope"; these are: python, duckdb, postgres/);
  h.finish(jobId, 'hi\n');
  await settle();
  assert.equal((await api.readJob(jobId)).output, 'hi\n');
  assert.equal(api._status('duckdb').state, 'ready');
});

test('job ids are unique across runtimes, and a finished job reads back after its machine is put away', async () => {
  const { api, host } = setup({ budget: 1 });
  const a = await api.runCommand({ runtime: 'python', command: 'echo a' });
  host('python').finish(a.jobId, 'a\n');
  await settle();
  const b = await api.runCommand({ runtime: 'duckdb', command: 'echo b' }); // python is suspended for it
  assert.notEqual(a.jobId, b.jobId);
  assert.equal((await api.listRuntimes())[0].state, 'asleep');
  const v = await api.readJob(a.jobId);
  assert.equal(v.runtime, 'python');
  assert.equal(v.output, 'a\n');
  host('duckdb').finish(b.jobId, 'b\n');
  await settle();
  // A repeated request id returns its job, without running it again
  const r1 = await api.runCommand({ runtime: 'python', command: 'echo r', requestId: 'req-1' });
  host('python').finish(r1.jobId, 'r\n');
  await settle();
  assert.deepEqual(await api.runCommand({ runtime: 'python', command: 'echo r', requestId: 'req-1' }), { jobId: r1.jobId, runtime: 'python', repeated: true });
  await assert.rejects(api.runCommand({ runtime: 'python', command: 'echo other', requestId: 'req-1' }), /different command/);
});

test('a suspended machine wakes from its save (kept in the tab when there is no storage)', async () => {
  const { api, log, host } = setup();
  const j = await api.runCommand({ runtime: 'postgres', command: 'true' });
  host('postgres').finish(j.jobId, '');
  await settle();
  assert.equal(await api.suspend('postgres'), true);
  assert.equal((await api.listRuntimes())[2].saved, true);
  await api.wake('postgres');
  assert.deepEqual(log, ['boot postgres from system/state.bin.zst', 'capture postgres', 'end postgres', 'boot postgres from saved-postgres']);
});

test('a copy reads from one machine and writes to the other, each busy only for its half', async () => {
  const { api, log, scheduler } = setup({ budget: 1 });
  const seen = [];
  const busyDuring = [];
  const orig = scheduler.ensureAwake.bind(scheduler);
  scheduler.ensureAwake = (m, o) => { busyDuring.push(`${m.name}:${m.busy()}`); return orig(m, o); };
  const r = await api.copyFile({ fromRuntime: 'python', fromPath: '/root/a', toRuntime: 'postgres', toPath: '/root/b' }, { onProgress: (p) => seen.push(p) });
  assert.equal(r.bytes, 3);
  assert.equal(r.sha256, 'a'.repeat(64));
  assert.ok(r.readSeconds >= 0 && r.writeSeconds >= 0);
  assert.deepEqual(log, ['boot python from system/state.bin.zst', 'read python:/root/a', 'capture python', 'end python', 'boot postgres from system/state.bin.zst', 'write postgres:/root/b abc']);
  assert.deepEqual(busyDuring, ['python:true', 'postgres:true'], 'busy while it waits to wake: never chosen to make room');
  assert.ok((await api.listRuntimes()).every((x) => x.state !== 'busy'));
  await assert.rejects(api.copyFile({ fromRuntime: 'python', fromPath: '', toRuntime: 'duckdb', toPath: 'x' }), /fromPath/);
});

test('start fresh asks first, then drops the save and the running machine without saving it', async () => {
  const { api, log, host } = setup();
  const j = await api.runCommand({ runtime: 'python', command: 'true' });
  host('python').finish(j.jobId, '');
  await settle();
  assert.equal(await api.startFresh('python'), true);
  assert.deepEqual(log, ['boot python from system/state.bin.zst', 'end python'], 'no capture');
  assert.equal((await api.listRuntimes())[0].saved, false);
  await api.wake('python');
  assert.equal(log.at(-1), 'boot python from system/state.bin.zst');

  const no = setup({ confirm: false });
  assert.equal(await no.api.startFresh('python'), false);
});

test('capabilities and the budget', async () => {
  const { api } = setup();
  const c = await api.capabilities();
  assert.deepEqual(c.runtimes, ['python', 'duckdb', 'postgres']);
  assert.equal(c.budget, 2);
  assert.equal(c.maxCopyBytes, 8 << 20);
  assert.ok(c.features.includes('copyFile'));
  assert.equal(await api.setBudget(1), 1);
  await assert.rejects(api.setTransport('carrier pigeon'), /transport/);
});

// The form's elements, as plain objects
function els() {
  const el = (o = {}) => {
    const handlers = {};
    return { value: '', disabled: false, textContent: '', ...o, addEventListener: (n, fn) => { (handlers[n] ??= []).push(fn); },
      fire: (n, e = {}) => handlers[n]?.forEach((fn) => fn({ preventDefault() {}, ...e })), focus() {} };
  };
  return { form: el(), command: el(), run: el(), cancel: el(), status: el(), result: el(), output: el() };
}
const timers = { setInterval: () => 0, clearInterval() {}, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout: (t) => clearTimeout(t) };

test('panel: each run is tagged with the runtime it ran in; a copy is a run too, updated as it goes', async () => {
  const { api, host } = setup();
  let selected = 'duckdb';
  const e = els();
  const drawn = [];
  const agent = { status: async (rt) => api._status(rt ?? selected), runCommand: (i) => api.runCommand(i), readJob: (id) => api.readJob(id),
    cancelJob: (id) => api.cancelJob(id), wake: (rt) => api.wake(rt) };
  let held = null;
  const panel = new P.Panel(agent, e, { ask: async () => {}, jobText: require('./agent.js').jobText, timers, label: () => selected,
    hold: () => held, render: (runs) => drawn.push(runs.map((r) => `${r.runtime}:${r.state}`)) });
  e.command.value = 'echo hi';
  const running = panel.run();
  await settle();
  selected = 'python'; // changed while it runs: the run stays duckdb's
  host('duckdb').finish(api._machines[1].job, 'hi\n');
  await running;
  await new Promise((r) => setTimeout(r, 20)); // its next poll
  assert.equal(panel.runs[0].runtime, 'duckdb');
  assert.equal(e.result.textContent, 'Exit status: 0');

  const copy = { command: 'copy python:/a → duckdb:/a', runtime: 'python → duckdb', state: 'running' };
  panel.record(copy);
  held = 'Copying: writing 128 KiB of 1.0 MiB…';
  await panel.refresh();
  assert.equal(e.status.textContent, held, 'what holds the status line is said instead of the state');
  panel.update(copy, { state: 'copied', output: 'Copied 3 bytes.' });
  assert.equal(e.result.textContent, 'Copied');
  assert.equal(e.output.textContent, 'Copied 3 bytes.');
  assert.deepEqual(drawn.at(-1), ['python → duckdb:copied', 'duckdb:exited']);
  assert.equal(P.idleText({ state: 'suspended', fresh: true }), 'Asleep, with nothing saved. Run starts it from the machine as built (a few seconds).');
});

// ------------------------------------------------------------------ failures, consent, the limit

const alive = (hosts, name) => hosts.filter((h) => h.config.name === name && h.alive).length;

test('a machine that powers off fails: its host ended, its job failed; Retry leaves exactly one host', async () => {
  const { api, hosts, host, log } = setup();
  const j = await api.runCommand({ runtime: 'python', command: 'sleep 100' });
  host('python').emit('stop', { reason: 'poweroff' });
  await settle();
  assert.equal(api._describe(api._get('python')).state, 'failed');
  assert.equal(alive(hosts, 'python'), 0, 'its worker ended at once');
  const v = await api.readJob(j.jobId);
  assert.equal(v.state, 'failed');
  assert.match(v.error, /the machine failed: the machine stopped \(poweroff\)/);
  assert.equal(api._get('python').busy(), false);
  await api.retry('python');
  assert.equal(alive(hosts, 'python'), 1, 'one host after Retry');
  assert.equal(api._describe(api._get('python')).state, 'awake');
  assert.deepEqual(log.filter((l) => l.startsWith('end')), ['end python']);
  // Start fresh on a failed machine leaves nothing behind either
  host('python').emit('stop', { reason: 'poweroff' });
  await settle();
  assert.equal(await api.startFresh('python'), true);
  assert.equal(alive(hosts, 'python'), 0);
  assert.equal(api._describe(api._get('python')).state, 'asleep');
});

test('a worker that crashes fails its machine: not running, not busy, its job failed, and the others go on', async () => {
  const { api, hosts, host } = setup({ budget: 1 });
  const j = await api.runCommand({ runtime: 'duckdb', command: 'x' });
  host('duckdb').emit('error', { name: 'Error', message: "the machine's worker stopped: boom", fatal: true });
  await settle();
  const m = api._get('duckdb');
  assert.equal(m.lifecycle.state, 'failed');
  assert.equal(m.busy(), false);
  assert.equal(m.host, null);
  assert.equal((await api.readJob(j.jobId)).state, 'failed');
  assert.equal(alive(hosts, 'duckdb'), 0);
  // The budget is free again: another machine wakes without waiting for it
  await api.runCommand({ runtime: 'python', command: 'true' });
  assert.equal(alive(hosts, 'python'), 1);
});

test('a capture that times out fails that machine instead of stalling every other suspend and wake', async () => {
  const { api, hosts, host } = setup({ budget: 1 });
  const a = await api.runCommand({ runtime: 'python', command: 'true' });
  host('python').finish(a.jobId, '');
  await settle();
  host('python').captureFails = Object.assign(new Error('the machine did not answer a capture within 15 s'), { name: 'TimeoutError', fatal: true });
  // duckdb needs python's place: python's capture hangs and is given up on
  await api.runCommand({ runtime: 'duckdb', command: 'true' });
  assert.equal(api._get('python').lifecycle.state, 'failed');
  assert.match(api._describe(api._get('python')).error, /did not answer a capture/);
  assert.equal(alive(hosts, 'python'), 0);
  assert.equal(api._get('duckdb').lifecycle.state, 'running');
});

test('a copy and a run in the same machine take turns: the run waits for the copy\'s half', async () => {
  const { api, host, log } = setup();
  await api.wake('python');
  let open;
  host('python').readGate = new Promise((r) => { open = r; });
  const copy = api.copyFile({ fromRuntime: 'python', fromPath: '/root/a', toRuntime: 'duckdb', toPath: '/root/a' });
  await settle();
  let ran = false;
  const run = api.runCommand({ runtime: 'python', command: 'rm /root/a' }).then((r) => { ran = true; return r; });
  await settle();
  assert.equal(ran, false, 'the run waits its turn');
  open();
  await run;
  assert.ok(log.indexOf('read python:/root/a') >= 0);
  assert.equal(ran, true);
  await copy;
  // Beside a job, a run is refused (one job at a time) rather than queued behind it
  await assert.rejects(api.runCommand({ runtime: 'python', command: 'x' }), /busy: job/);
});

test('window.snowglobeAgent asks the person before any run or copy, and start fresh always confirms', async () => {
  const s = setup();
  const j = await s.api.runCommand({ runtime: 'python', command: 'true' });
  s.host('python').finish(j.jobId, '');
  await settle();
  await s.api.copyFile({ fromRuntime: 'python', fromPath: '/a', toRuntime: 'duckdb', toPath: '/b' });
  assert.equal(s.asked, 2, 'every run and copy goes through the consent (which asks once per page load)');

  // No consent given to it at all: nothing runs
  const { Scheduler: Sch } = require('./scheduler.js');
  const bare = createAgents(manifest, { pageUrl: 'https://x.example/agent/', scheduler: new Sch(), Machine: globalThis.SnowglobeMachine.Machine,
    createMachine: () => assert.fail('nothing boots'), confirmFresh: async () => false });
  await assert.rejects(bare.runCommand({ runtime: 'python', command: 'true' }), /did not allow/);
  await assert.rejects(bare.copyFile({ fromRuntime: 'python', fromPath: '/a', toRuntime: 'duckdb', toPath: '/b' }), /did not allow/);
  // The public API has no way around the confirmation
  let confirmed = 0;
  const t = createAgents(manifest, { pageUrl: 'https://x.example/agent/', scheduler: new Sch(), Machine: globalThis.SnowglobeMachine.Machine,
    createMachine: () => assert.fail('nothing boots'), confirmFresh: async () => { confirmed++; return false; } });
  assert.equal(await t.startFresh('python', { confirmed: true }), false);
  assert.equal(confirmed, 1);
});

test('every run and copy is heard, with who asked, for the page\'s history', async () => {
  const { api, host, activity } = setup();
  const j = await api.runCommand({ runtime: 'python', command: 'echo hi' }, { source: 'webmcp' });
  host('python').finish(j.jobId, 'hi\n');
  await settle();
  await api.copyFile({ fromRuntime: 'python', fromPath: '/a', toRuntime: 'duckdb', toPath: '/b' }, { source: 'webmcp' });
  await assert.rejects(api.copyFile({ fromRuntime: 'python', fromPath: '/a', toRuntime: 'duckdb', toPath: '/b' }, { signal: AbortSignal.abort() }));
  assert.deepEqual(activity.map((e) => [e.kind, e.source ?? '', e.state ?? '']), [
    ['run', 'webmcp', ''], ['job', '', ''], ['copy', 'webmcp', 'running'], ['copy', 'webmcp', 'copied']]);
  assert.equal(activity[0].command, 'echo hi');
  assert.equal(activity[3].result.bytes, 3);
});

test('a reload would lose what an awake machine did since its last save: unsaved() says which', async () => {
  const { api, host } = setup();
  assert.deepEqual(api.unsaved(), []);
  const j = await api.runCommand({ runtime: 'postgres', command: 'touch x' });
  assert.deepEqual(api.unsaved(), ['postgres']);
  assert.equal(api._describe(api._get('postgres')).unsaved, true);
  host('postgres').finish(j.jobId, '');
  await settle();
  // No storage in this test: the suspend keeps it in the tab only, which a reload loses too
  await api.suspend('postgres');
  assert.deepEqual(api.unsaved(), [], 'asleep: nothing more to lose by reloading than it already has');
});

test('the awake limit: lowered, idle machines are suspended least recently used first, never a busy one', async () => {
  const { api, scheduler, host } = setup({ budget: 3 });
  const done = async (rt) => { const j = await api.runCommand({ runtime: rt, command: 'true' }); host(rt).finish(j.jobId, ''); await settle(); };
  await done('python');
  await done('duckdb');
  const busy = await api.runCommand({ runtime: 'postgres', command: 'sleep 9' }); // busy
  assert.equal(scheduler.awake().length, 3);
  const r = await api.setAwakeLimit(1);
  assert.equal(r.awakeLimit, 1);
  assert.deepEqual(api._machines.map((m) => m.lifecycle.state), ['suspended', 'suspended', 'running'], 'both idle ones, the older first');
  assert.equal(r.awake, 1);
  assert.equal(r.overLimit, null);

  // Raised to 3: three can be awake
  await api.setAwakeLimit(3);
  await done('python');
  await done('duckdb');
  assert.equal(scheduler.awake().length, 3);
  assert.equal((await api.capabilities()).awakeLimit, 3);

  // Lowered to 1 with two busy: the idle one goes, and the page says why two are still awake
  const b2 = await api.runCommand({ runtime: 'duckdb', command: 'sleep 9' });
  const low = await api.setAwakeLimit(1);
  assert.equal(api._get('python').lifecycle.state, 'suspended');
  assert.match(low.overLimit, /^2 machines are awake, over the limit of 1: duckdb, postgres are busy, and will be suspended when they finish$/);
  // As they finish, it catches up
  host('postgres').finish(busy.jobId, '');
  await settle();
  assert.equal(api._get('postgres').lifecycle.state, 'suspended');
  assert.equal(scheduler.over, null);
  host('duckdb').finish(b2.jobId, '');
  await settle();
  assert.equal(scheduler.awake().length, 1);
  await assert.rejects(api.setAwakeLimit(0), /1 to 8/);
  await assert.rejects(api.setAwakeLimit(9), /1 to 8/);
});

test('a save slot that could not open (another tab held it) is tried again at the next suspend', async () => {
  const S = globalThis.SnowglobeSessions;
  const orig = { acquireLock: S.acquireLock, open: S.BrowserStore.open };
  let tries = 0;
  const saved = new Map();
  S.acquireLock = async () => { if (++tries === 1) throw new Error('Another tab owns these sessions.'); return () => {}; };
  S.BrowserStore.open = async () => ({ list: async () => [...saved.values()], get: async (id) => saved.get(id), put: async (c) => saved.set(c.id, c), remove: async (id) => saved.delete(id) });
  try {
    const { SaveSlot } = require('./orchestrator.js');
    const slot = new SaveSlot('/agent/python', { build: 'b' }, 'Python');
    await slot.open();
    assert.match(slot.error, /Another tab/);
    await slot.save({ encoding: 'raw', state: new Blob(['x']) });
    assert.equal(slot.error, null);
    assert.equal(tries, 2);
    assert.ok(saved.has('machine'));
  } finally {
    S.acquireLock = orig.acquireLock;
    S.BrowserStore.open = orig.open;
  }
});

test('a blob store that can\'t be reached is said, and cleared once it answers', async () => {
  const { api, host } = setup();
  await api.wake('python');
  host('python').emit('blobs', { ok: false, url: 'https://blobs.example/', message: 'Failed to fetch' });
  assert.equal(api._describe(api._get('python')).filesUnreachable, "can't reach the machine's files (https://blobs.example/)");
  host('python').emit('blobs', { ok: true });
  assert.equal(api._describe(api._get('python')).filesUnreachable, null);

  // The machine's own side: a failed fetch is said once, then cleared by the next one that works
  const { Core } = require('./machine-core.js');
  const events = [];
  const core = new Core({ config: { filesystem: { baseurl: 'https://blobs.example/' } }, Armless: class {}, agent: null, emit: (e, p) => events.push([e, p]) });
  let up = false;
  core.fetch = async () => { if (!up) throw new TypeError('Failed to fetch'); return { ok: true, arrayBuffer: async () => new ArrayBuffer(2) }; };
  await assert.rejects(core.fetchBlob('ab.bin.zst'), /Failed to fetch/);
  await assert.rejects(core.fetchBlob('cd.bin.zst'));
  up = true;
  assert.equal((await core.fetchBlob('ab.bin.zst')).length, 2);
  assert.deepEqual(events, [['blobs', { ok: false, url: 'https://blobs.example/', message: 'Failed to fetch' }], ['blobs', { ok: true }]]);
});

test('a worker that doesn\'t answer: its end is forced after 2 s, a capture fails after its bound, the worker terminated', async () => {
  const { createMachine, TIMEOUTS } = require('./machine-host.js');
  assert.deepEqual(TIMEOUTS, { destroy: 2000, capture: 15000 });
  const workers = [];
  class FakeWorker {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(msg) {
      // init and boot answer; capture and destroy never do
      if (msg.op === 'init' || msg.op === 'boot') setImmediate(() => this.onmessage({ data: { id: msg.id, result: true } }));
    }
    terminate() { this.terminated = true; }
  }
  const make = () => createMachine({ base: 'https://x.example/py/', config: { name: 'py' }, transport: 'worker', Worker: FakeWorker,
    scripts: { worker: 'w.js', core: [] }, timeouts: { destroy: 20, capture: 30 } });
  const a = make();
  await a.boot();
  const t0 = Date.now();
  await a.destroy();
  assert.ok(Date.now() - t0 >= 15, 'waited for the answer a while');
  assert.equal(workers[0].terminated, true, 'then ended it anyway');

  const b = make();
  await b.boot();
  await assert.rejects(b.capture(), (e) => e.name === 'TimeoutError' && e.fatal === true);
  assert.equal(workers[1].terminated, true);

  // A worker that throws is ended, and says so as a fatal error
  const c = make();
  const errors = [];
  c.on('error', (e) => errors.push(e));
  await c.boot();
  workers[2].onerror({ message: 'boom', preventDefault() {} });
  assert.equal(workers[2].terminated, true);
  assert.equal(errors[0].fatal, true);
  await assert.rejects(c.run(), /not running/);
});
