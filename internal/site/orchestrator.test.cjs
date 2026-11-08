// The agent page's machines (orchestrator.js) over stand-in hosts, and its form (agent-panel.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
require('./sessions.js');
globalThis.SnowglobeMachine = require('./machine.js');
globalThis.SnowglobePreview = require('./preview.js');
globalThis.SnowglobeBuilder = require('./builder.js');
const { createAgents } = require('./orchestrator.js');
const { Scheduler } = require('./scheduler.js');
const P = require('./agent-panel.js');

const manifest = {
  runtimes: ['python', 'duckdb', 'postgres'].map((name) => ({ name, title: `${name} in the browser`, purpose: `${name} things`, sample: `echo ${name}`,
    base: `../${name}/`, baseurl: 'https://blobs.example/', build_id: 'b-' + name, memory_mb: 512, network: 'none' })),
  armless: { js: '../python/armless/armless.js', wasm: '../python/armless/armless.wasm' }, xterm: '../python/xterm/', exposed_to: [],
};

// Hosts that pretend: each boot, capture and job is logged; a job ends when the test says so
function setup({ budget = 2, confirm = true, man = manifest, options = {}, tcp = null } = {}) {
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
      // As machine-host.js's: its guest's link connections are said over when it ends
      destroy: async () => { if (h.alive) log.push(`end ${config.name}`); h.alive = false; h.emit('link', { kind: 'gone' }); },
      // What the page said to its guest's link connections: [cid, kind, text?]
      linked: [],
      linkIn: async (cid, kind, bytes) => {
        h.linked.push(bytes ? [cid, kind, new TextDecoder().decode(bytes)] : [cid, kind]);
        if (!h.alive) throw new Error('the machine is not running');
        return true;
      },
      memory: async () => ({ wasmBytes: 600 << 20 }),
      jobs,
      runCommand: async ({ command, files }) => {
        const jobId = (++n).toString(16).padStart(16, '0');
        jobs[jobId] = { jobId, command, files, state: 'running', output: '', exitStatus: null };
        if (h.onRun) h.onRun(jobId, jobs[jobId]);
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
      // A server on port 4173 (and 54321) answers; nothing else listens
      tcpOpen: (port) => {
        log.push(`connect ${config.name}:${port}`);
        if (tcp) return tcp(port, h);
        const c = { write: (b) => {
          if (!new TextDecoder().decode(b).endsWith('\r\n\r\n')) return;
          setImmediate(() => { c.ondata(new TextEncoder().encode(`HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok`)); c.onclose(); });
        }, end() {}, abort() {} };
        setImmediate(() => ([4173, 54321].includes(port) ? c.onconnect() : c.onclose()));
        return c;
      },
    };
    hosts.push(h);
    return h;
  };
  const scheduler = new Scheduler({ budget });
  const api = createAgents(man, { pageUrl: 'https://x.example/snowglobe/agent/?runtime=duckdb', scheduler, Machine: globalThis.SnowglobeMachine.Machine,
    createMachine, ask: async () => { asked++; }, confirmFresh: async () => confirm, machineOptions: { idleMs: 0, hiddenMs: 0 }, onactivity: (e) => activity.push(e),
    granted: () => asked > 0, ...options });
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
    'https://x.example/snowglobe/agent/agent.js', 'https://x.example/snowglobe/agent/transfer.js', 'https://x.example/snowglobe/agent/ws-client.js', 'https://x.example/snowglobe/agent/machine-core.js']);
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
  assert.equal(P.idleText({ state: 'suspended', fresh: true }), 'Asleep. Run starts it.');
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

// The agent page with supabase (2 CPUs) and web: the machines a web app is built with
const appManifest = {
  ...manifest,
  runtimes: [
    { name: 'supabase', title: 'Supabase in the browser', purpose: 'Supabase', sample: 'psql', base: '../supabase/', baseurl: 'https://blobs.example/', build_id: 'b-s', memory_mb: 640, cpus: 2, network: 'fetch' },
    { name: 'web', title: 'Node + Vite in the browser', purpose: 'web', sample: 'npm run build', base: '../web/', baseurl: 'https://blobs.example/', build_id: 'b-w', memory_mb: 640, cpus: 1, network: 'fetch' },
    ...manifest.runtimes,
  ],
  armless: { ...manifest.armless, wasm_smp: '../supabase/armless/armless-smp.wasm' },
};

test('a machine on several CPUs: its several-CPU armless where the page is isolated, refused with the reason where it is not', async () => {
  const { api, host, hosts } = setup({ man: appManifest, options: { isolated: true } });
  await api.runCommand({ runtime: 'supabase', command: 'nproc' });
  const h = host('supabase');
  assert.equal(h.config.cpus, 2);
  assert.equal(h.config.wasm_smp, 'https://x.example/snowglobe/supabase/armless/armless-smp.wasm');
  assert.equal(api._describe(api._get('supabase')).cpus, 2);
  assert.equal(api._describe(api._get('supabase')).unavailable, null);

  const off = setup({ man: appManifest, options: { isolated: false } });
  await assert.rejects(off.api.runCommand({ runtime: 'supabase', command: 'nproc' }), /2 CPUs, which needs this page cross-origin isolated/);
  assert.equal(off.hosts.length, 0, 'nothing started for it');
  assert.match(off.api._describe(off.api._get('supabase')).unavailable, /cross-origin isolated/);
  await off.api.runCommand({ runtime: 'web', command: 'echo' });
  assert.equal(off.hosts.length, 1, 'the one-CPU machines run as ever');
  assert.equal((await off.api.capabilities()).crossOriginIsolated, false);
  assert.ok(hosts.length >= 1);
});

test('an open preview keeps its machine busy: never suspended, and a wake beyond the limit waits; closing it lets go', async () => {
  const { api, activity, scheduler, log } = setup({ man: appManifest, options: { isolated: true } });
  const r = await api.openPreview({ runtime: 'web', port: 4173 }, { source: 'webmcp' });
  assert.equal(r.url, 'https://x.example/snowglobe/agent/preview/web/4173/');
  assert.equal(r.status, 200, 'its first request answered');
  assert.equal(activity.at(-1).kind, 'preview');
  assert.equal(activity.at(-1).source, 'webmcp');
  const web = api._get('web');
  assert.equal(web.busy(), true);
  assert.equal(api._describe(web).state, 'busy');
  assert.match(api._describe(web).doing, /preview \(port 4173\)/);
  assert.equal(await api.suspend('web'), false, 'a busy machine is not suspended');

  // The page in the preview reaches supabase through it: held awake too
  const sent = [];
  await api.previewRequest({ runtime: 'supabase', port: 54321, method: 'GET', path: '/auth/v1/health', headers: [], prefix: '/snowglobe/agent/preview/supabase/54321', origin: 'https://x.example' },
    (m) => sent.push(m));
  assert.deepEqual(sent.map((m) => m.type), ['head', 'data', 'end']);
  assert.deepEqual(api._describe(api._get('supabase')).previewPorts, [54321]);
  assert.equal(api._get('supabase').busy(), true);

  // Both awake and busy, at a limit of 2: python waits, and is said to
  let woke = false;
  const py = api.runCommand({ runtime: 'python', command: 'echo' }).then(() => { woke = true; });
  await settle();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(woke, false);
  assert.match(scheduler.waiting, /python waits to wake: every awake machine is busy \(supabase, web\)/);
  assert.ok(!log.some((l) => /capture (web|supabase)/.test(l)), 'neither was captured');

  await api.closePreview();
  assert.equal(activity.at(-1).preview, null);
  await py;
  assert.equal(woke, true);
  assert.ok(log.some((l) => /capture (web|supabase)/.test(l)), 'once let go, one of them made room');
});

test('preview requests: answered only with a preview open and the page allowed; a port that never answers is not held', async () => {
  const { api, log } = setup({ man: appManifest, options: { isolated: true } });
  const ask = async (req) => { const sent = []; await api.previewRequest({ method: 'GET', path: '/', headers: [], prefix: '/p', origin: 'https://x.example', ...req }, (m) => sent.push(m)); return sent; };
  let sent = await ask({ runtime: 'web', port: 4173 });
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].status, 403);
  assert.match(sent[0].body, /No preview is open/);
  assert.ok(!log.some((l) => l.startsWith('boot')), 'nothing woke for it');

  await api.openPreview({ runtime: 'web', port: 4173 });
  sent = await ask({ runtime: 'web', port: 9999 });
  assert.equal(sent[0].status, 502);
  assert.match(sent[0].body, /Nothing is listening/);
  assert.deepEqual(api._describe(api._get('web')).previewPorts, [4173], '9999 is not held');
  sent = await ask({ runtime: 'python', port: 80 });
  assert.equal(sent[0].status, 502);
  assert.match(sent[0].body, /no network device/);
  await assert.rejects(api.openPreview({ runtime: 'python', port: 80 }), /no network device/);
  await assert.rejects(api.openPreview({ runtime: 'web', port: 0 }), /port/);
  await assert.rejects(api.openPreview({ runtime: 'web', port: 4173, path: 'x' }), /path/);
});

test('a preview is asked for like a run: the person allows it first', async () => {
  const s = setup({ man: appManifest, options: { isolated: true } });
  assert.equal(s.asked, 0);
  await s.api.openPreview({ runtime: 'web', port: 4173 }, { check: false });
  assert.equal(s.asked, 1);
});

test('a connection into the machine: the core over armless\'s connect(), the host as a stream, inline and over a worker\'s messages alike', async () => {
  globalThis.SnowglobeMachineCore = require('./machine-core.js');
  const { createMachine } = require('./machine-host.js');
  const conns = [];
  // armless's side: connect(port) gives a connection that says connect, data and close
  class FakeArmless {
    constructor() { this.ready = Promise.resolve(); }
    on() {}
    run() {}
    destroy() {}
    connect(port) {
      const listeners = {};
      const c = { port, written: [], on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return c; }, emit: (ev, ...a) => (listeners[ev] ?? []).forEach((fn) => fn(...a)),
        write: (b) => c.written.push(new TextDecoder().decode(b)), close() {}, abort() { c.aborted = true; } };
      conns.push(c);
      setImmediate(() => (port === 80 ? c.emit('connect') : c.emit('close')));
      return c;
    }
  }
  const SC = globalThis.SnowglobeMachineCore;
  const Core = class extends SC.Core { constructor(o) { super({ ...o, Armless: FakeArmless, agent: null }); } };
  globalThis.SnowglobeMachineCore = { ...SC, Core, located: (b, c) => c };
  try {
    const host = createMachine({ base: 'https://x.example/', config: { network: { tls: 't' }, filesystem: { json: 'f', baseurl: 'b' } }, transport: 'inline' });
    await host.boot('s');
    await host.run();
    const heard = [];
    const s = host.tcpOpen(80);
    s.onconnect = () => heard.push('connect');
    s.ondata = (b) => heard.push(`data ${new TextDecoder().decode(b)}`);
    s.onclose = () => heard.push('close');
    await new Promise((r) => setImmediate(r));
    s.write(new TextEncoder().encode('GET / HTTP/1.1\r\n\r\n'));
    await new Promise((r) => setTimeout(r, 5));
    conns[0].emit('data', new TextEncoder().encode('HTTP/1.1 200 OK'));
    conns[0].emit('close');
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(heard, ['connect', 'data HTTP/1.1 200 OK', 'close']);
    assert.deepEqual(conns[0].written, ['GET / HTTP/1.1\r\n\r\n']);
    // Nothing listening: a close with no connect before it
    const refused = [];
    const r = host.tcpOpen(81);
    r.onconnect = () => refused.push('connect');
    r.onclose = () => refused.push('close');
    await new Promise((res) => setTimeout(res, 5));
    assert.deepEqual(refused, ['close']);
    // A machine with no network device can't be connected to: said, not thrown at the caller
    const off = createMachine({ base: 'https://x.example/', config: { filesystem: { json: 'f', baseurl: 'b' } }, transport: 'inline' });
    await off.boot('s');
    await off.run();
    const err = await new Promise((res) => { off.tcpOpen(80).onerror = res; });
    assert.match(err.message, /no network device/);
  } finally {
    globalThis.SnowglobeMachineCore = SC;
  }
});

const sbReq = { runtime: 'supabase', port: 54321, method: 'GET', path: '/auth/v1/health', headers: [], prefix: '/snowglobe/agent/preview/supabase/54321', origin: 'https://x.example' };

test('at an awake limit of 1, web\'s preview reaches supabase (the preview\'s machines count as one); anything else waits, and a preview bounded wait is a clear 503', async () => {
  const { api, scheduler } = setup({ budget: 1, man: appManifest, options: { isolated: true } });
  await api.openPreview({ runtime: 'web', port: 4173 });
  const sent = [];
  await api.previewRequest(sbReq, (m) => sent.push(m));
  assert.deepEqual(sent.map((m) => m.type), ['head', 'data', 'end'], 'supabase woken beside web, beyond the limit');
  assert.equal(scheduler.awake().length, 2);
  assert.match(scheduler.over, /woken for the preview/);

  // A run in a third machine waits (the preview's machines are busy), without holding the queue
  let woke = false;
  const py = api.runCommand({ runtime: 'python', command: 'echo' }).then(() => { woke = true; });
  await settle();
  assert.equal(woke, false);
  assert.match(scheduler.waiting, /python waits to wake/);
  await api.closePreview();
  await py;
  assert.equal(woke, true);

  // A preview whose machine finds every slot busy with a job: a bounded wait, then 503
  const s = setup({ budget: 1, man: appManifest, options: { isolated: true } });
  const { jobId } = await s.api.runCommand({ runtime: 'python', command: 'sleep 100' });
  await assert.rejects(s.api.openPreview({ runtime: 'web', port: 4173 }, { waitMs: 20 }), /no machine slot free/);
  assert.equal(await s.api.preview(), null, 'the preview that could not open is closed');
  assert.equal(s.api._get('web').busy(), false, 'nothing held for it');
  s.host('python').finish(jobId, '');
});

test('preview requests: concurrent first requests to a port agree on holding it', async () => {
  const { api } = setup({ budget: 2, man: appManifest, options: { isolated: true } });
  await api.openPreview({ runtime: 'web', port: 4173 });
  // Two first requests to supabase:54321 at once; the first is given up before it is answered
  const stop = new AbortController();
  const a = [];
  const b = [];
  const first = api.previewRequest(sbReq, (m) => a.push(m), { signal: stop.signal });
  const second = api.previewRequest(sbReq, (m) => b.push(m));
  stop.abort();
  await Promise.all([first, second]);
  assert.equal(a.at(-1).type, 'error');
  assert.deepEqual(b.map((m) => m.type), ['head', 'data', 'end']);
  assert.deepEqual(api._describe(api._get('supabase')).previewPorts, [54321], 'held: one of them was answered');
  assert.equal(api._get('supabase').inflight.size, 0, 'no request left counted');
  await api.closePreview();
  assert.equal(api._get('supabase').busy(), false);
});

test('open_preview\'s probe drops the connection once the head is in, the body never read', async () => {
  const { api, hosts } = setup({ man: appManifest, options: { isolated: true } });
  let aborted = 0;
  let wrote = 0;
  const r = await api.openPreview({ runtime: 'web', port: 4173 }, { check: false });
  assert.equal(r.status, undefined);
  const h = hosts.find((x) => x.config.name === 'web');
  h.tcpOpen = () => {
    const c = { write: (b) => {
      wrote++;
      // The head, then a body that never ends
      setImmediate(() => c.ondata(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nabc')));
    }, end() {}, abort() { aborted++; } };
    setImmediate(() => c.onconnect());
    return c;
  };
  const again = await api.openPreview({ runtime: 'web', port: 4173 });
  assert.equal(again.status, 200);
  assert.equal(wrote, 1);
  assert.equal(aborted, 1, 'dropped at the head');
});

test('connections into a machine: none kept once aborted, and every open one ends when the machine is put away', async () => {
  globalThis.SnowglobeMachineCore = require('./machine-core.js');
  const { createMachine } = require('./machine-host.js');
  const conns = [];
  class FakeArmless {
    constructor() { this.ready = Promise.resolve(); }
    on() {}
    run() {}
    destroy() {}
    connect(port) {
      const listeners = {};
      const c = { port, on: (ev, fn) => { (listeners[ev] ??= []).push(fn); return c; }, emit: (ev, ...a) => (listeners[ev] ?? []).forEach((fn) => fn(...a)),
        write() {}, close() {},
        // As armless's: an abort says close at once
        abort() { c.emit('close'); } };
      conns.push(c);
      setImmediate(() => c.emit('connect'));
      return c;
    }
  }
  const SC = globalThis.SnowglobeMachineCore;
  const Core = class extends SC.Core { constructor(o) { super({ ...o, Armless: FakeArmless, agent: null }); } };
  globalThis.SnowglobeMachineCore = { ...SC, Core, located: (b, c) => c };
  try {
    const host = createMachine({ base: 'https://x.example/', config: { network: { tls: 't' }, filesystem: { json: 'f', baseurl: 'b' } }, transport: 'inline' });
    await host.boot('s');
    await host.run();
    for (let i = 0; i < 5; i++) {
      const s = host.tcpOpen(80);
      await new Promise((r) => setImmediate(r));
      s.abort();
      await new Promise((r) => setTimeout(r, 2));
    }
    assert.equal(host._tcpTracked, 0, 'what a connection said after its abort is dropped, not kept');

    const heard = [];
    const s = host.tcpOpen(80);
    s.onclose = () => heard.push('close');
    s.onerror = () => heard.push('error');
    await new Promise((r) => setImmediate(r));
    await host.destroy();
    await new Promise((r) => setTimeout(r, 2));
    assert.equal(heard.length, 1, 'the machine went: its connection ended, once');
    assert.equal(host._tcpTracked, 0);
  } finally {
    globalThis.SnowglobeMachineCore = SC;
  }
});

// web with its project watched (label snowglobe.agent-watch)
const watchedManifest = { ...appManifest, runtimes: appManifest.runtimes.map((r) => r.name === 'web' ? { ...r, watch: '/root/app' } : r) };

test('in a watched machine each command reports what it changed: taken out of its output, given as changes', async () => {
  const { api, host, activity } = setup({ man: watchedManifest, options: { isolated: true } });
  assert.equal((await api.listRuntimes()).find((r) => r.name === 'web').watch, '/root/app');
  const { jobId } = await api.runCommand({ runtime: 'web', command: "sed -i 's/a/b/' src/App.jsx" }, { source: 'webmcp' });
  const job = host('web').jobs[jobId];
  assert.equal(new TextDecoder().decode(job.files.cmd), "sed -i 's/a/b/' src/App.jsx\n");
  assert.match(job.command, /sh "\$EXCLAVE_WORKSPACE\/in\/cmd"/);
  assert.equal(activity.at(-1).command, "sed -i 's/a/b/' src/App.jsx", 'the page hears the command as asked');
  assert.equal(activity.at(-1).watch, '/root/app');
  const nonce = /SGCHANGES (\w+)/.exec(job.command)[1]; // the report's, the job's own
  // Running, with the report under way: the output so far, no changes yet
  job.output = `ok\n\nSGCHANGES_${nonce} BEGIN\nSGC_FILE M src/App.jsx\n`;
  let v = await api.readJob(jobId);
  assert.deepEqual([v.state, v.output, v.changes], ['running', 'ok\n', null]);
  host('web').finish(jobId, `ok\n\nSGCHANGES_${nonce} BEGIN\nSGC_FILE M src/App.jsx\n@@ -1 +1 @@\n-a\n+b\nSGCHANGES_${nonce} END\n`);
  await settle();
  v = await api.readJob(jobId);
  assert.equal(v.output, 'ok\n');
  assert.deepEqual(v.changes.files.map((f) => [f.status, f.path, f.added, f.removed]), [['modified', 'src/App.jsx', 1, 1]]);
  assert.equal(v.watch, '/root/app');
  // A machine with nothing watched runs the command as it is
  const s = await api.runCommand({ runtime: 'supabase', command: 'psql' });
  assert.equal(host('supabase').jobs[s.jobId].command, 'psql');
  assert.equal(host('supabase').jobs[s.jobId].files, undefined);
});

test('writeFile: the content goes in as a file of the job\'s, never in the command; it resolves once written, with what changed', async () => {
  const { api, host, activity } = setup({ man: watchedManifest, options: { isolated: true } });
  await api.wake('web');
  host('web').onRun = (id, job) => setImmediate(() => {
    const nonce = /SGCHANGES (\w+)/.exec(job.command)[1];
    host('web').finish(id, `wrote 9 bytes to /root/app/src/x.js\n\nSGCHANGES_${nonce} BEGIN\nSGC_FILE A src/x.js\n@@ -0,0 +1 @@\n+it's $x\nSGCHANGES_${nonce} END\n`);
  });
  const r = await api.writeFile({ runtime: 'web', path: '/root/app/src/x.js', content: "it's $x\n" }, { source: 'webmcp' });
  assert.deepEqual([r.path, r.bytes, r.watch], ['/root/app/src/x.js', 8, '/root/app']);
  assert.deepEqual(r.changes.files.map((f) => [f.status, f.path]), [['added', 'src/x.js']]);
  const job = Object.values(host('web').jobs)[0];
  assert.equal(new TextDecoder().decode(job.files.content), "it's $x\n");
  const inner = new TextDecoder().decode(job.files.cmd);
  assert.ok(!inner.includes('$x') && inner.includes("f='/root/app/src/x.js'") && inner.includes('"$EXCLAVE_WORKSPACE/in/content"'), inner);
  assert.equal(activity.find((e) => e.kind === 'run').command, 'write /root/app/src/x.js (8 bytes)');
  // Refused before anything runs
  await assert.rejects(api.writeFile({ runtime: 'web', path: '/root/app/', content: 'x' }), /path/);
  await assert.rejects(api.writeFile({ runtime: 'web', path: 'a\nb', content: 'x' }), /path/);
  await assert.rejects(api.writeFile({ runtime: 'web', path: 'a', content: 'x'.repeat((1 << 20) + 1) }), /at most 1048576/);
  // A write that fails says so
  host('web').onRun = (id) => setImmediate(() => { Object.assign(host('web').jobs[id], { state: 'exited', exitStatus: 1, output: 'cat: read-only file system\n' }); host('web').emit('job', { jobId: id }); });
  await assert.rejects(api.writeFile({ runtime: 'web', path: '/ro/x', content: 'x' }), /\/ro\/x was not written: exit 1: cat: read-only/);
});

test('previewGet: a small GET for the page, only while a preview is open and allowed, and never waking a machine', async () => {
  const { api, log } = setup({ man: watchedManifest, options: { isolated: true } });
  assert.equal(await api.previewGet({ runtime: 'web', port: 4173, path: '/__build' }), null, 'no preview open');
  await api.openPreview({ runtime: 'web', port: 4173 });
  const r = await api.previewGet({ runtime: 'web', port: 4173, path: '/__build' });
  assert.deepEqual(r, { status: 200, body: 'ok' });
  assert.equal(await api.previewGet({ runtime: 'supabase', port: 54321, path: '/' }), null, 'supabase is asleep: not woken for it');
  assert.ok(!log.some((l) => /boot supabase/.test(l)));
  assert.equal((await api.previewGet({ runtime: 'web', port: 9999, path: '/' })).error, true, 'nothing listens there');
  await api.closePreview();
  assert.equal(await api.previewGet({ runtime: 'web', port: 4173, path: '/__build' }), null);
});

// A job that ends as `fn(command, files)` says: [exitStatus, output]
const answer = (h, fn) => { h.onRun = (id, job) => setImmediate(() => {
  const [exitStatus, output] = fn(job.command, job.files ?? {});
  Object.assign(h.jobs[id], { state: 'exited', exitStatus, output });
  h.emit('job', { jobId: id });
}); };

test('the project\'s files: a listing and a read are one unwrapped job each, quiet in the feed when the page asks', async () => {
  const { api, host, activity } = setup({ man: watchedManifest, options: { isolated: true } });
  await api.wake('web');
  answer(host('web'), (cmd) => /SGLS_ERR/.test(cmd)
    ? [0, 'SGLS_DIR /root/app\nSGLS directory|4096|./src\nSGLS regular file|120|./src/App.jsx\nSGLS directory|4096|./node_modules\nSGLS regular file|9|./package.json\n']
    : [0, `SGRF_HEAD 0 6\n${Buffer.from('hello\n').toString('base64')}\nSGRF_END 0\nSGRF_ERR 1 no such file\nSGRF_HEAD 2 4\n${Buffer.from([0, 1, 2, 255]).toString('base64')}\nSGRF_END 2\n`]);
  const l = await api.listFiles({ runtime: 'web' }, { source: 'webmcp' });
  assert.equal(l.dir, '/root/app');
  assert.deepEqual(l.entries.map((e) => [e.path, e.type, e.size, !!e.skipped]),
    [['node_modules', 'dir', 0, true], ['package.json', 'file', 9, false], ['src', 'dir', 0, false], ['src/App.jsx', 'file', 120, false]]);
  const job = Object.values(host('web').jobs)[0];
  assert.ok(!/SGCHANGES/.test(job.command), 'a read is not wrapped');
  assert.match(job.command, /^d='\/root\/app'$/m);
  const r = await api.readFiles({ runtime: 'web', paths: ['src/a.txt', 'nope', 'bin'] }, { source: 'webmcp' });
  assert.deepEqual(r, [{ path: 'src/a.txt', size: 6, text: 'hello\n', truncated: false }, { path: 'nope', error: 'no such file' }, { path: 'bin', size: 4, binary: true }]);
  assert.deepEqual(activity.filter((e) => e.kind === 'list' || e.kind === 'read').map((e) => [e.kind, e.path ?? e.paths]), [['list', '/root/app'], ['read', ['src/a.txt', 'nope', 'bin']]]);
  assert.ok(!activity.some((e) => e.kind === 'run'), 'reads are not runs in the feed');
  await api.readFiles({ runtime: 'web', path: 'x' }, { source: 'studio' });
  assert.equal(activity.filter((e) => e.kind === 'read').length, 1, 'the page\'s own reads are not in the feed');
  await assert.rejects(api.readFiles({ runtime: 'web', paths: [] }), /paths/);
});

test('writeFiles: several files, moves and deletes in one wrapped job, contents as job files; revert and its nothing-to-undo', async () => {
  const { api, host, activity } = setup({ man: watchedManifest, options: { isolated: true } });
  await api.wake('web');
  answer(host('web'), (cmd, files) => {
    const nonce = /SGCHANGES (\w+)/.exec(cmd)?.[1];
    const inner = new TextDecoder().decode(files.cmd);
    if (/nothing to undo/.test(inner) && host('web').empty) return [3, 'nothing to undo: no change is kept\n'];
    return [0, `ok\n\nSGCHANGES_${nonce} BEGIN\nSGC_FILE A src/a.jsx\n+a\nSGC_FILE M src/App.jsx\n-x\n+y\nSGCHANGES_${nonce} END\n`];
  });
  const r = await api.writeFiles({ runtime: 'web', files: [{ path: '/root/app/src/a.jsx', content: "a $b 'c'\n" }, { path: '/root/app/src/App.jsx', content: 'y\n' }],
    move: [{ from: '/root/app/src/old.css', to: '/root/app/src/new.css' }], delete: ['/root/app/src/gone.jsx'] }, { source: 'webmcp' });
  assert.deepEqual([r.written, r.bytes, r.changes.files.length], [2, 11, 2]);
  const job = Object.values(host('web').jobs)[0];
  assert.equal(new TextDecoder().decode(job.files.f0), "a $b 'c'\n");
  const inner = new TextDecoder().decode(job.files.cmd);
  assert.ok(!inner.includes("a $b 'c'") && inner.includes('.sgnew') && inner.includes("rm -rf -- \"$p\"") && inner.includes("a='/root/app/src/old.css'"), inner);
  assert.equal(activity.find((e) => e.kind === 'run').command, 'write 2 files, 1 moved, 1 deleted');
  await assert.rejects(api.writeFiles({ runtime: 'web', files: [] }), /nothing to do/);
  await assert.rejects(api.writeFiles({ runtime: 'web', files: [{ path: 'a', content: 1 }] }), /content/);
  await assert.rejects(api.writeFiles({ runtime: 'web', files: [{ path: 'a', content: '' }, { path: 'a', content: '' }] }), /twice/);
  const u = await api.revert({ runtime: 'web', to: 'previous' });
  assert.equal(u.changes.files.length, 2);
  host('web').empty = true;
  await assert.rejects(api.revert({ runtime: 'web', to: 'previous' }), /nothing to undo/);
  await assert.rejects(api.revert({ runtime: 'supabase', to: 'start' }), /no watched project/);
});

test('runSql: the SQL is a job file run by psql, and the Data API is told to reload its schema', async () => {
  const { api, host, activity } = setup({ man: watchedManifest, options: { isolated: true } });
  await api.wake('supabase');
  answer(host('supabase'), () => [0, 'ALTER TABLE\n']);
  const r = await api.runSql({ sql: "alter table notes add column done boolean;\nselect 'x';" }, { source: 'webmcp' });
  assert.deepEqual([r.runtime, r.exitStatus, r.output], ['supabase', 0, 'ALTER TABLE\n']);
  const job = Object.values(host('supabase').jobs)[0];
  assert.equal(new TextDecoder().decode(job.files.sql), "alter table notes add column done boolean;\nselect 'x';");
  assert.match(job.command, /ON_ERROR_STOP=1 .*-f "\$EXCLAVE_WORKSPACE\/in\/sql"/);
  assert.match(job.command, /notify pgrst, 'reload schema'/);
  assert.equal(activity.find((e) => e.kind === 'run').command, 'SQL: alter table notes add column done boolean;');
  await api.runSql({ sql: 'select 1' }, { tsv: true, silent: true });
  assert.equal(activity.filter((e) => e.kind === 'run').length, 1, 'a silent read is not in the feed');
  assert.match(Object.values(host('supabase').jobs)[1].command, /-A -t -F/);
});

test('buildStatus: reads /__build over the machine\'s network, waking it first; nothing there is said', async () => {
  const { api, host } = setup({ man: watchedManifest, options: { isolated: true } });
  const b = await api.buildStatus({ runtime: 'web' });
  assert.equal(b.state, 'none', 'the stand-in answers "ok", not JSON');
  assert.equal(host('web').config.name, 'web', 'woken for it');
  assert.equal((await api.buildStatus({ runtime: 'web', port: 9999 })).state, 'none');
});

test("the guest's fetch drops npm's and the cache's hints, so a registry GET needs no preflight", async () => {
  const { guestFetch } = require('./machine-core.js');
  const real = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => { seen = { url, init }; return new Response('{}'); };
  try {
    await guestFetch('https://registry.npmjs.org/ms', { method: 'GET', headers: new Headers([
      ['accept', 'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'],
      ['npm-command', 'install'], ['npm-session', 'abc'], ['pacote-version', '21'], ['pacote-req-type', 'packument'],
      ['cache-control', 'max-age=0'], ['pragma', 'no-cache'], ['user-agent', 'npm/11'], ['authorization', 'Bearer t']]) });
    assert.deepEqual([...seen.init.headers.keys()].sort(), ['accept', 'authorization']);
    assert.equal(seen.init.method, 'GET');
    await guestFetch('https://x.example/', undefined);
    assert.equal(seen.init, undefined);
  } finally {
    globalThis.fetch = real;
  }
});

test('links: a machine reads its names when it wakes, and the page answers its target without a preview', async () => {
  const { api, log, hosts } = setup({ man: appManifest, options: { isolated: true } });
  const ask = async (req) => { const sent = []; await api.previewRequest({ method: 'GET', path: '/', headers: [], prefix: '/p', origin: 'https://x.example', ...req }, (m) => sent.push(m)); return sent; };
  // Declared before anything wakes: nothing to suspend
  assert.deepEqual(await api.setLinks([{ from: 'web', to: 'supabase', port: 54321, as: 'db.internal' }]), []);
  await api.wake('web');
  const cfg = hosts.find((h) => h.config.name === 'web').config;
  assert.deepEqual({ ...cfg.links }, { 'db.internal': { runtime: 'supabase', port: 54321 } });
  assert.equal(cfg.link_base, 'https://x.example/snowglobe/agent/', 'the page directory');
  // supabase has no other machine's names; python (no link) has none
  await api.runCommand({ runtime: 'supabase', command: 'true' }); // the person's yes, as a click gives it
  assert.equal(hosts.find((h) => h.config.name === 'supabase').config.links, undefined);

  // The target's port is answered with no preview open (the machine is woken and asked); another port and machine are not
  let sent = await ask({ runtime: 'supabase', port: 54321 });
  assert.notEqual(sent[0].status, 403);
  sent = await ask({ runtime: 'supabase', port: 5432 });
  assert.equal(sent[0].status, 403);
  sent = await ask({ runtime: 'web', port: 54321 });
  assert.equal(sent[0].status, 403);

  // Changing the links suspends the machine that was awake with other names (it reads them at its next wake)
  const before = log.length;
  assert.deepEqual(await api.setLinks([]), ['web']);
  assert.ok(log.slice(before).some((l) => l === 'capture web'));
  sent = await ask({ runtime: 'supabase', port: 54321 });
  assert.equal(sent[0].status, 403, 'the target is no longer one');
  // The same links again change nothing
  await api.setLinks([{ from: 'web', to: 'supabase', port: 54321, as: 'db.internal' }]);
  assert.deepEqual(await api.setLinks([{ from: 'web', to: 'supabase', port: 54321, as: 'db.internal' }]), []);
});

test('links: refused with the reason', async () => {
  const { api } = setup({ man: appManifest, options: { isolated: true } });
  const l = (o) => api.setLinks([{ from: 'web', to: 'supabase', port: 80, as: 'x.internal', ...o }]);
  await assert.rejects(l({ to: 'web' }), /link to itself/);
  await assert.rejects(l({ from: 'python' }), /python has no network device/);
  await assert.rejects(l({ to: 'duckdb' }), /no such|duckdb/i);
  await assert.rejects(l({ port: 0 }), /port/);
  await assert.rejects(l({ as: '10.0.0.1' }), /host name/);
  await assert.rejects(l({ as: 'a b' }), /host name/);
  await assert.rejects(l({ from: 'nope' }), /nope/);
  await assert.rejects(api.setLinks('x'), /setLinks/);
  // A refusal changes nothing: no link is a target
  const sent = [];
  await api.previewRequest({ method: 'GET', path: '/', headers: [], prefix: '/p', origin: 'https://x.example', runtime: 'supabase', port: 80 }, (m) => sent.push(m));
  assert.equal(sent[0].status, 403);
});

// ------------------------------------------------------------------ raw TCP over links

// Connections into a machine that the test drives: each is { port, written, ended, aborted }, and
// the test calls its onconnect, ondata, onend, onclose and onerror
function streams() {
  const all = [];
  const tcp = (port, h) => {
    const c = { port, machine: h.config.name, written: [], ended: false, aborted: 0, writeResult: null,
      write(b) { c.written.push(new TextDecoder().decode(b)); return c.writeResult ?? Promise.resolve(true); },
      end() { c.ended = true; }, abort() { c.aborted++; } };
    all.push(c);
    return c;
  };
  return { all, tcp };
}
const enc = (s) => new TextEncoder().encode(s);
const dbLink = { from: 'web', to: 'supabase', port: 5432, as: 'db.internal' };

/** web awake with its links, the person's yes given, and web's host */
async function linked(o = {}) {
  const st = streams();
  const s = setup({ man: appManifest, options: { isolated: true }, tcp: st.tcp, ...o });
  await s.api.setLinks(o.links ?? [dbLink]);
  await s.api.runCommand({ runtime: 'web', command: 'true' }); // wakes it, and the person's yes
  s.host('web').finish(s.api._get('web').job, '');
  await settle();
  return { ...s, st, web: s.host('web') };
}

test('links over TCP: each link is a tunnel in its machine\'s config; as_port is checked like port, and HTTP to a name goes to its first link', async () => {
  const { api, hosts } = setup({ man: appManifest, options: { isolated: true } });
  await api.setLinks([{ from: 'web', to: 'supabase', port: 54321, as: 'db.internal' }, { ...dbLink, as_port: 6543 }, { from: 'web', to: 'supabase', port: 5432, as: 'pg.internal' }]);
  await api.wake('web');
  const cfg = hosts.find((h) => h.config.name === 'web').config;
  assert.deepEqual(cfg.network.tunnels, [
    { host: 'db.internal', port: 54321, url: 'wss://link.invalid/supabase/54321' },
    { host: 'db.internal', port: 6543, url: 'wss://link.invalid/supabase/5432' },
    { host: 'pg.internal', port: 5432, url: 'wss://link.invalid/supabase/5432' }]);
  assert.equal(cfg.network.tls, 'system/tls.json', 'the rest of its network as it was');
  assert.deepEqual({ ...cfg.links }, { 'db.internal': { runtime: 'supabase', port: 54321 }, 'pg.internal': { runtime: 'supabase', port: 5432 } });
  // The url is what machine-core.js recognises
  const { parseLinkUrl, linkUrl } = require('./machine-core.js');
  assert.deepEqual(parseLinkUrl(cfg.network.tunnels[1].url), { runtime: 'supabase', port: 5432 });
  assert.equal(linkUrl('supabase', 5432), cfg.network.tunnels[1].url);
  const l = (o) => api.setLinks([{ ...dbLink, ...o }]);
  await assert.rejects(l({ as_port: 0 }), /as_port/);
  await assert.rejects(l({ as_port: 70000 }), /as_port/);
  await assert.rejects(l({ as_port: 1.5 }), /as_port/);
  await assert.rejects(l({ as_port: 'x' }), /as_port/);
  await assert.rejects(api.setLinks([dbLink, { ...dbLink, port: 5433, as_port: 5432 }]), /db\.internal:5432 twice/);
  // Changing only an as_port is a change: the awake machine is suspended for it
  assert.deepEqual(await api.setLinks([{ from: 'web', to: 'supabase', port: 54321, as: 'db.internal' }, { ...dbLink, as_port: 6544 }, { from: 'web', to: 'supabase', port: 5432, as: 'pg.internal' }]), ['web']);
});

test('links over TCP: open, connect, bytes both ways, the guest\'s half-close, the server\'s end; the machine reached is woken, held awake while open, and let go after', async () => {
  const { api, st, web, log } = await linked();
  const sb = api._get('supabase');
  assert.equal(sb.lifecycle.state, 'suspended');
  web.emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  assert.equal(sb.busy(), true, 'held from the moment it is asked for');
  await settle();
  assert.equal(sb.lifecycle.state, 'running', 'woken for it');
  assert.ok(log.includes('connect supabase:5432'));
  const c = st.all[0];
  assert.deepEqual(web.linked, [], 'nothing said to the guest before the server accepts');
  c.onconnect();
  await settle();
  assert.deepEqual(web.linked, [[1, 'connect']]);
  web.emit('link', { cid: 1, kind: 'data', bytes: enc('SELECT 1') });
  c.ondata(enc('row 1'));
  await settle();
  assert.deepEqual(c.written, ['SELECT 1']);
  assert.deepEqual(web.linked.at(-1), [1, 'data', 'row 1']);
  assert.deepEqual(api._describe(sb).linkConnections, { in: 1, out: 0 });
  assert.equal(api._describe(sb).doing, 'serving 1 link connection');
  assert.deepEqual(api._describe(api._get('web')).linkConnections, { in: 0, out: 1 });
  assert.equal(await api.suspend('supabase'), false, 'not suspended while a connection is open');
  // The guest finished sending: the server reads its end, and still answers
  web.emit('link', { cid: 1, kind: 'end' });
  assert.equal(c.ended, true);
  c.ondata(enc('bye'));
  await settle();
  assert.deepEqual(web.linked.at(-1), [1, 'data', 'bye']);
  // The server finished too: the guest is told, the page's side ends, and the close lets go
  c.onend();
  assert.deepEqual(web.linked.at(-1), [1, 'end']);
  assert.equal(sb.busy(), true, 'held until the server closes');
  c.onclose();
  await settle();
  assert.deepEqual(web.linked.at(-1), [1, 'end'], 'nothing more said: the guest\'s side is closed already');
  assert.equal(c.aborted, 0, 'closed cleanly, not aborted');
  assert.equal(sb.busy(), false);
  assert.deepEqual(api._describe(sb).linkConnections, { in: 0, out: 0 });
  assert.equal(await api.suspend('supabase'), true);
  // What comes for a connection that is over is dropped
  web.emit('link', { cid: 1, kind: 'data', bytes: enc('late') });
  assert.equal(c.written.length, 1);
});

test('links over TCP: nothing listening refuses the guest; a server that closes is a close; an abort of a half-open attempt lets go', async () => {
  const { api, st, web } = await linked();
  const sb = api._get('supabase');
  web.emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  st.all[0].onclose(); // a close with no connect: nothing listens on 5432
  await settle();
  assert.deepEqual(web.linked, [[1, 'close']]);
  assert.equal(sb.busy(), false);
  assert.equal(st.all[0].aborted, 0);

  web.emit('link', { cid: 2, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  st.all[1].onconnect();
  st.all[1].onclose();
  await settle();
  assert.deepEqual(web.linked.slice(1), [[2, 'connect'], [2, 'close']]);
  assert.equal(sb.busy(), false);

  // The guest gives up on its SYN before the server accepts: b's side aborted, nothing held
  web.emit('link', { cid: 3, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  web.emit('link', { cid: 3, kind: 'close' });
  assert.equal(st.all[2].aborted, 1);
  assert.equal(sb.busy(), false);
  st.all[2].onconnect(); // too late: nothing said
  await settle();
  assert.equal(web.linked.filter(([cid]) => cid === 3).length, 0);
  // And while the machine it reaches still wakes
  await api.suspend('supabase');
  web.emit('link', { cid: 4, kind: 'open', runtime: 'supabase', port: 5432 });
  web.emit('link', { cid: 4, kind: 'close' });
  await settle();
  assert.equal(sb.busy(), false);
  assert.equal(st.all.length, 3, 'no connection made for it');
});

test('links over TCP: only the machine\'s own declared links, once the person allowed the page; a worker\'s forged runtime or port is refused', async () => {
  const { api, st, web, host, log } = await linked({ links: [dbLink, { from: 'web', to: 'supabase', port: 54321, as: 'api.internal' }] });
  const open = (h, cid, runtime, port) => h.emit('link', { cid, kind: 'open', runtime, port });
  open(web, 1, 'supabase', 5433); // a port it has no link to
  open(web, 2, 'python', 5432); // a machine it has no link to
  open(web, 3, 'web', 5432); // itself
  open(web, 4, 'nope', 5432);
  open(web, 5, 'supabase', '5432'); // not a number
  open(web, 1.5, 'supabase', 5432); // not a connection id
  await settle();
  assert.deepEqual(web.linked, [[1, 'close'], [2, 'close'], [3, 'close'], [4, 'close'], [5, 'close']]);
  assert.equal(st.all.length, 0);
  assert.ok(!log.some((l) => l.startsWith('boot supabase')), 'nothing woken for them');
  // supabase is a link target (of web's), but supabase itself declared none: its guest can't use web's
  await api.wake('supabase');
  open(host('supabase'), 1, 'supabase', 5432);
  await settle();
  assert.deepEqual(host('supabase').linked, [[1, 'close']]);
  // A host that is no longer the machine's (put away) is refused too
  await api.suspend('web');
  open(web, 7, 'supabase', 5432);
  await settle();
  assert.deepEqual(web.linked.at(-1), [7, 'close']);

  // Not allowed yet: refused
  const st2 = streams();
  let yes = false;
  const s = setup({ man: appManifest, options: { isolated: true, granted: () => yes }, tcp: st2.tcp });
  await s.api.setLinks([dbLink]);
  await s.api.wake('web');
  s.host('web').emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  assert.deepEqual(s.host('web').linked, [[1, 'close']]);
  yes = true;
  s.host('web').emit('link', { cid: 2, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  assert.equal(st2.all.length, 1);
});

test('links over TCP: at most 64 at once over one link; the 65th is refused, and one more is taken once one closes', async () => {
  const { api, st, web } = await linked();
  for (let cid = 1; cid <= 65; cid++) web.emit('link', { cid, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  assert.deepEqual(web.linked, [[65, 'close']]);
  assert.equal(api._get('supabase').linksIn, 64);
  // The same cid again is not a second connection
  web.emit('link', { cid: 3, kind: 'open', runtime: 'supabase', port: 5432 });
  assert.equal(api._get('supabase').linksIn, 64);
  st.all[0].onclose();
  web.emit('link', { cid: 66, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  assert.equal(api._get('supabase').linksIn, 64);
  assert.ok(!web.linked.some(([cid]) => cid === 66));
});

test('links over TCP: the connecting machine going ends its connections; the machine reached going tells the guest', async () => {
  const { api, st, web } = await linked();
  const sb = api._get('supabase');
  web.emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  web.emit('link', { cid: 2, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  st.all[0].onconnect();
  await settle();
  // web is suspended (its worker ended): supabase's side of both is aborted, and let go
  assert.equal(await api.suspend('web'), true);
  assert.deepEqual(st.all.map((c) => c.aborted), [1, 1]);
  assert.equal(sb.busy(), false);
  assert.deepEqual(api._describe(api._get('web')).linkConnections, { in: 0, out: 0 });
  web.emit('link', { kind: 'gone' }); // said again: nothing more
  assert.deepEqual(st.all.map((c) => c.aborted), [1, 1]);

  // supabase goes under an open connection (it fails): the guest hears an error, nothing is held
  await api.wake('web');
  const w2 = api._get('web').host;
  w2.emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  const c = st.all.at(-1);
  c.onconnect();
  await settle();
  sb.lifecycle.failed(new Error('boom'));
  c.onerror(new Error('the machine was put away')); // as its host's streams do when it ends
  await settle();
  assert.deepEqual(w2.linked.at(-1), [1, 'error']);
  assert.equal(sb.linksIn, 0);
  assert.equal(api._get('web').linksOut, 0);
  assert.equal(c.aborted, 0, 'nothing to abort: it is gone');
});

test('links over TCP: a machine reached that can\'t wake refuses the guest; bytes the other side doesn\'t take are bounded', async () => {
  // supabase needs the page isolated: it can't wake here
  const st0 = streams();
  const s = setup({ man: appManifest, options: { isolated: false }, tcp: st0.tcp });
  await s.api.setLinks([dbLink]);
  await s.api.runCommand({ runtime: 'web', command: 'true' });
  s.host('web').emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  assert.deepEqual(s.host('web').linked, [[1, 'error']]);
  assert.equal(s.api._get('supabase').busy(), false);

  const { api, st, web } = await linked();
  web.emit('link', { cid: 1, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  const c = st.all[0];
  c.onconnect();
  await settle();
  // The server takes nothing: its writes never finish
  c.writeResult = new Promise(() => {});
  const chunk = new Uint8Array(1 << 20);
  for (let i = 0; i < 8; i++) web.emit('link', { cid: 1, kind: 'data', bytes: chunk });
  assert.equal(c.aborted, 0, '8 MiB on their way: still open');
  web.emit('link', { cid: 1, kind: 'data', bytes: chunk });
  assert.equal(c.aborted, 1, 'past 8 MiB: closed');
  assert.deepEqual(web.linked.at(-1), [1, 'error']);
  assert.equal(api._get('supabase').busy(), false);
  // Written and taken: never counted against it
  web.emit('link', { cid: 2, kind: 'open', runtime: 'supabase', port: 5432 });
  await settle();
  st.all[1].onconnect();
  await settle();
  for (let i = 0; i < 20; i++) { web.emit('link', { cid: 2, kind: 'data', bytes: chunk }); await settle(); }
  assert.equal(st.all[1].aborted, 0);
  assert.equal(st.all[1].written.length, 20);
});

// ---------------------------------------------------------------- WebSockets from the preview's pages

globalThis.SnowglobeWsClient = require('./ws-client.js');
const { server: wsServer } = require('./ws-test-server.cjs');
const sbSocket = 'https://x.example/snowglobe/agent/preview/supabase/54321/realtime/v1/websocket?apikey=anon&vsn=1.0.0';

/** The page's end of a preview socket's MessageChannel: what it said, and the shim's side to talk. */
function channel() {
  const said = [];
  const p = {
    said, closed: false, onmessage: null,
    postMessage(msg, transfer) { said.push({ ...msg, transferred: transfer?.length ? transfer : undefined }); },
    close() { p.closed = true; },
    shim(data) { p.onmessage?.({ data }); },
    types: () => said.map((m) => m.type),
  };
  return p;
}

/** A setup whose machines' port 54321 is a WebSocket server (a new one per connection: `servers`). */
function socketSetup(o = {}, serverOpts = { echo: true }) {
  const servers = [];
  const s = setup({ man: appManifest, options: { isolated: true, ...o }, tcp: (port, h) => {
    if (port !== 54321) {
      const c = { write: (b) => { if (new TextDecoder().decode(b).endsWith('\r\n\r\n')) setImmediate(() => { c.ondata(new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nok')); c.onclose(); }); }, end() {}, abort() {} };
      setImmediate(() => (port === 4173 ? c.onconnect() : c.onclose()));
      return c;
    }
    const sv = wsServer(typeof serverOpts === 'function' ? serverOpts(servers.length) : serverOpts);
    sv.host = h;
    servers.push(sv);
    return sv.connect();
  } });
  return { ...s, servers };
}

test('preview sockets: refused with the reason (no preview, not allowed, not a preview address, bad protocols), and nothing woken for them', async () => {
  let allowed = false;
  const { api, log } = socketSetup({ granted: () => allowed });
  let p = channel();
  api.previewSocket({ url: sbSocket, protocols: [] }, p);
  assert.deepEqual(p.types(), ['taken', 'error', 'close']);
  assert.match(p.said[1].message, /no preview is open/);
  assert.deepEqual(p.said[2], { type: 'close', code: 1006, reason: '', wasClean: false, transferred: undefined });
  assert.equal(p.closed, true);

  await api.openPreview({ runtime: 'web', port: 4173 }, { check: false });
  p = channel();
  api.previewSocket({ url: sbSocket }, p);
  assert.match(p.said[1].message, /hasn't allowed/);
  allowed = true;
  for (const [url, re] of [['https://evil.example/snowglobe/agent/preview/supabase/54321/', /not an address under this page's preview/],
    ['https://x.example/snowglobe/other/preview/supabase/54321/', /not an address under/], ['https://x.example/snowglobe/agent/preview/supabase/0/', /not a port/],
    ['https://x.example/snowglobe/agent/preview/nosuch/54321/', /no runtime "nosuch"/], ['https://x.example/snowglobe/agent/preview/python/80/', /no network device/], [42, /not an address/]]) {
    p = channel();
    api.previewSocket({ url }, p);
    assert.deepEqual(p.types(), ['taken', 'error', 'close'], String(url));
    assert.match(p.said[1].message, re);
  }
  p = channel();
  api.previewSocket({ url: sbSocket, protocols: ['a b'] }, p);
  assert.match(p.said[1].message, /not a subprotocol/);
  assert.ok(!log.some((l) => /boot supabase/.test(l)), 'supabase never woken');
  await api.closePreview();
});

test('preview sockets: the WebSocket spoken by the page over a TCP connection into the machine; messages both ways, decoded; the machine held while open, let go after', async () => {
  const { api, servers, log } = socketSetup();
  await api.openPreview({ runtime: 'web', port: 4173 });
  const p = channel();
  api.previewSocket({ url: sbSocket, protocols: ['phoenix'] }, p);
  await settle();
  assert.ok(log.includes('connect supabase:54321'), 'supabase woken and connected to');
  const sv = servers[0];
  assert.equal(sv.head.line, 'GET /realtime/v1/websocket?apikey=anon&vsn=1.0.0 HTTP/1.1');
  assert.equal(sv.head.headers.host, 'localhost:54321', 'a Host on the machine, as the preview\'s HTTP has');
  assert.equal(sv.head.headers.origin, 'https://x.example', 'the page\'s origin');
  assert.equal(sv.head.headers['sec-websocket-protocol'], 'phoenix');
  assert.deepEqual(p.types(), ['taken', 'open']);
  assert.equal(p.said[1].protocol, 'phoenix');
  const sb = api._get('supabase');
  assert.deepEqual([...sb.previews.entries()], [[54321, 'linked']], 'held as a preview request that was answered');
  assert.equal(sb.busy(), true);

  p.shim({ type: 'send', data: '{"event":"heartbeat","topic":"phoenix","ref":"1"}', n: 0 });
  const bin = new Uint8Array([1, 2, 3]).buffer;
  p.shim({ type: 'send', data: bin, n: 3 });
  p.shim({ type: 'send', data: { not: 'data' }, n: 1 });
  await settle();
  assert.deepEqual(sv.received.map((r) => (typeof r === 'string' ? r : [...r].join())), ['{"event":"heartbeat","topic":"phoenix","ref":"1"}', '1,2,3']);
  const messages = p.said.filter((m) => m.type === 'message');
  assert.equal(messages[0].data, '{"event":"heartbeat","topic":"phoenix","ref":"1"}');
  assert.ok(messages[1].data instanceof ArrayBuffer);
  assert.equal(messages[1].transferred[0], messages[1].data, 'binary handed over, not copied');
  assert.deepEqual(p.said.filter((m) => m.type === 'sent').map((m) => m.n), [49, 3], 'what the machine took: the shim\'s bufferedAmount');

  p.shim({ type: 'close', code: 1000, reason: 'bye' });
  await settle();
  assert.deepEqual(sv.gotClose, { code: 1000, reason: 'bye' });
  assert.deepEqual(p.said.at(-1), { type: 'close', code: 1000, reason: 'bye', wasClean: true, transferred: undefined });
  assert.equal(p.closed, true);
  assert.equal(sb.inflight.size, 0, 'not counted any more');
  await api.closePreview();
  assert.equal(sb.busy(), false);
});

test('preview sockets: closing the preview closes them (1001); a page that goes away, before or after it connected; a machine that goes away under one', async () => {
  const { api, servers } = socketSetup();
  await api.openPreview({ runtime: 'web', port: 4173 });
  const a = channel();
  api.previewSocket({ url: sbSocket }, a);
  await settle();
  assert.deepEqual(a.types(), ['taken', 'open']);
  await api.closePreview();
  await settle();
  assert.equal(servers[0].gotClose.code, 1001, 'going away');
  assert.deepEqual(a.said.at(-1).type, 'close');
  assert.equal(api._get('supabase').inflight.size, 0);

  await api.openPreview({ runtime: 'web', port: 4173 });
  const b = channel();
  api.previewSocket({ url: sbSocket }, b);
  b.shim({ type: 'gone' }); // before it connected
  await settle();
  assert.deepEqual(b.types(), ['taken', 'error', 'close']);
  assert.match(b.said[1].message, /went away/);
  const c = channel();
  api.previewSocket({ url: sbSocket }, c);
  await settle();
  c.shim({ type: 'gone' });
  await settle();
  assert.equal(servers.at(-1).gotClose.code, 1001);
  assert.equal(c.said.at(-1).type, 'close');

  const d = channel();
  api.previewSocket({ url: sbSocket }, d);
  await settle();
  servers.at(-1).fail(new Error('the machine was put away'));
  await settle();
  assert.deepEqual(d.types().slice(-2), ['error', 'close']);
  assert.match(d.said.at(-2).message, /supabase's port 54321: the machine was put away/);
  assert.equal(d.said.at(-1).code, 1006);
  assert.equal(api._get('supabase').inflight.size, 0, 'every one let go');
  await api.closePreview();
});

test('preview sockets: at most 32 at once; bytes the machine doesn\'t take are bounded; a handshake the server refuses is said', async () => {
  const { api, servers } = socketSetup({}, (i) => (i === 33 ? { respond: () => 'HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n' } : { respond: () => null }));
  await api.openPreview({ runtime: 'web', port: 4173 });
  const open = [];
  for (let i = 0; i < 32; i++) {
    const p = channel();
    api.previewSocket({ url: sbSocket }, p);
    open.push(p);
  }
  const over = channel();
  api.previewSocket({ url: sbSocket }, over);
  assert.match(over.said[1].message, /at most 32 WebSockets from the preview at once/);
  await settle();
  assert.equal(servers.length, 32, 'none connected for the 33rd');
  await api.closePreview(); // the 32, still in their handshake, end
  await settle();
  assert.ok(open.every((p) => p.said.at(-1).type === 'close'));
  await api.openPreview({ runtime: 'web', port: 4173 });
  const refused = channel();
  api.previewSocket({ url: sbSocket }, refused);
  await settle();
  // servers[33] answers 404 (servers[32], the one before, never answers its handshake)
  const nf = channel();
  api.previewSocket({ url: sbSocket }, nf);
  await settle();
  assert.match(nf.said.find((m) => m.type === 'error')?.message ?? '', /answered 404 Not Found/);
  await api.closePreview();

  const slow = socketSetup({}, { writeMs: 50 });
  await slow.api.openPreview({ runtime: 'web', port: 4173 });
  const s = channel();
  slow.api.previewSocket({ url: sbSocket }, s);
  await settle();
  await new Promise((r) => setTimeout(r, 60));
  s.shim({ type: 'send', data: new ArrayBuffer(9 << 20), n: 9 << 20 });
  await settle();
  assert.match(s.said.find((m) => m.type === 'error')?.message ?? '', /more than 8388608 bytes on their way to supabase/);
  assert.equal(s.said.find((m) => m.type === 'close').code, 1006);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(s.said.at(-1).type, 'close', 'nothing said after the close');
  await slow.api.closePreview();
});
