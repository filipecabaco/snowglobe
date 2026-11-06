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

test('commands are refused until the machine is ready, and on several CPUs', () => {
  const m = machine();
  m.setState('loading');
  assert.equal(m.c.status().state, 'booting');
  assert.throws(() => m.c.runCommand({ command: 'true' }), /not ready: the machine is booting/);
  const smp = machine({ cpus: 2 });
  assert.equal(smp.c.status().state, 'failed');
  assert.match(smp.c.status().reason, /one-CPU/);
  assert.equal(smp.c.capabilities().supported, false);
  assert.throws(() => smp.c.runCommand({ command: 'true' }), /one-CPU/);
  for (const bad of [undefined, {}, { command: '' }, { command: 'x', timeoutSeconds: -1 }, { command: 'x', requestId: 'a b' }]) {
    assert.throws(() => m.c.runCommand(bad));
  }
});

test('WebMCP: three tools registered with the standard API, asking once before the first run', async () => {
  const { c } = machine();
  const api = { capabilities: async () => c.capabilities(), runCommand: async (i) => c.runCommand(i),
    readJob: async (i) => c.readJob(i), cancelJob: async (i) => c.cancelJob(i) };
  const registered = [];
  const doc = { modelContext: { registerTool: async (tool, opts) => registered.push({ tool, opts }) } };
  let asked = 0;
  const r = await W.register(api, { jobText: A.jobText, doc, nav: {}, confirm: async () => { asked++; return true; } });
  assert.deepEqual(r.registered, ['run_command', 'job_status', 'cancel_job']);
  assert.ok(registered.every(({ opts }) => opts.signal instanceof AbortSignal && !('exposedTo' in opts)));
  const tool = (name) => registered.find((t) => t.tool.name === name).tool;

  const bad = await tool('run_command').execute({ command: 42 });
  assert.ok(bad.isError);
  assert.equal(asked, 0, 'invalid input is refused before asking');
  const started = await tool('run_command').execute({ command: 'echo hi' }, { signal: new AbortController().signal });
  const id = /job ([0-9a-f]{16})/.exec(started.content[0].text)[1];
  assert.equal(asked, 1);
  assert.match((await tool('job_status').execute({ job_id: id })).content[0].text, /\[running\]$/);
  assert.match((await tool('cancel_job').execute({ job_id: id })).content[0].text, /\[stopped\]$/);
  await tool('run_command').execute({ command: 'true' });
  assert.equal(asked, 1, 'asked once');
  assert.ok((await tool('job_status').execute({ job_id: 'nope' })).isError);
});

test('WebMCP: a client with requestUserInteraction is asked through it; a refusal runs nothing', async () => {
  const { c } = machine();
  const api = { capabilities: async () => c.capabilities(), runCommand: async (i) => c.runCommand(i) };
  const registered = [];
  const doc = { modelContext: { registerTool: async (tool) => registered.push(tool) } };
  await W.register(api, { jobText: A.jobText, doc, confirm: async () => false, exposedTo: ['https://agent.example'] });
  let through = 0;
  const client = { requestUserInteraction: async (cb) => { through++; return cb(); } };
  const r = await registered[0].execute({ command: 'true' }, client);
  assert.equal(through, 1);
  assert.ok(r.isError);
  assert.match(r.content[0].text, /did not allow/);
  assert.equal(c.status().state, 'ready');
});

test('WebMCP: nothing registered without a model context, or on several CPUs', async () => {
  const none = await W.register({ capabilities: async () => ({ supported: true }) }, { doc: {}, nav: {} });
  assert.equal(none.available, false);
  assert.deepEqual(none.registered, []);
  const smp = machine({ cpus: 2 });
  const doc = { modelContext: { registerTool: async () => assert.fail('registered') } };
  const r = await W.register({ capabilities: async () => smp.c.capabilities() }, { doc });
  assert.deepEqual(r.registered, []);
  assert.match(r.reason, /one-CPU/);
  // navigator.modelContext, as earlier drafts had it
  const seen = [];
  await W.register({ capabilities: async () => ({ supported: true }) }, { doc: {}, nav: { modelContext: { registerTool: async (t) => seen.push(t.name) } } });
  assert.deepEqual(seen, ['run_command', 'job_status', 'cancel_job']);
});
