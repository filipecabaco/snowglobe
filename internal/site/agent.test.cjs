const { test } = require('node:test');
const assert = require('node:assert/strict');
const A = require('./agent.js');
const W = require('./agent-webmcp.js');

test('the marker carries status and kill, and only a whole line with the nonce counts', () => {
  assert.deepEqual(A.parseMarker('out\nSGDONE_ab_n0_143_1\n# ', 'ab', 'n0'), { status: 143, killed: true, at: 3, end: 23 });
  assert.equal(A.parseMarker('\nSGDONE_ab_n0_0_0\n', 'ab', 'n0').status, 0);
  assert.equal(A.parseMarker('\nSGDONE_ab_n0_7_0\r\n', 'ab', 'n0').status, 7);
  // Not this job's, not a whole line yet, or not at the start of its line
  assert.equal(A.parseMarker('\nSGDONE_cd_n0_0_0\n', 'ab', 'n0'), null);
  assert.equal(A.parseMarker('\nSGDONE_ab_n0_0_0', 'ab', 'n0'), null);
  assert.equal(A.parseMarker('x SGDONE_ab_n0_0_0\n', 'ab', 'n0'), null);
  // Without the nonce, with another, or with more after it
  assert.equal(A.parseMarker('\nSGDONE_ab_0_0\n', 'ab', 'n0'), null);
  assert.equal(A.parseMarker('\nSGDONE_ab_n1_0_0\n', 'ab', 'n0'), null);
  assert.equal(A.parseMarker('\nSGDONE_ab_n0_0_0x\n', 'ab', 'n0'), null);
  assert.equal(A.parseMarker('\nSGDONE_ab_n0_0_2\n', 'ab', 'n0'), null);
  // A spoof first, then the real one
  assert.equal(A.parseMarker('\nSGDONE_ab_0_0\nSGDONE_ab_n0_7_0\n', 'ab', 'n0').status, 7);
});

test('the launcher traps first, and nothing typed carries a marker in plain text', () => {
  const { launcher, cmd } = A.scripts('id', '/sgjob/id', "echo 'it''s' $HOME");
  assert.deepEqual(launcher.split('\n').slice(0, 2), ['k=0', "trap 'k=1' INT TERM HUP"]);
  assert.match(launcher, /setsid sh \.sg\/cmd <\/dev\/null 2>&1 &/);
  assert.match(launcher, /printf '\\nSGDONE_%s_%s_%s_%s\\n' id "\$n"/);
  assert.ok(!launcher.includes('export n'));
  assert.ok(cmd.endsWith("echo 'it''s' $HOME\n"));
  const lines = A.uploadLines('/sgjob/id', launcher, cmd, 'ack');
  for (const line of lines) {
    assert.ok(line.length < 1000, `a typed line is short: ${line.length}`);
    assert.ok(!/SGDONE|SGOUT|SGNONCE/.test(line), line);
    assert.ok(line.endsWith('_$((6*7))\n'));
  }
  // The lines put the two scripts back together
  const b64 = { 'job.b64': '', 'cmd.b64': '' };
  for (const line of lines) {
    const m = /^printf %s (\S+) >>\/sgjob\/id\/\.sg\/(\S+);/.exec(line);
    if (m) b64[m[2]] += m[1];
  }
  assert.equal(Buffer.from(b64['job.b64'], 'base64').toString(), launcher);
  assert.equal(Buffer.from(b64['cmd.b64'], 'base64').toString(), cmd);
});

test('timeouts are seconds, bounded', () => {
  assert.equal(A.timeoutSeconds(undefined), 300);
  assert.equal(A.timeoutSeconds(2), 2);
  assert.equal(A.timeoutSeconds(1e9), 3600);
  for (const bad of [-1, NaN, Infinity, '2']) assert.throws(() => A.timeoutSeconds(bad));
});

// A guest's serial shell, played: it answers the sync and each upload line, prints the launcher's
// lines, and the marker when told to.
function guest(job, now = 0) {
  const g = { typed: [], now };
  g.type = (lines) => { g.typed.push(...lines); return lines; };
  g.feed = (text) => g.type(job.feed(text, g.now));
  g.tick = (t) => { g.now = t; return g.type(job.tick(t)); };
  g.last = () => g.typed[g.typed.length - 1];
  // Answer what was last typed, as the shell would, until the launcher asks for its nonce
  g.launch = () => {
    g.type([job.start()]);
    for (;;) {
      const line = g.last();
      let m;
      if ((m = /^echo SGSYNC_(\w+)_\$\(\(6\*7\)\)\n$/.exec(line))) g.feed(`${line.trim()}\r\nSGSYNC_${m[1]}_42\r\n# `);
      else if ((m = /; echo SGACK_(\w+)_(\d+)_\$\?_\$\(\(6\*7\)\)\n$/.exec(line))) g.feed(`${line.trim()}\r\nSGACK_${m[1]}_${m[2]}_0_42\r\n# `);
      else if (line.startsWith('sh /sgjob/')) { g.feed(`${line.trim()}\r\n\nSGNONCE_${job.id}\n`); break; }
      else throw new Error(`unexpected: ${line}`);
    }
    const nonce = g.last();
    assert.match(nonce, new RegExp(`^${job.nonce} \\d+\\n$`));
    g.feed(`SGOUT_${job.id}_${job.nonce}\n`);
  };
  g.done = (status, killed) => g.feed(`\nSGDONE_${job.id}_${job.nonce}_${status}_${killed ? 1 : 0}\n`);
  return g;
}
const newJob = (o = {}) => new A.Job({ id: 'aaaaaaaaaaaaaaaa', nonce: 'bbbbbbbbbbbbbbbb', ack: 'cccccccccccccccc',
  command: 'uname -a; echo hi; exit 3', timeoutS: 30, now: 0, clock: () => 1700000000, ...o });

test('a job that ends brings back its output and status, the output as printed', () => {
  const job = newJob();
  const g = guest(job);
  g.launch();
  assert.equal(job.phase, 'running');
  g.feed('Linux snowglobe 6.12 aarch64\nh');
  // So far: a partial line that isn't a marker is shown
  assert.equal(job.view().output, 'Linux snowglobe 6.12 aarch64\nh');
  g.feed('i\n\nSGDONE_aaaaaaaaaaaaaaaa_bb');
  // A marker on its way is held back
  assert.equal(job.view().output, 'Linux snowglobe 6.12 aarch64\nhi\n');
  g.feed('bbbbbbbbbbbbbb_3_0\n# ');
  const v = job.view();
  assert.equal(v.state, 'exited');
  assert.equal(v.exitStatus, 3);
  assert.equal(v.output, 'Linux snowglobe 6.12 aarch64\nhi\n');
  assert.equal(A.jobText(v), 'Linux snowglobe 6.12 aarch64\nhi\n[exit 3]');
  // Nothing more to type once done
  assert.deepEqual(job.feed('more', 1), []);
});

test("a marker the job prints itself doesn't end it", () => {
  const job = newJob();
  const g = guest(job);
  g.launch();
  g.feed('\nSGDONE_aaaaaaaaaaaaaaaa_0_0\nSGDONE_aaaaaaaaaaaaaaaa_0000000000000000_0_0\n');
  assert.equal(job.state, 'running');
  g.done(7, false);
  assert.equal(job.state, 'exited');
  assert.equal(job.exitStatus, 7);
});

test('out of time: ctrl-c, and the launcher says it killed everything', () => {
  const job = newJob({ timeoutS: 2 });
  const g = guest(job);
  g.launch();
  g.feed('started\n');
  assert.deepEqual(g.tick(1000), []);
  assert.deepEqual(g.tick(2000), ['\x03']);
  assert.equal(job.phase, 'killing');
  g.done(143, true);
  const v = job.view();
  assert.equal(v.state, 'timed_out');
  assert.equal(v.exitStatus, null);
  assert.ok(v.killed);
  assert.equal(A.jobText(v), 'started\n\n[timed out; everything it started was killed]');
});

test('a job that ends just as its time is up counts as ended', () => {
  const job = newJob({ timeoutS: 1 });
  const g = guest(job);
  g.launch();
  g.tick(1000);
  g.done(0, false);
  assert.equal(job.state, 'exited');
  assert.equal(job.exitStatus, 0);
});

test('cancel: ctrl-c, then [stopped]', () => {
  const job = newJob();
  const g = guest(job);
  g.launch();
  assert.deepEqual(job.stop('cancel', 10), ['\x03']);
  assert.deepEqual(job.stop('cancel', 11), [], 'once');
  g.done(130, true);
  assert.equal(job.state, 'cancelled');
  assert.match(A.jobText(job.view()), /\[stopped; everything it started was killed\]$/);
});

test('cancelled before it was typed in: nothing runs', () => {
  const job = newJob();
  assert.deepEqual(job.stop('cancel', 0), []);
  assert.equal(job.state, 'cancelled');
});

test('no marker after the kill: the shell is asked to answer, and is marked busy if it does not', () => {
  const job = newJob({ timeoutS: 1 });
  const g = guest(job);
  g.launch();
  g.tick(1000);
  const [sync] = g.tick(1000 + A.limits.KILL_GRACE_MS);
  assert.match(sync, /^echo SGSYNC_/);
  assert.equal(job.phase, 'check');
  g.tick(1000 + A.limits.KILL_GRACE_MS + A.limits.SYNC_WAIT_MS);
  assert.equal(job.state, 'timed_out');
  assert.ok(job.shellBusy);
});

test('a shell that never answers fails the job before anything is typed into it', () => {
  const job = newJob();
  assert.match(job.start(), /^echo SGSYNC_/);
  job.tick(A.limits.SYNC_WAIT_MS);
  assert.equal(job.state, 'failed');
  assert.equal(job.error, "the guest's shell is not answering");
});

test('output beyond the limit keeps the most recent, and says so', () => {
  const job = newJob({ maxOutput: 100 });
  const g = guest(job);
  g.launch();
  for (let i = 0; i < 100; i++) g.feed(`line ${String(i).padStart(4, '0')}\n`);
  g.done(0, false);
  const v = job.view();
  assert.equal(v.state, 'exited');
  assert.ok(v.truncated);
  assert.ok(v.output.endsWith('line 0099\n'));
  assert.equal(v.output.length + v.droppedChars, 100 * 10, 'every character kept or counted');
  assert.match(A.jobText(v), /^\[\d+ earlier characters of output dropped\]\n/);
});

// The controller over a fake emulator, whose serial line is played by the test
function machine(o = {}) {
  const listeners = {};
  const typed = [];
  const emulator = {
    on: (name, fn) => { (listeners[name] ??= []).push(fn); },
    serial_input: (s) => typed.push(s),
    print: (text) => listeners.serial?.forEach((fn) => fn(new TextEncoder().encode(text))),
  };
  let state = 'ready';
  const timers = { setInterval: () => 1, clearInterval: () => {} };
  const c = new A.Controller({ emulator, cpus: 1, network: 'none', buildId: 'b', version: 'v0', state: () => state, saving: () => false, ...o },
    { timers, now: () => 0 });
  return { c, emulator, typed, setState: (s) => { state = s; } };
}

test('one job at a time; a repeated requestId returns the same job', () => {
  const { c } = machine();
  const { jobId } = c.runCommand({ command: 'sleep 1', requestId: 'r1' });
  assert.match(jobId, /^[0-9a-f]{16}$/);
  assert.deepEqual(c.runCommand({ command: 'sleep 1', requestId: 'r1' }), { jobId, repeated: true });
  assert.throws(() => c.runCommand({ command: 'other', requestId: 'r1' }), /different command/);
  assert.throws(() => c.runCommand({ command: 'echo 2' }), /busy: job [0-9a-f]+ is running/);
  assert.equal(c.status().state, 'busy');
  c.cancelJob(jobId);
  assert.equal(c.readJob(jobId).state, 'cancelled');
  assert.equal(c.status().state, 'ready');
});

test('the controller types the protocol into the serial line and reads the result', () => {
  const { c, emulator, typed } = machine();
  const { jobId } = c.runCommand({ command: 'echo hi; exit 3' });
  const job = c._controller ?? c.jobs.get(jobId);
  for (;;) {
    const line = typed[typed.length - 1];
    let m;
    if ((m = /^echo SGSYNC_(\w+)_/.exec(line))) emulator.print(`SGSYNC_${m[1]}_42\r\n`);
    else if ((m = /echo SGACK_(\w+)_(\d+)_/.exec(line))) emulator.print(`SGACK_${m[1]}_${m[2]}_0_42\r\n`);
    else if (line.startsWith('sh /sgjob/')) { emulator.print(`\nSGNONCE_${jobId}\n`); break; }
  }
  emulator.print(`SGOUT_${jobId}_${job.nonce}\nhi\n\nSGDONE_${jobId}_${job.nonce}_3_0\n`);
  const v = c.readJob({ jobId });
  assert.equal(v.state, 'exited');
  assert.equal(v.exitStatus, 3);
  assert.equal(v.output, 'hi\n');
  assert.equal(c.status().state, 'ready');
});

test('commands are refused until the machine is ready, and on several CPUs where the page is not isolated', () => {
  const m = machine();
  m.setState('loading');
  assert.equal(m.c.status().state, 'booting');
  assert.throws(() => m.c.runCommand({ command: 'true' }), /not ready: the machine is booting/);
  const smp = machine({ cpus: 2, isolated: false });
  assert.equal(smp.c.status().state, 'failed');
  assert.match(smp.c.status().reason, /2 CPUs need a cross-origin isolated page/);
  assert.equal(smp.c.capabilities().supported, false);
  assert.throws(() => smp.c.runCommand({ command: 'true' }), /cross-origin isolated/);
  // Isolated (the agent page, a several-CPU site's own page): jobs run there as on one CPU
  const iso = machine({ cpus: 2, isolated: true });
  assert.equal(iso.c.status().state, 'ready');
  assert.equal(iso.c.capabilities().supported, true);
  assert.equal(iso.c.capabilities().cpus, 2);
  iso.c.runCommand({ command: 'nproc' });
  assert.match(iso.typed[0], /^echo SGSYNC_/);
  // Not said: crossOriginIsolated decides (false in node)
  assert.equal(machine({ cpus: 2 }).c.supported(), globalThis.crossOriginIsolated === true);
  for (const bad of [undefined, {}, { command: '' }, { command: 'x', timeoutSeconds: -1 }, { command: 'x', requestId: 'a b' }]) {
    assert.throws(() => m.c.runCommand(bad));
  }
});

// The page's API over one machine, as the agent page has it over several: by runtime
const ALL = ['list_runtimes', 'run_command', 'job_status', 'cancel_job', 'copy_file', 'open_preview', 'close_preview', 'set_awake_limit'];
function pageApi(c, copies = [], calls = []) {
  const rt = (i) => { if (i.runtime !== 'py') throw new Error(`no runtime ${i.runtime}`); };
  let limit = 2;
  return { capabilities: async () => ({ ...c.capabilities(), awake: 1, awakeLimit: limit }), listRuntimes: async () => [{ name: 'py', state: 'awake' }],
    runCommand: async (i, o) => { rt(i); calls.push(['run', o]); return c.runCommand(i); }, readJob: async (i) => c.readJob(i), cancelJob: async (i) => c.cancelJob(i),
    copyFile: async (i, o) => { copies.push(i); calls.push(['copy', o]); return { bytes: 2048, sha256: 'ab'.repeat(32), readSeconds: 1, writeSeconds: 0.5 }; },
    setAwakeLimit: async (n) => { limit = n; return { awakeLimit: n, awake: 1, overLimit: null }; } };
}

test('WebMCP: one tool set registered with the standard API, through one dispatcher, asking once before the first run', async () => {
  const { c } = machine();
  const copies = [];
  const calls = [];
  const api = pageApi(c, copies, calls);
  const registered = [];
  const doc = { modelContext: { registerTool: async (tool, opts) => registered.push({ tool, opts }) } };
  let asked = 0;
  const r = await W.register(api, { jobText: A.jobText, doc, nav: {}, confirm: async () => { asked++; return true; } });
  assert.deepEqual(r.registered, ALL);
  assert.ok(registered.every(({ opts }) => opts.signal instanceof AbortSignal && !('exposedTo' in opts)));
  const tool = (name) => registered.find((t) => t.tool.name === name).tool;

  for (const bad of [{ runtime: 'py', command: 42 }, { command: 'x' }, { runtime: 'py' }]) assert.ok((await tool('run_command').execute(bad)).isError);
  assert.equal(asked, 0, 'invalid input is refused before asking');
  assert.match((await tool('list_runtimes').execute({})).content[0].text, /"name": "py"/);
  assert.match((await tool('list_runtimes').execute({})).content[0].text, /"awake_limit": 2/);
  assert.equal(asked, 0, 'listing asks nothing');
  // The awake limit: an integer 1 to 8, reported back by list_runtimes; it runs nothing, so asks nothing
  for (const bad of [{}, { count: 0 }, { count: 9 }, { count: 2.5 }, { count: '3' }]) assert.ok((await tool('set_awake_limit').execute(bad)).isError);
  assert.match((await tool('set_awake_limit').execute({ count: 3 })).content[0].text, /^up to 3 machines awake at once; 1 awake now$/);
  assert.match((await tool('list_runtimes').execute({})).content[0].text, /"awake_limit": 3/);
  assert.equal(asked, 0, 'setting the limit asks nothing');
  const started = await tool('run_command').execute({ runtime: 'py', command: 'echo hi' }, { signal: new AbortController().signal });
  assert.match(started.content[0].text, /started in py/);
  const id = /job ([0-9a-f]{16})/.exec(started.content[0].text)[1];
  assert.equal(asked, 1);
  assert.match((await tool('job_status').execute({ job_id: id })).content[0].text, /\[running\]$/);
  assert.match((await tool('cancel_job').execute({ job_id: id })).content[0].text, /\[stopped\]$/);
  await tool('run_command').execute({ runtime: 'py', command: 'true' });
  const copied = await tool('copy_file').execute({ from_runtime: 'py', from_path: '/root/a', to_runtime: 'db', to_path: 'b' });
  assert.match(copied.content[0].text, /copied 2048 bytes from py:\/root\/a to db:b; sha256 (ab){32}.*Read 2 KiB\/s, wrote 4 KiB\/s/);
  assert.deepEqual(copies, [{ fromRuntime: 'py', fromPath: '/root/a', toRuntime: 'db', toPath: 'b' }]);
  // The client's cancel signal reaches the copy; runs and copies say they came from WebMCP
  const sig = new AbortController().signal;
  await tool('copy_file').execute({ from_runtime: 'py', from_path: '/a', to_runtime: 'db', to_path: 'b' }, { signal: sig });
  assert.equal(calls.at(-1)[1].signal, sig);
  assert.ok(calls.every(([, o]) => o.source === 'webmcp'));
  assert.ok((await tool('copy_file').execute({ from_runtime: 'py' })).isError);
  assert.equal(asked, 1, 'asked once, for runs and copies alike');
  assert.ok((await tool('job_status').execute({ job_id: 'nope' })).isError);
  // One dispatcher: an unknown tool is an error result, not a throw
  const dispatch = W.dispatcher(W.definitions(api, { jobText: A.jobText, ask: async () => {} }));
  assert.match((await dispatch('rm_rf', {})).content[0].text, /no tool rm_rf/);
});

test('WebMCP: a client with requestUserInteraction is asked through it; a refusal runs nothing', async () => {
  const { c } = machine();
  const api = pageApi(c);
  const registered = [];
  const doc = { modelContext: { registerTool: async (tool) => registered.push(tool) } };
  await W.register(api, { jobText: A.jobText, doc, confirm: async () => false, exposedTo: ['https://agent.example'] });
  let through = 0;
  const client = { requestUserInteraction: async (cb) => { through++; return cb(); } };
  const r = await registered.find((t) => t.name === 'run_command').execute({ runtime: 'py', command: 'true' }, client);
  assert.equal(through, 1);
  assert.ok(r.isError);
  assert.match(r.content[0].text, /did not allow/);
  assert.equal(c.status().state, 'ready');
});

test('WebMCP: nothing registered without a model context, or on several CPUs', async () => {
  const none = await W.register({ capabilities: async () => ({ supported: true }) }, { doc: {}, nav: {} });
  assert.equal(none.available, false);
  assert.deepEqual(none.registered, []);
  const smp = machine({ cpus: 2, isolated: false });
  const doc = { modelContext: { registerTool: async () => assert.fail('registered') } };
  const r = await W.register({ capabilities: async () => smp.c.capabilities() }, { doc });
  assert.deepEqual(r.registered, []);
  assert.match(r.reason, /cross-origin isolated/);
  // navigator.modelContext, as earlier drafts had it
  const seen = [];
  await W.register({ capabilities: async () => ({ supported: true }) }, { doc: {}, nav: { modelContext: { registerTool: async (t) => seen.push(t.name) } } });
  assert.deepEqual(seen, ALL);
});

// Timers the test steps by hand
function manualTimers() {
  let next = 1;
  const pending = new Map();
  return {
    pending,
    setTimeout: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimeout: (id) => pending.delete(id),
    setInterval: () => next++,
    clearInterval: () => {},
    // Run what is due now (each timer once), and let the promises it started settle
    step: async () => {
      const due = [...pending];
      pending.clear();
      for (const [, fn] of due) fn();
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    },
  };
}
const ok = { capabilities: async () => ({ supported: true }) };

test('WebMCP: the first drafts\' provideContext({tools}) gets them all, and unregister clears them', async () => {
  const given = [];
  let cleared = 0;
  const nav = { modelContext: { provideContext: async (ctx) => given.push(...ctx.tools), clearContext: () => { cleared++; } } };
  const r = await W.register(ok, { jobText: A.jobText, doc: {}, nav, exposedTo: ['https://agent.example'] });
  assert.equal(r.api, 'provideContext');
  assert.deepEqual(r.registered, ALL);
  assert.deepEqual(given.map((t) => t.name), r.registered);
  assert.ok(given.every((t) => typeof t.execute === 'function' && t.inputSchema.type === 'object'));
  assert.deepEqual(r.exposedTo, [], 'no per-origin sharing in that shape');
  r.unregister();
  assert.equal(cleared, 1);
  // registerTool wins where both are there
  const both = { modelContext: { registerTool: async () => {}, provideContext: async () => assert.fail('provideContext') } };
  assert.equal((await W.register(ok, { jobText: A.jobText, doc: both })).api, 'registerTool');
});

test('WebMCP: a model context added after the page starts is still found', async () => {
  const timers = manualTimers();
  const doc = {};
  let settled = null;
  W.register(ok, { jobText: A.jobText, doc, nav: {}, waitMs: 15000, pollMs: 500, timers }).then((r) => { settled = r; });
  for (let i = 0; i < 6; i++) await timers.step(); // 3 s
  assert.equal(settled, null, 'still looking');
  const seen = [];
  doc.modelContext = { registerTool: async (t) => seen.push(t.name) };
  await timers.step();
  assert.deepEqual(settled?.registered, ALL);
  assert.deepEqual(seen, settled.registered);
  assert.equal(timers.pending.size, 0, 'stops looking once found');
});

test('WebMCP: with none by the deadline it gives up, says so, and leaves no timer', async () => {
  const timers = manualTimers();
  let settled = null;
  W.register(ok, { jobText: A.jobText, doc: {}, nav: {}, waitMs: 2000, pollMs: 500, timers }).then((r) => { settled = r; });
  for (let i = 0; i < 3; i++) await timers.step();
  assert.equal(settled, null);
  await timers.step();
  assert.equal(settled.available, false);
  assert.deepEqual(settled.registered, []);
  assert.match(settled.reason, /no WebMCP .*looked for 2 s/);
  assert.equal(timers.pending.size, 0);
  // A context object without a way to add tools doesn't count
  assert.equal(W.findContext({ modelContext: {} }, {}), null);
});

test('WebMCP: a browser that refuses exposedTo still gets the tools, for this origin', async () => {
  const calls = [];
  const doc = { modelContext: { registerTool: async (t, o) => { calls.push(o); if (o.exposedTo) throw new TypeError('exposedTo'); } } };
  const r = await W.register(ok, { jobText: A.jobText, doc, exposedTo: ['https://agent.example'] });
  assert.deepEqual(r.registered, ALL);
  assert.deepEqual(r.exposedTo, []);
  assert.match(r.reason, /exposedTo was refused/);
  assert.equal(calls.filter((o) => o.exposedTo).length, 1, 'tried with it once');
});

// The panel's elements, as plain objects
function panelEls() {
  const el = (o = {}) => {
    const handlers = {};
    return { value: '', disabled: false, textContent: '', focused: 0, ...o,
      addEventListener: (n, fn) => { (handlers[n] ??= []).push(fn); },
      fire: (n, e = {}) => handlers[n]?.forEach((fn) => fn({ preventDefault() {}, ...e })),
      focus() { this.focused++; } };
  };
  return { form: el(), command: el(), run: el(), cancel: el(), status: el(), result: el(), output: el() };
}
const P = require('./agent-panel.js');
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
// Plays the guest for the controller's current job: it answers, then prints `out` and ends with `status`
function playJob(c, emulator, typed, out, status) {
  const job = c.current;
  for (;;) {
    const line = typed[typed.length - 1];
    let m;
    if ((m = /^echo SGSYNC_(\w+)_/.exec(line))) emulator.print(`SGSYNC_${m[1]}_42\r\n`);
    else if ((m = /echo SGACK_(\w+)_(\d+)_/.exec(line))) emulator.print(`SGACK_${m[1]}_${m[2]}_0_42\r\n`);
    else if (line.startsWith('sh /sgjob/')) { emulator.print(`\nSGNONCE_${job.id}\n`); break; }
  }
  emulator.print(`SGOUT_${job.id}_${job.nonce}\n${out}`);
  if (status !== undefined) emulator.print(`\nSGDONE_${job.id}_${job.nonce}_${status}_0\n`);
  return job;
}

test('panel: the status line follows the machine, and Run is only offered when it can run', async () => {
  const m = machine();
  const agent = { status: async () => m.c.status() };
  const els = panelEls();
  m.setState('loading');
  const p = new P.Panel(agent, els, { ask: async () => {}, jobText: A.jobText, timers: manualTimers() });
  await settle();
  assert.equal(els.status.textContent, 'The machine is starting. Run is available once it is running.');
  assert.ok(els.run.disabled);
  assert.ok(els.cancel.disabled);
  m.setState('ready');
  await p.refresh();
  assert.equal(els.status.textContent, 'Ready.');
  assert.equal(els.run.disabled, false);
});

test('panel: Run asks once, runs on the job runner, and shows the output with its exit status', async () => {
  const { c, emulator, typed } = machine();
  // The same controller the tools use
  const agent = { status: async () => c.status(), runCommand: async (i) => c.runCommand(i),
    readJob: async (i) => c.readJob(i), cancelJob: async (i) => c.cancelJob(i) };
  let asked = 0;
  const ask = W.consent({ confirm: async () => { asked++; return true; } });
  const timers = manualTimers();
  const els = panelEls();
  new P.Panel(agent, els, { ask, jobText: A.jobText, timers });
  await settle();

  // Nothing typed: nothing runs, and nobody is asked
  els.form.fire('submit');
  await settle();
  assert.equal(els.status.textContent, 'Type a command first, then press Run.');
  assert.equal(asked, 0);
  assert.equal(els.command.focused, 1);

  els.command.value = 'echo hi; exit 3';
  els.form.fire('submit');
  await settle();
  assert.equal(asked, 1);
  assert.match(els.status.textContent, /^Running job [0-9a-f]{16}…$/);
  assert.ok(els.run.disabled);
  assert.equal(els.cancel.disabled, false);
  playJob(c, emulator, typed, 'hi\n', 3);
  await timers.step();
  assert.equal(els.output.textContent, 'hi\n[exit 3]');
  assert.equal(els.result.textContent, 'Exit status: 3');
  assert.equal(els.status.textContent, 'Finished. Exit status: 3. Ready for the next command.');
  await timers.step();
  assert.equal(els.status.textContent, 'Finished. Exit status: 3. Ready for the next command.', 'kept until the next run');
  assert.equal(els.run.disabled, false);
  assert.ok(els.cancel.disabled);

  // ctrl+Enter runs too; a second run isn't asked about again, and the WebMCP tools share the answer
  els.command.value = 'true';
  els.command.fire('keydown', { key: 'Enter', ctrlKey: true });
  await settle();
  assert.equal(asked, 1);
  playJob(c, emulator, typed, '', 0);
  await timers.step();
  assert.equal(els.result.textContent, 'Exit status: 0');
  const registered = [];
  await W.register({ ...agent, capabilities: async () => c.capabilities() },
    { jobText: A.jobText, doc: { modelContext: { registerTool: async (t) => registered.push(t) } }, ask });
  await registered[0].execute({ command: 'true' });
  assert.equal(asked, 1, 'one question per page load');
});

test('panel: Cancel stops the job and says so; a refusal runs nothing', async () => {
  const { c, emulator, typed } = machine();
  const agent = { status: async () => c.status(), runCommand: async (i) => c.runCommand(i),
    readJob: async (i) => c.readJob(i), cancelJob: async (i) => c.cancelJob(i) };
  const timers = manualTimers();
  const els = panelEls();
  new P.Panel(agent, els, { ask: async () => {}, jobText: A.jobText, timers });
  await settle();
  els.command.value = 'sleep 100';
  els.form.fire('submit');
  await settle();
  const job = playJob(c, emulator, typed, 'started\n');
  await timers.step();
  assert.equal(els.output.textContent, 'started\n', 'output as it arrives');
  els.cancel.fire('click');
  await settle();
  assert.equal(typed[typed.length - 1], '\x03');
  assert.match(els.status.textContent, /^Cancelling job/);
  emulator.print(`\nSGDONE_${job.id}_${job.nonce}_130_1\n`);
  await timers.step();
  assert.equal(els.result.textContent, 'Cancelled');
  assert.match(els.output.textContent, /\[stopped; everything it started was killed\]$/);

  const denied = panelEls();
  const deniedPanel = new P.Panel(agent, denied, { ask: W.consent({ confirm: async () => false }), jobText: A.jobText, timers: manualTimers() });
  await settle();
  denied.command.value = 'true';
  denied.form.fire('submit');
  await settle();
  assert.equal(denied.status.textContent, 'Not run: the person at the page did not allow it.');
  await deniedPanel.refresh();
  assert.equal(denied.status.textContent, 'Not run: the person at the page did not allow it. Ready for the next command.', 'kept');
  assert.equal(denied.run.disabled, false);
  assert.equal(c.status().state, 'ready');
});

test('escape sequences are stripped: colours, cursor movement, titles and hyperlinks', () => {
  const E = '\x1b';
  // printf '\033[31mred\033[0m\n'
  assert.equal(A.plain(`${E}[31mred${E}[0m\n`), 'red\n');
  // ls --color=always: bold, 256 and true colour, with the reset forms ls uses
  assert.equal(A.plain(`${E}[0m${E}[01;34mbin${E}[0m  ${E}[38;5;208metc${E}[0m  ${E}[38;2;1;2;3mroot${E}[m\n`), 'bin  etc  root\n');
  // Cursor movement and erasing, private modes (a cursor hidden and shown), keypad mode
  assert.equal(A.plain(`${E}[?25l${E}[2K${E}[1Gdone${E}[?25h${E}=${E}>\n`), 'done\n');
  // OSC: a title (ended by BEL) and a hyperlink (ended by ST)
  assert.equal(A.plain(`${E}]0;my title\x07${E}]8;;https://x.example/${E}\\link${E}]8;;${E}\\\n`), 'link\n');
  // A charset designation, as box-drawing programs send; DCS strings
  assert.equal(A.plain(`${E}(0lqk${E}(B ${E}P1$r0m${E}\\ok`), 'lqk ok');
  // Box drawing is text, and stays: duckdb -c 'select 42 as x'
  const box = '┌───────┐\n│   x   │\n│ int32 │\n├───────┤\n│    42 │\n└───────┘\n';
  assert.equal(A.plain(box), box);
  assert.equal(A.plain(`${E}[1m${box}${E}[0m`), box);
  // Plain text, tabs, carriage returns and Unicode untouched
  assert.equal(A.plain('a\tb\r\nc é 字\n'), 'a\tb\r\nc é 字\n');
  // 8-bit CSI, as a C1 character
  assert.equal(A.plain('\u009b31mred\u009b0m'), 'red');
  // One cut short at the end of the output so far is held back, not shown half-made
  assert.equal(A.plain(`ok${E}[3`), 'ok');
  assert.equal(A.plain(`ok${E}`), 'ok');
  assert.equal(A.plain(`ok${E}]0;tit`), 'ok');
  // An OSC never ended doesn't take the lines after it with it
  assert.equal(A.plain(`${E}]0;title\nnext line\n`), '\nnext line\n');
});

test('a job reads back without escape sequences; its environment asks for none', () => {
  const { cmd } = A.scripts('id', '/sgjob/id', 'ls --color=always /');
  assert.ok(cmd.includes('export NO_COLOR=1 TERM=dumb\n'));
  // After the image's ENV, which may set TERM
  assert.ok(cmd.indexOf('NO_COLOR') > cmd.indexOf('/etc/snowglobe/env'));
  const job = newJob({ command: "printf '\\033[31mred\\033[0m\\n'" });
  const g = guest(job);
  g.launch();
  g.feed('\x1b[31mred\x1b[0m\n\x1b[01;34mbin\x1b[0m\x1b[3');
  assert.equal(job.view().output, 'red\nbin', 'running: half a sequence held back');
  g.feed('2m\n');
  g.done(0, false);
  const v = job.view();
  assert.equal(v.output, 'red\nbin\n');
  assert.equal(A.jobText(v), 'red\nbin\n[exit 0]');
});

test('a job\'s files go into its in/, typed as base64 and decoded by the guest', () => {
  const bytes = Uint8Array.from({ length: 1000 }, (_, i) => i % 256);
  const lines = A.uploadLines('/sgjob/x', 'L', 'C', 'k', { c: bytes });
  assert.match(lines[0], /^mkdir -p \/sgjob\/x\/\.sg \/sgjob\/x\/in \/sgjob\/x\/out && .* && : >\/sgjob\/x\/in\/c\.b64;/);
  const typed = lines.filter((l) => l.includes('>>/sgjob/x/in/c.b64')).map((l) => /^printf %s (\S+) >>/.exec(l)[1]).join('');
  assert.deepEqual(Buffer.from(typed, 'base64'), Buffer.from(bytes));
  assert.match(lines.at(-1), /base64 -d \/sgjob\/x\/in\/c\.b64 >\/sgjob\/x\/in\/c && rm \/sgjob\/x\/in\/c\.b64; echo SGACK_k_\d+_/);
  assert.ok(lines.every((l) => l.length < 1024), 'every line under the line editor\'s limit');
  assert.throws(() => A.checkFiles({ '../x': bytes }), /not a plain file name/);
  assert.throws(() => A.checkFiles({ c: 'text' }), /not a Uint8Array/);
  assert.throws(() => A.checkFiles({ c: new Uint8Array(A.limits.MAX_FILES_BYTES + 1) }), /at most/);
});

test('upload lines typed ahead: a window of them in flight, acknowledgements taken in order, several at once', () => {
  const job = new A.Job({ id: 'i', nonce: 'n', ack: 'k', command: 'echo hi', timeoutS: 10, now: 0, window: 3,
    files: { c: new Uint8Array(3000) } });
  const total = job.lines.length;
  assert.ok(total > 6);
  job.feed(`SGSYNC_${job.syncTok}_42\n`, 1);
  assert.equal(job.sent, 3);
  // Two acknowledgements in one read: two more lines go
  const more = job.feed('SGACK_k_0_0_42\nSGACK_k_1_0_42\n', 2);
  assert.deepEqual(more, [job.lines[3], job.lines[4]]);
  let typed = [];
  for (let i = 2; i < total; i++) typed = job.feed(`SGACK_k_${i}_0_42\n`, 3);
  assert.deepEqual(typed, ['sh /sgjob/i/.sg/job.sh\n']);
  assert.equal(job.phase, 'launch');
  // A failed line fails the job
  const bad = new A.Job({ id: 'j', nonce: 'n', ack: 'k', command: 'x', timeoutS: 10, now: 0, window: 4 });
  bad.feed(`SGSYNC_${bad.syncTok}_42\n`, 1);
  bad.feed('SGACK_k_0_1_42\n', 2);
  assert.equal(bad.state, 'failed');
});

test('WebMCP: open_preview asks first, opens the page\'s preview and says what its first request got; close_preview closes it', async () => {
  const calls = [];
  let asked = 0;
  const agent = {
    openPreview: async (input, o) => { calls.push(['open', input, o]); return { url: 'https://x/snowglobe/agent/preview/web/4173/', base: 'https://x/snowglobe/agent/preview/web/4173/', status: 200, statusText: 'OK' }; },
    closePreview: async (o) => { calls.push(['close', o]); return true; },
  };
  const dispatch = W.dispatcher(W.definitions(agent, { jobText: A.jobText, ask: async () => { asked++; } }));
  const r = await dispatch('open_preview', { runtime: 'web', port: 4173 });
  assert.equal(asked, 1);
  assert.deepEqual(calls[0].slice(0, 2), ['open', { runtime: 'web', port: 4173, path: undefined }]);
  assert.equal(calls[0][2].source, 'webmcp');
  assert.match(r.content[0].text, /shows https:\/\/x\/snowglobe\/agent\/preview\/web\/4173\/ \(web's port 4173\); it answered 200 OK/);
  assert.match(r.content[0].text, /preview\/<runtime>\/<port>\//);
  assert.ok(!r.isError);
  assert.ok((await dispatch('open_preview', { runtime: 'web', port: 'x' })).isError);
  assert.ok((await dispatch('open_preview', { runtime: 'web', port: 80, path: 'x' })).isError);
  assert.equal(calls.length, 1, 'bad input opens nothing');
  agent.openPreview = async () => ({ url: 'u', base: 'https://x/a/preview/web/1/', error: 'Nothing is listening: start a server' });
  const failed = await dispatch('open_preview', { runtime: 'web', port: 1 });
  assert.ok(failed.isError);
  assert.match(failed.content[0].text, /its first request failed: Nothing is listening/);
  assert.match((await dispatch('close_preview', {})).content[0].text, /closed/);
  // The one question mentions previews
  assert.match(W.ASK_MESSAGE, /preview/);
});

test('consent: granted() says whether the person allowed it, without asking', async () => {
  let shown = 0;
  const ask = W.consent({ confirm: async () => { shown++; return true; } });
  assert.equal(ask.granted(), false);
  assert.equal(shown, 0);
  await ask();
  assert.equal(ask.granted(), true);
  await ask();
  assert.equal(shown, 1);
});
