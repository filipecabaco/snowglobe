// The fleet page's TOML, plan and run (fleet.js), over a stand-in orchestrator
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./fleet.js');

// A page on one machine fetching an API on another, over a link (a template of the page's)
const live = fs.readFileSync(path.join(__dirname, '../../examples/fleet/templates/api-and-client.toml'), 'utf8');
// The repository's example fleet: the same live data in one machine, its page the viewer
const repoExample = fs.readFileSync(path.join(__dirname, '../../examples/fleet/snowglobe.toml'), 'utf8');
// A smaller one, without a link: a snapshot, a service on it, and a machine, all of one site
const example = `name = "python-demo"
[templates.py]
build = "../python"
network = "fetch"
idle = "30m"
[snapshots.serving]
template = "py"
run = ["mkdir -p /srv && echo 'hello from a snowglobe fleet' > /srv/index.html",
       "cd /srv && python3 -m http.server 8000 >/dev/null 2>&1 &"]
ready = "wget -q -O /dev/null http://127.0.0.1:8000/"
timeout = "2m"
[templates.serving]
snapshot = "serving"
[services.web]
template = "serving"
ports = ["8080:8000"]
min = 0
max = 3
idle = "5m"
concurrency = 10
[machines.scratch]
template = "py"
ttl = "24h"
`;
const runtimes = [
  { name: 'python', network: 'fetch' },
  { name: 'web', network: 'fetch' },
  { name: 'supabase', network: 'fetch' },
  { name: 'duckdb', network: 'none' },
  { name: 'bun', network: 'fetch' },
];

test('parse: the example fleet file', () => {
  const f = F.parse(example);
  assert.equal(f.name, 'python-demo');
  assert.deepEqual({ ...f.templates.py }, { build: '../python', network: 'fetch', idle: '30m' });
  assert.equal(f.snapshots.serving.run.length, 2);
  assert.equal(f.snapshots.serving.ready, 'wget -q -O /dev/null http://127.0.0.1:8000/');
  assert.deepEqual({ ...f.services.web }, { template: 'serving', ports: ['8080:8000'], min: 0, max: 3, idle: '5m', concurrency: 10 });
  assert.equal(f.machines.scratch.ttl, '24h');
});

test('parse: values, comments, dotted keys and arrays across lines', () => {
  const f = F.parse(`
a = 1_000   # a number
b = -2
c = true
d = 'lit # eral'
e = "q\\"uote\\n\\u00e9"
[t.u]
f = [
  "x", # one
  "y",
]
g.h = 1.5
`);
  assert.equal(f.a, 1000);
  assert.equal(f.b, -2);
  assert.equal(f.c, true);
  assert.equal(f.d, 'lit # eral');
  assert.equal(f.e, 'q"uote\né');
  assert.deepEqual(f.t.u.f, ['x', 'y']);
  assert.equal(f.t.u.g.h, 1.5);
});

test('parse: what it refuses says the line', () => {
  const cases = [
    ['a = 1\na = 2', /line 2: a is set twice/],
    ['[a]\n[a]', /line 2: .*twice/],
    ['a = "x', /line 1: a string that doesn't end/],
    ['a = ', /line 1: a value is missing/],
    ['a = 1 2', /line 1: unexpected/],
    ['a = [1, "x"]', /one kind/],
    ['a = [1,', /array that doesn't end/],
    ['a = {b = 1}', /inline tables/],
    ['[[a]]', /arrays of tables/],
    ['a = """x', /doesn't end/],
    ["a = '''x\ny", /doesn't end/],
    ['"""k""" = 1', /can't be a key/],
    ['a = """x""""""', /too many quotes/],
    ['a = 1979-05-27', /can't read/],
    ['[__proto__]\nx = 1', /isn't allowed/],
    ['__proto__ = 1', /isn't allowed/],
    ['a = 1\n[a]', /not a table/],
  ];
  for (const [text, re] of cases) assert.throws(() => F.parse(text), re, text);
});

test('parse: multi-line strings', () => {
  const v = (t) => F.parse(t).a;
  assert.equal(v('a = """x"""'), 'x');
  // the newline right after the opening quotes is dropped; the rest is kept as written
  assert.equal(v('a = """\none\n  two\n"""'), 'one\n  two\n');
  assert.equal(v("a = '''\ncat <<'X'\n\\n stays\n'''"), "cat <<'X'\n\\n stays\n");
  assert.equal(v('a = """tab\\there \\u00e9"""'), 'tab\there \u00e9');
  // a line-ending backslash joins lines and drops the white space after it
  assert.equal(v('a = """one \\\n   two \\\n\n   three"""'), 'one two three');
  // one or two quotes inside, and up to two at the end
  assert.equal(v('a = """say "hi" and ""yo"""""'), 'say "hi" and ""yo""');
  // in an array, with more after it, and the line numbers still right
  assert.deepEqual(F.parse('a = [\n  """\nx\ny\n""", \'\'\'z\'\'\'  # c\n]\nb = 1').a, ['x\ny\n', 'z']);
  assert.equal(F.parse('a = """\nx\n"""\nb = 1').b, 1);
  assert.throws(() => F.parse('a = """\nx\n"""\nb = ?'), /line 4: /);
});

test('parse: nothing leaks to Object.prototype', () => {
  F.parse('[a]\nb = 1');
  assert.equal({}.b, undefined);
  assert.equal(Object.getPrototypeOf(F.parse('a = 1')), null);
});

test('duration, siteOf, guestPort', () => {
  assert.equal(F.duration('2m'), 120000);
  assert.equal(F.duration('1m30s'), 90000);
  assert.equal(F.duration('250ms'), 250);
  assert.equal(F.duration('soon'), null);
  assert.equal(F.duration(''), null);
  assert.equal(F.siteOf('../python'), 'python');
  assert.equal(F.siteOf('./sites/duckdb/'), 'duckdb');
  assert.equal(F.siteOf('..'), null);
  assert.equal(F.guestPort('8080:8000'), 8000);
  assert.equal(F.guestPort('8000'), 8000);
  assert.equal(F.guestPort('127.0.0.1:8080:8000'), 8000);
  assert.equal(F.guestPort('http'), null);
  assert.equal(F.guestPort('8080:99999'), null);
});

test('plan: the example is a snapshot, a service and a machine on the python machine', () => {
  const p = F.plan(F.parse(example), runtimes);
  assert.equal(p.name, 'python-demo');
  assert.deepEqual(p.problems, []);
  assert.deepEqual(p.steps.map((s) => s.key), ['snapshot/serving', 'machine/scratch', 'service/web']);
  const [snap, mach, svc] = p.steps;
  assert.equal(snap.runtime, 'python');
  assert.equal(snap.timeoutMs, 120000);
  assert.equal(snap.run.length, 2);
  assert.deepEqual(svc.needs, ['snapshot/serving']);
  assert.equal(svc.port, 8000);
  assert.deepEqual(mach.needs, []);
  assert.ok(p.notes.some((n) => /services\.web: min, max, idle, concurrency don't apply/.test(n)));
  assert.ok(p.notes.some((n) => /all run in python/.test(n)));
  assert.ok(p.notes.some((n) => /machines\.scratch: ttl/.test(n)));
});

test('plan: a site the page lacks is a problem, and only the steps that need it go', () => {
  const p = F.plan(F.parse(`
[templates.a]
build = "../nowhere"
[templates.b]
site = "duckdb"
[services.web]
template = "a"
ports = ["80:80"]
[machines.m]
template = "b"
`), runtimes);
  assert.deepEqual(p.steps.map((s) => s.key), ['machine/m']);
  assert.equal(p.problems.length, 1);
  assert.equal(p.problems[0].where, 'services.web');
  assert.match(p.problems[0].message, /no machine "nowhere".*python, web, supabase, duckdb/);
});

test('plan: a service needs a network, ports, and a snapshot that can run', () => {
  const p = F.plan(F.parse(`
[templates.d]
site = "duckdb"
[services.noNet]
template = "d"
ports = ["80:80"]
[templates.py]
site = "python"
[services.noPorts]
template = "py"
[services.badPort]
template = "py"
ports = ["http"]
[snapshots.s]
template = "py"
timeout = "soon"
[templates.t]
snapshot = "s"
[machines.m]
template = "t"
[machines.ghost]
template = "nope"
`), runtimes);
  assert.deepEqual(p.steps, []);
  const by = Object.fromEntries(p.problems.map((x) => [x.where, x.message]));
  assert.match(by['services.noNet'], /no network device/);
  assert.match(by['services.noPorts'], /no ports/);
  assert.match(by['services.badPort'], /host:guest/);
  assert.match(by['snapshots.s'], /timeout/);
  assert.match(by['machines.m'], /snapshot s can't be set up/);
  assert.match(by['machines.ghost'], /no template nope/);
});

test('plan: templates in a circle, snapshots of snapshots, and a link to itself are said', () => {
  const p = F.plan(F.parse(`
[templates.a]
snapshot = "s"
[snapshots.s]
template = "a"
[machines.m]
template = "a"
[templates.py]
site = "python"
[links.x]
from = "py"
to = "py"
[network]
mode = "all"
`), runtimes);
  assert.ok(p.problems.some((x) => /circle|stack/.test(x.message)));
  // Both ends of a link on one site is one machine linking to itself
  assert.ok(p.problems.some((x) => x.where === 'links.x' && /link to itself/.test(x.message)));
  assert.ok(p.notes.some((n) => /network.mode all/.test(n)));
});

test('plan: names that are not safe are problems', () => {
  const p = F.plan(F.parse('[services."a b"]\ntemplate = "x"'), runtimes);
  assert.equal(p.problems[0].where, 'services.a b');
  assert.deepEqual(p.steps, []);
});

// A stand-in orchestrator: commands are logged, and answer as the test says
function fakeApi({ exits = () => 0, timesOut = () => false } = {}) {
  const log = [];
  const jobs = new Map();
  let n = 0;
  return {
    log,
    async runCommand({ runtime, command, timeoutSeconds }, opts) {
      const id = `j${++n}`;
      log.push(`run ${runtime} ${command} (${timeoutSeconds ?? '-'}s, ${opts.source})`);
      jobs.set(id, { command, polls: 0 });
      return { jobId: id, runtime };
    },
    async readJob(id) {
      const j = jobs.get(id);
      if (j.polls++ < 1) return { state: 'running', output: '' };
      if (timesOut(j.command)) return { state: 'timed_out', exitStatus: null, output: 'still going\n' };
      return { state: 'exited', exitStatus: exits(j.command), output: `out of ${j.command}\n` };
    },
    async openPreview(req, opts) { log.push(`preview ${req.runtime}:${req.port} (${opts.source})`); return { status: 200, url: 'http://x/preview/python/8000/' }; },
    async wake(rt) { log.push(`wake ${rt}`); return true; },
  };
}
const fast = { sleep: async () => {}, pollMs: 0 };

test('run: all of the example, in order', async () => {
  const api = fakeApi();
  const changes = [];
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), { ...fast, onchange: () => changes.push(1) });
  assert.equal(run.state('snapshot/serving').status, 'pending');
  assert.equal(await run.runAll(), true);
  assert.deepEqual(api.log.map((l) => l.split(' ').slice(0, 2).join(' ')), ['run python', 'run python', 'run python', 'wake python', 'preview python:8000']);
  assert.match(api.log[2], /wget/);
  assert.match(api.log[0], /\(120s, fleet\)/);
  assert.equal(run.state('service/web').status, 'done');
  assert.equal(run.state('service/web').url, 'http://x/preview/python/8000/');
  assert.match(run.state('service/web').detail, /answered 200/);
  assert.equal(run.state('machine/scratch').detail, 'awake');
  assert.ok(changes.length > 6);
});

test('plan: a command is a string or { cmd, timeout }; each gets its own time, the snapshot\'s, or 10m', () => {
  const file = (run, extra = '') => `[templates.py]\nsite = "python"\n[snapshots.s]\ntemplate = "py"\nrun = [\n${run}\n]\n${extra}`;
  const p = F.plan(F.parse(file(`  { cmd = '''\nmkdir /a\n''', timeout = "90s" },\n  "true",`, 'timeout = "3m"\nready = "true"')), runtimes);
  assert.deepEqual(p.problems, []);
  const s = p.steps.find((x) => x.key === 'snapshot/s');
  assert.deepEqual(s.run, ['mkdir /a\n', 'true']);
  assert.deepEqual(s.runTimeoutsMs, [90000, 180000]);
  assert.equal(s.timeoutMs, 180000, 'ready is retried until the snapshot\'s timeout');
  const none = F.plan(F.parse(file('"true"')), runtimes).steps.find((x) => x.key === 'snapshot/s');
  assert.deepEqual(none.runTimeoutsMs, [600000], 'no timeout anywhere: 10m, as snowglobe apply');
  assert.equal(none.timeoutMs, 120000, 'and ready 2m');
  for (const [run, want] of [
    ['{ cmd = "x", timeout = "soon" }', /run\[0\]: timeout: a duration/],
    ['{ cmd = "x", retries = 2 }', /run\[0\]: unknown key retries/],
    ['{ timeout = "9s" }', /run\[0\] has no cmd/],
  ]) assert.match(F.plan(F.parse(file(run)), runtimes).problems[0].message, want, run);
});

test('run: a command gets its own time limit, and one that runs out of it says so', async () => {
  const text = `[templates.py]\nsite = "python"\n[snapshots.s]\ntemplate = "py"\nrun = [{ cmd = "slow", timeout = "90s" }, "after"]\n`;
  const api = fakeApi({ timesOut: (c) => c === 'slow' });
  const run = F.createRun(api, F.plan(F.parse(text), runtimes), fast);
  assert.equal(await run.runAll(), false);
  assert.match(api.log[0], /run python slow \(90s, fleet\)/);
  assert.equal(api.log.length, 1, 'nothing after it runs');
  assert.match(run.state('snapshot/s').error, /^command 1 of 2 timed out \(its limit 1m30s\) after \d+\.\ds$/);
  assert.match(run.state('snapshot/s').output, /\[timed_out after \d+\.\ds\]/);
});

test('parse: inline tables in an array, a multi-line string in one, and what they refuse', () => {
  const t = F.parse(`run = [\n  { cmd = """\nmulti\nline\n""", timeout = "90s" },\n  "plain",\n]\nn = [1, 2]\n`);
  assert.deepEqual(JSON.parse(JSON.stringify(t)), { run: [{ cmd: 'multi\nline\n', timeout: '90s' }, 'plain'], n: [1, 2] });
  for (const [bad, want] of [
    ['a = [1, "x"]', /one kind of value/],
    ['a = [{ cmd = "x" timeout = "1s" }]', /expected , or \}/],
    ['a = [{ a.b = 1 }]', /dotted key/],
    ['a = [{ x = [1] }]', /inside an inline table/],
    ['a = [{ x = 1, x = 2 }]', /set twice/],
    ['a = [{ __proto__ = 1 }]', /isn't allowed/],
  ]) assert.throws(() => F.parse(bad), want, bad);
});

test('run: a step waits for what it needs', async () => {

  const run = F.createRun(fakeApi(), F.plan(F.parse(example), runtimes), fast);
  await assert.rejects(run.runStep('service/web'), /needs snapshot\/serving first/);
  await assert.rejects(run.runStep('nope'), /no step/);
  await run.runStep('snapshot/serving');
  assert.equal((await run.runStep('service/web')).status, 'done');
});

test('run: a failing command fails its step and stops runAll', async () => {
  const api = fakeApi({ exits: (c) => (/mkdir/.test(c) ? 3 : 0) });
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  assert.equal(await run.runAll(), false);
  const s = run.state('snapshot/serving');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /command 1 exited 3/);
  assert.match(s.output, /out of mkdir/);
  assert.match(s.error, /after \d+\.\ds$/);
  assert.match(s.output, /\[exit 3 after \d+\.\ds\]/);
  assert.equal(api.log.length, 1);
  assert.equal(run.state('service/web').status, 'pending');
});

test('run: ready is retried until it passes, or the timeout', async () => {
  let readies = 0;
  const api = fakeApi({ exits: (c) => (/wget/.test(c) ? (++readies < 3 ? 1 : 0) : 0) });
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  assert.equal((await run.runStep('snapshot/serving')).status, 'done');
  assert.equal(readies, 3);

  let t = 0;
  const never = fakeApi({ exits: (c) => (/wget/.test(c) ? 1 : 0) });
  const late = F.createRun(never, F.plan(F.parse(example), runtimes), { ...fast, now: () => (t += 50000) });
  const r = await late.runStep('snapshot/serving');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /not ready after 120s/);
});

test('run: the ready check waits longer each time, within the step, and says why it failed', async () => {
  const pauses = [];
  let t = 0;
  const never = fakeApi({ exits: (c) => (/wget/.test(c) ? 4 : 0) });
  const limits = [];
  const runCommand = never.runCommand.bind(never);
  never.runCommand = async (req, opts) => {
    if (/wget/.test(req.command)) limits.push(req.timeoutSeconds);
    return runCommand(req, opts);
  };
  const run = F.createRun(never, F.plan(F.parse(example), runtimes), {
    // (Polls of a running job sleep too, for no time: only the pauses between checks are kept)
    ...fast, now: () => t, sleep: async (ms) => { if (ms > 0) pauses.push(ms); t += ms; },
  });
  const r = await run.runStep('snapshot/serving');
  assert.equal(r.status, 'failed');
  assert.deepEqual(pauses.slice(0, 5), [1000, 2000, 4000, 5000, 5000], 'a little less often each time, up to every 5s');
  assert.ok(limits.every((l) => l >= 1 && l <= 10), `each check within what is left: ${limits}`);
  assert.match(r.error, /not ready after 120s: its check exited 4 \(out of wget/);
  assert.match(r.output, /\$ wget .*\nout of wget.*\n\[exit 4\]/);
});

test('run: a preview whose first request failed, and an api that throws, fail the step', async () => {
  const api = fakeApi();
  api.openPreview = async () => ({ error: 'connection refused' });
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  await run.runStep('snapshot/serving');
  const r = await run.runStep('service/web');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /connection refused/);

  api.wake = async () => { throw new Error('the person at the page did not allow it'); };
  assert.match((await run.runStep('machine/scratch')).error, /did not allow/);
  // A failed step can be run again
  api.wake = async () => true;
  assert.equal((await run.runStep('machine/scratch')).status, 'done');
});

test('run: steps asked together run one at a time', async () => {
  const api = fakeApi();
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  await Promise.all([run.runStep('snapshot/serving'), run.runStep('machine/scratch')]);
  assert.match(api.log.at(-1), /wake python/);
  assert.equal(api.log.filter((l) => l.startsWith('wake')).length, 1);
});

// ---------------------------------------------------------------- links

test('plan: the repository example is Supabase and a small Bun viewer, joined by a link', () => {
  const p = F.plan(F.parse(repoExample), runtimes);
  assert.deepEqual(p.problems, []);
  assert.equal(p.name, 'live-data');
  assert.deepEqual(p.steps.map((s) => s.key), ['snapshot/db', 'snapshot/viewer', 'link/viewer-db', 'machine/db', 'service/viewer']);
  const byKey = Object.fromEntries(p.steps.map((s) => [s.key, s]));
  assert.equal(byKey['snapshot/db'].runtime, 'supabase');
  // The viewer is the bun machine, not the web one: small, so the tab's memory is Supabase's
  assert.equal(byKey['snapshot/viewer'].runtime, 'bun');
  assert.equal(byKey['service/viewer'].runtime, 'bun');
  assert.equal(byKey['service/viewer'].port, 8080);
  assert.deepEqual(p.links, [{ from: 'bun', to: 'supabase', port: 54321, as: 'supabase.internal' }]);
  assert.deepEqual(byKey['snapshot/db'].runTimeoutsMs, [120000, 90000, 90000, 60000]);
  assert.match(byKey['snapshot/db'].run[2], /alter publication supabase_realtime add table public\.ticks/);
  // One Bun process (the Supabase CLI's) inserts the rows: no psql loop
  const rows = byKey['snapshot/db'].run[3];
  assert.match(rows, /BUN_BE_BUN=1 nohup supabase run \/root\/rows\/rows\.ts/);
  assert.doesNotMatch(byKey['snapshot/db'].run.join('\n'), /socat|while true; do psql/);
  // Written by the snapshot, started by each machine of its template: no process kept running in it
  assert.equal(byKey['snapshot/db'].ready, null);
  assert.deepEqual(byKey['machine/db'].start, [{ cmd: '/root/rows/start.sh', timeoutMs: 120000 }]);
  assert.doesNotMatch(byKey['snapshot/db'].run.join('\n'), /^\/root\/rows\/start\.sh$/m);
  assert.equal(byKey['service/viewer'].start[0].cmd, '/root/viewer/start.sh');
  assert.match(byKey['service/viewer'].start[1].cmd, /until wget .*8080\/up/);
  assert.equal(byKey['service/viewer'].start[1].timeoutMs, 60000);
  assert.doesNotMatch(byKey['snapshot/viewer'].run.join('\n'), /^\/root\/viewer\/start\.sh$/m);
  // The viewer: Preact and htm fetched as three files, Realtime over Bun's own WebSocket through the link
  const viewer = byKey['snapshot/viewer'].run.join('\n');
  assert.match(viewer, /preact@11\.2\.0\/dist\/preact\.mjs/);
  assert.match(viewer, /ws:\/\/\$\{API\}\/realtime\/v1\/websocket/);
  assert.match(viewer, /const API = "supabase\.internal:54321"/);
  assert.match(viewer, /Bun\.serve/);
  assert.doesNotMatch(viewer, /npm install|supabase-js|node viewer/);
  // Health: the database's while rows come, the viewer's while subscribed, each healed by a hook
  assert.deepEqual(byKey['machine/db'].health.http, { port: 8080, path: '/healthz', status: '200-399', ranges: [[200, 399]] });
  assert.equal(byKey['machine/db'].health.healCmd, '/root/rows/start.sh');
  assert.deepEqual(byKey['service/viewer'].health.http, { port: 8080, path: '/health', status: '200-399', ranges: [[200, 399]] });
  assert.equal(byKey['service/viewer'].health.heal, 'hook');
  assert.equal(byKey['service/viewer'].health.healCmd, '/root/viewer/start.sh');
});

test('run: all of the repository example, in order', async () => {
  const api = fakeApi();
  api.setLinks = async (links) => { api.log.push(`setLinks ${links.map((l) => `${l.from}->${l.to}:${l.port}`).join(' ')}`); return []; };
  const run = F.createRun(api, F.plan(F.parse(repoExample), runtimes), fast);
  assert.equal(await run.runAll(), true);
  assert.ok(api.log.includes('setLinks bun->supabase:54321'), api.log.join('\n'));
});

test('plan: a link needs a name for the guest, a port, a network at both ends and two machines', () => {
  const link = (extra, templates = '[templates.a]\nsite = "python"\n[templates.b]\nsite = "web"\n') =>
    F.plan(F.parse(`${templates}[links.l]\nfrom = "a"\nto = "b"\n${extra}`), runtimes);
  assert.deepEqual(link('port = 80\nas = "x.internal"').problems, []);
  assert.equal(link('port = 80').links[0].as, 'b.internal', 'as defaults to the target template');
  assert.match(link('port = 0\nas = "x.internal"').problems[0].message, /port/);
  assert.match(link('port = "80"\nas = "x.internal"').problems[0].message, /port/);
  assert.match(link('port = 80\nas = "10.0.0.1"').problems[0].message, /host name/);
  assert.match(link('port = 80\nas = "A B"').problems[0].message, /host name/);
  const offline = link('port = 80\nas = "x.internal"', '[templates.a]\nsite = "python"\n[templates.b]\nsite = "duckdb"\n');
  assert.match(offline.problems[0].message, /duckdb has no network device/);
  assert.deepEqual(offline.links, []);
  const noEnd = F.plan(F.parse('[templates.a]\nsite = "python"\n[links.l]\nfrom = "a"\nto = "ghost"\nport = 80'), runtimes);
  assert.match(noEnd.problems[0].message, /no template ghost/);
  // as_port is the port the guest connects to (a raw TCP link): carried to the page as it is, absent when not given
  const ported = link('port = 80\nas = "x.internal"\nas_port = 8080');
  assert.deepEqual(ported.problems, []);
  assert.deepEqual(ported.links, [{ from: 'python', to: 'web', port: 80, as: 'x.internal', as_port: 8080 }]);
  assert.equal(ported.steps.find((s) => s.kind === 'link').asPort, 8080);
  assert.match(ported.steps.find((s) => s.kind === 'link').summary, /as x\.internal:8080/);
  assert.equal('as_port' in link('port = 80\nas = "x.internal"').links[0], false);
  // The guest's 80 and 443 are HTTP in the machine itself: said, unless as_port picks another
  assert.ok(link('port = 80\nas = "x.internal"').notes.some((n) => /x\.internal:80 is carried as HTTP requests, not raw TCP/.test(n)));
  assert.ok(link('port = 5432\nas = "x.internal"\nas_port = 443').notes.some((n) => /x\.internal:443 is carried as HTTPS/.test(n)));
  assert.ok(!ported.notes.some((n) => /raw TCP/.test(n)));
  assert.ok(!link('port = 80\nas = "x.internal"\nas_port = 9100').notes.some((n) => /raw TCP/.test(n)));
  for (const bad of ['0', '70000', '"80"', '1.5']) assert.match(link(`port = 80\nas = "x.internal"\nas_port = ${bad}`).problems[0].message, /as_port/, bad);
});

test('run: the link step gives the page every link, and says which machines it suspended', async () => {
  const api = fakeApi();
  const seen = [];
  api.setLinks = async (links) => { seen.push(links); return ['web']; };
  const run = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  await assert.rejects(run.runStep('link/client-api'), /needs snapshot\/(api|client) first/);
  await run.runStep('snapshot/api');
  await run.runStep('snapshot/client');
  const r = await run.runStep('link/client-api');
  assert.equal(r.status, 'done');
  assert.deepEqual(seen, [[{ from: 'web', to: 'python', port: 9000, as: 'api.internal' }]]);
  assert.match(r.detail, /api\.internal → python:9000 \(web suspended/);
  // The client's service can't be opened before the link: a machine reads its links when it wakes
  const fresh = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  await fresh.runStep('snapshot/client');
  await assert.rejects(fresh.runStep('service/client'), /needs link\/client-api first/);
});

test('run: all of the linked template, in order', async () => {
  const api = fakeApi();
  api.setLinks = async () => [];
  const run = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  assert.equal(await run.runAll(), true);
  const kinds = api.log.map((l) => l.split(' ')[0] + ' ' + l.split(' ')[1]);
  // Each machine starts its server (its template's start), then the client's preview opens
  assert.equal(kinds.at(-1), 'preview web:8080');
  const at = (re) => api.log.findIndex((l) => re.test(l));
  assert.ok(at(/^run python .*http\.server 9000/) > -1 && at(/^wake python/) > at(/^run python .*http\.server 9000/), api.log.join('\n'));
  assert.ok(at(/^run web .*node client\.mjs/) > at(/^wake python/), api.log.join('\n'));
  assert.equal(run.state('service/client').status, 'done');
});

// ---------------------------------------------------------------- the native format

// The browser page is another place to run a fleet file, not another format: what the CLI takes, it
// takes, and what the CLI refuses, it refuses. The keys come from the Go structs themselves.
function goKeys() {
  const src = fs.readFileSync(path.join(__dirname, '../fleet/fleet.go'), 'utf8');
  const keys = {};
  for (const [, type, body] of src.matchAll(/type (\w+Spec) struct \{([\s\S]*?)\n\}/g)) {
    keys[type] = [...body.matchAll(/`toml:"([a-z_]+)"/g)].map((m) => m[1]);
  }
  const file = /type File struct \{([\s\S]*?)\n\}/.exec(src)[1];
  keys.File = [...file.matchAll(/`toml:"([a-z_]+)"/g)].map((m) => m[1]);
  return keys;
}

test('format: every key of the Go fleet structs is decided here, and none is made up', () => {
  const go = goKeys();
  const spec = { templates: 'TemplateSpec', snapshots: 'SnapshotSpec', services: 'ServiceSpec', machines: 'MachineSpec', links: 'LinkSpec', supervisors: 'SupervisorSpec' };
  for (const [kind, type] of Object.entries(spec)) {
    const here = [...F.KEYS[kind].applied, ...F.KEYS[kind].said].sort();
    assert.deepEqual(here, [...go[type]].sort(), `${kind}: keys of ${type}`);
    assert.equal(F.KEYS[kind].applied.filter((k) => F.KEYS[kind].said.includes(k)).length, 0, `${kind}: a key is applied or said, not both`);
  }
  assert.deepEqual([...F.TOP].sort(), [...go.File].sort(), 'the top level of File');
  assert.deepEqual(go.NetworkSpec, ['mode']);
});

test('format: a key the CLI refuses is a problem here, and keys read but not applied are said', () => {
  const p = F.plan(F.parse(`flavour = 1
[network]
mode = "exclusive"
speed = 3
[templates.a]
site = "python"
flavour = "mint"
expose = [80]
idle = "5m"
[services.s]
template = "a"
ports = ["80:80"]
labels = { x = "y" }
`.replace('labels = { x = "y" }\n', '')), runtimes);
  const by = Object.fromEntries(p.problems.map((x) => [x.where, x.message]));
  assert.equal(by.flavour, 'unknown key');
  assert.equal(by['network.speed'], 'unknown key');
  assert.equal(by['templates.a'], 'unknown key flavour');
  assert.ok(p.notes.includes('templates.a: idle, expose aren\'t applied'));
  const one = F.plan(F.parse('[templates.a]\nsite = "python"\n[machines.m]\ntemplate = "a"\ncount = 2'), runtimes);
  assert.ok(one.notes.includes('machines.m: count isn\'t applied'));
  assert.deepEqual(F.plan(F.parse(live), runtimes).problems, [], 'the repository example is clean');
});

test('the fleet templates plan cleanly on the page, each with its machines and links', () => {
  const t = (name) => ({ name, network: 'fetch' });
  const dir = path.join(__dirname, '../../examples/fleet/templates');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.toml'));
  assert.ok(files.length >= 3);
  for (const f of files) {
    const p = F.plan(F.parse(fs.readFileSync(path.join(dir, f), 'utf8')), [t('python'), t('web'), t('supabase')]);
    assert.deepEqual(p.problems, [], f);
    assert.ok(p.steps.some((s) => s.kind === 'service') && p.links.length, f);
  }
});

test('format: the Go planner and this one see the same entries in the repository examples', () => {
  const { execFileSync } = require('node:child_process');
  const repo = path.join(__dirname, '../..');
  const templates = fs.readdirSync(path.join(repo, 'examples/fleet/templates')).map((f) => `examples/fleet/templates/${f}`);
  for (const file of ['examples/fleet/snowglobe.toml', 'examples/todo-fleet/snowglobe.toml', ...templates]) {
    const text = fs.readFileSync(path.join(repo, file), 'utf8');
    const f = F.parse(text);
    // Go's view: its own loader's names (a tiny program in the fleet package's tests prints them)
    let go;
    try {
      go = JSON.parse(execFileSync('go', ['run', './internal/fleet/cmd/names', file], { cwd: repo, encoding: 'utf8', timeout: 120000 }));
    } catch (e) {
      assert.fail(`go run ./internal/fleet/cmd/names ${file}: ${e.message}`);
    }
    const names = (kind) => Object.keys(f[kind] ?? {}).sort();
    assert.deepEqual(go.templates, names('templates'), file);
    assert.deepEqual(go.snapshots, names('snapshots'), file);
    assert.deepEqual(go.services, names('services'), file);
    assert.deepEqual(go.machines, names('machines'), file);
    assert.deepEqual(go.links, names('links'), file);
    // And each snapshot command's time limit, in seconds
    const p = F.plan(f, runtimes);
    for (const st of p.steps.filter((x) => x.kind === 'snapshot')) {
      assert.deepEqual(st.runTimeoutsMs.map((ms) => ms / 1000), go.limits[st.name], `${file}: ${st.name}`);
    }
    assert.equal(go.name, f.name ?? go.name, file);
  }
});

test('run: stop cancels what runs, closes the preview, clears links, sends machines back to their image', async () => {
  const api = fakeApi();
  api.closePreview = async (o) => { api.log.push(`closePreview ${o.source}`); };
  api.setLinks = async (l) => { api.log.push(`setLinks ${l.length}`); return []; };
  api.startFresh = async (rt) => { api.log.push(`fresh ${rt}`); return true; };
  api.cancelJob = async (id) => { api.log.push(`cancel ${id}`); };
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  assert.equal(await run.runAll(), true);
  const r = await run.stop();
  assert.deepEqual(r.problems, []);
  assert.deepEqual(api.log.slice(-3), ['closePreview fleet', 'setLinks 0', 'fresh python']);
  for (const s of run.steps) assert.equal(run.state(s.key).status, 'pending', s.key);
  // and it can run again
  assert.equal(await run.runAll(), true);
});

test('run: stop in the middle of a step ends the step as pending and runAll with it', async () => {
  const api = fakeApi();
  api.startFresh = async () => true;
  api.cancelJob = async (id) => { api.log.push(`cancel ${id}`); };
  let run;
  let stopped;
  const readJob = api.readJob;
  api.readJob = async (id) => { if (!stopped) stopped = run.stop(); return readJob(id); };
  run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  assert.equal(await run.runAll(), false);
  await stopped;
  assert.ok(api.log.some((l) => l.startsWith('cancel ')));
  for (const s of run.steps) assert.equal(run.state(s.key).status, 'pending', s.key);
  assert.ok(!api.log.some((l) => l.startsWith('preview')));
});

test('run: stop names a machine that stays busy, and still resets the steps', async () => {
  const api = fakeApi();
  api.startFresh = async () => { throw new Error('python is busy; wait for it'); };
  const run = F.createRun(api, F.plan(F.parse(example), runtimes), fast);
  await run.runAll();
  const r = await run.stop();
  assert.match(r.problems[0], /python: python is busy/);
  assert.equal(run.state('service/web').status, 'pending');
});

test('highlight: gives the text back exactly, with the parts named', () => {
  const text = [
    '# a comment',
    'name = "x"  # trailing',
    '[snapshots.db]',
    "run = [",
    "'''",
    '# a shell comment',
    'echo "$HOME" ${X} $(date)',
    "''',",
    '  "one", 2, 3.5, true',
    ']',
    "a.b = 'lit'",
  ].join('\n');
  const parts = F.highlight(text);
  assert.equal(parts.map((p) => p[1]).join(''), text);
  const has = (cls, t) => assert.ok(parts.some((p) => p[0] === cls && p[1] === t), `${cls} ${t}`);
  has('cmt', '# a comment');
  has('cmt', '# trailing');
  has('tbl', '[snapshots.db]');
  has('key', 'name');
  has('key', 'a.b');
  has('str', '"x"');
  has('cmt', '# a shell comment');
  has('var', '$HOME');
  has('var', '${X}');
  has('var', '$(');
  has('num', '2');
  has('num', '3.5');
  has('bool', 'true');
  has('str', "'lit'");
  // after a multi-line string closes, the line goes on as normal
  assert.deepEqual(F.highlight("a = '''x''' # c").slice(-2), [[null, ' '], ['cmt', '# c']]);
  // odd text is returned whole: it only colours
  for (const t of ['a = "open', '[bad', '"""', "a = '''\n\\", '= = =\n\n']) assert.equal(F.highlight(t).map((p) => p[1]).join(''), t, t);
});

test('graph: a node for each machine used, an edge for each link, columns by chain (a fork here)', () => {
  const t = (name) => ({ name, network: 'fetch' });
  const file = F.parse(fs.readFileSync(path.join(__dirname, '../../examples/fleet/templates/two-sources.toml'), 'utf8'));
  const g = F.graph(F.plan(file, [t('python'), t('web'), t('supabase')]));
  const by = Object.fromEntries(g.nodes.map((n) => [n.id, n]));
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['python', 'supabase', 'web']);
  // a fork: the viewer on its own, the two sources beside each other behind it
  assert.deepEqual([by.web.rank, by.python.rank, by.supabase.rank], [0, 1, 1]);
  assert.notEqual(by.python.row, by.supabase.row);
  assert.deepEqual(by.python.names, ['alpha']);
  assert.deepEqual(by.web.services, [{ name: 'viewer', port: 8080 }]);
  assert.deepEqual(g.edges.map((e) => `${e.from}>${e.to} ${e.label}`).sort(), ['web>python alpha.internal:9000', 'web>supabase beta.internal:9000']);
});

test('graph: a fleet without links is its machines in one column; a cycle does not run away', () => {
  const g = F.graph({ steps: [{ kind: 'machine', runtime: 'a', name: 'a1' }, { kind: 'machine', runtime: 'b', name: 'b1' }], links: [] });
  assert.deepEqual(g.nodes.map((n) => [n.rank, n.row]), [[0, 0], [0, 1]]);
  const c = F.graph({ steps: [], links: [{ from: 'a', to: 'b', port: 1, as: 'x' }, { from: 'b', to: 'a', port: 2, as: 'y', asPort: 3 }] });
  assert.ok(c.nodes.every((n) => n.rank <= 1));
  assert.equal(c.edges[0].label, 'x:1');
  assert.equal(c.edges[1].label, 'y:3 → :2');
});

test('plan: a multi-line command reaches the machine as the file says it, like the CLI', () => {
  const file = F.parse("name = 'x'\n[templates.t]\nsite = 'python'\n[snapshots.s]\ntemplate = 't'\nrun = [\n'''\nls\necho hi\n''',\n]\n");
  const step = F.plan(file, runtimes).steps.find((s) => s.kind === 'snapshot');
  assert.deepEqual(step.run, ['ls\necho hi\n']);
  // run is an array, even for one command: the CLI refuses a bare string
  const bare = F.parse("name = 'x'\n[templates.t]\nsite = 'python'\n[snapshots.s]\ntemplate = 't'\nrun = 'ls'\n");
  assert.match(F.plan(bare, runtimes).problems[0].message, /array of commands/);
});

test('parse: what Go reads that this once refused (\\e, \\xHH, a comma that starts a line), and the line of an error in a string', () => {
  assert.equal(F.parse('a = "\\e[31m\\x41"').a, '\x1b[31mA');
  assert.equal(F.parse('a = """\\e\\x41"""').a, '\x1bA');
  assert.deepEqual(F.parse('a = [\n  "x"\n  , "y"\n]').a, ['x', 'y']);
  assert.throws(() => F.parse('a = [, "y"]'), /value is missing/);
  assert.throws(() => F.parse('a = """\nok\n\\q\n"""'), /line 3: a bad escape/);
});

test('run: stop also stops what Run all would do next, and says a machine that was not reset', async () => {
  const api = fakeApi();
  api.closePreview = async () => {};
  api.startFresh = async () => false;
  let run;
  let stopped;
  api.setLinks = async () => { api.log.push('setLinks'); if (!stopped) stopped = run.stop(); return []; };
  run = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  assert.equal(await run.runAll(), false);
  const r = await stopped;
  assert.ok(!api.log.some((l) => /^(wake|preview)/.test(l)), api.log.join(' | '));
  assert.match(r.problems.join(), /not reset/);
  for (const st of run.steps) assert.equal(run.state(st.key).status, 'pending', st.key);
});

test('run: starting a command may take startMs (a cold machine waking), its reads only callMs', async () => {
  // A cold Supabase on a phone: the first command waits for the machine to boot, past callMs
  const slow = fakeApi();
  const runCommand = slow.runCommand.bind(slow);
  slow.runCommand = (req, opts) => new Promise((done) => setTimeout(() => done(runCommand(req, opts)), 30));
  const run = F.createRun(slow, F.plan(F.parse(example), runtimes), { ...fast, callMs: 5, startMs: 1000 });
  assert.equal((await run.runStep('snapshot/serving')).status, 'done');
  // One that never starts fails at startMs, and says so
  const hung = fakeApi();
  hung.runCommand = () => new Promise(() => {});
  let t = 0;
  const stuck = F.createRun(hung, F.plan(F.parse(example), runtimes), { ...fast, callMs: 5, startMs: 20, now: () => (t += 20000) });
  const r = await stuck.runStep('snapshot/serving');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /did not answer the command within 0s/);
});

test('run: a machine that stops answering fails the step at its deadline rather than hanging', async () => {
  // A phone's worker, frozen or ended without a word: its calls never settle
  const quick = { ...fast, callMs: 5, timer: (fn) => setTimeout(fn, 1) };
  const hung = fakeApi();
  hung.readJob = () => new Promise(() => {});
  let t = 0;
  const run = F.createRun(hung, F.plan(F.parse(example), runtimes), { ...quick, now: () => (t += 20000) });
  const r = await run.runStep('snapshot/serving');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /timed out .*did not answer a read of the command/);

  // The commands answer and the ready check's reads don't: its tries run out at the timeout
  const api = fakeApi();
  const read = api.readJob.bind(api);
  const ids = new Set();
  const runCommand = api.runCommand.bind(api);
  api.runCommand = async (req, opts) => {
    const r = await runCommand(req, opts);
    if (/wget/.test(req.command)) ids.add(r.jobId);
    return r;
  };
  api.readJob = (id) => (ids.has(id) ? new Promise(() => {}) : read(id));
  let u = 0;
  const ready = F.createRun(api, F.plan(F.parse(example), runtimes), { ...quick, now: () => (u += 20000) });
  const s = await ready.runStep('snapshot/serving');
  assert.equal(s.status, 'failed');
  assert.match(s.error, /not ready after 120s/);
});

test('format: a health check\'s keys are Go\'s', () => {
  const go = goKeys();
  assert.deepEqual([...F.HEALTH_KEYS].sort(), [...go.HealthSpec].sort());
  assert.deepEqual([...F.HTTP_KEYS].sort(), [...go.HTTPSpec].sort());
});

const healthFile = `[templates.a]
site = "python"
[templates.a.health]
cmd = "true"
heal = "replace"
[templates.b]
site = "web"
[services.s]
template = "a"
ports = ["80:8000"]
[machines.m]
template = "a"
[machines.n]
template = "b"
[machines.n.health]
interval = "5s"
heal = "hook"
heal_cmd = "restart-it"
[machines.n.health.http]
port = 8080
path = "/healthz"
status = "200,204"
`;

test('plan: health checks are applied, with the daemon\'s defaults, and a template\'s is its services\' and machines\'', () => {
  const p = F.plan(F.parse(healthFile), runtimes);
  assert.deepEqual(p.problems, []);
  const by = Object.fromEntries(p.steps.map((s) => [s.key, s]));
  assert.deepEqual(by['service/s'].health, { http: null, cmd: 'true', intervalMs: 10000, timeoutMs: 2000, failures: 3, graceMs: 30000, heal: 'replace', healCmd: null, drainMs: 30000, waitReady: false });
  assert.equal(by['machine/m'].health.heal, 'none', 'a machine heals by none or hook: its template\'s replace is for its services');
  assert.deepEqual(by['machine/n'].health.http, { port: 8080, path: '/healthz', status: '200,204', ranges: [[200, 200], [204, 204]] });
  assert.equal(by['machine/n'].health.timeoutMs, 2000);
  assert.match(by['service/s'].summary, /checked by `true` every 10s/);
  assert.match(by['machine/n'].summary, /GET :8080\/healthz \(200,204\) every 5s/);
  assert.ok(!p.notes.some((n) => /health/.test(n)), p.notes.join('\n'));
});

test('plan: a health check the daemon refuses is a problem here', () => {
  const svc = (h) => `[templates.a]\nsite = "python"\n[services.s]\ntemplate = "a"\nports = ["80:80"]\n[services.s.health]\n${h}\n`;
  const mach = (h) => `[templates.a]\nsite = "python"\n[machines.m]\ntemplate = "a"\n[machines.m.health]\n${h}\n`;
  for (const [file, want] of [
    [svc(''), /one of http or cmd/],
    [svc('cmd = "x"\n[services.s.health.http]\nport = 80'), /one of http or cmd/],
    [svc('cmd = "x"\ninterval = "500ms"'), /interval 500ms: 1s or more/],
    [svc('cmd = "x"\ninterval = "5s"\ntimeout = "6s"'), /timeout "6s": more than 0 and at most the interval \(5s\)/],
    [svc('cmd = "x"\nheal = "hook"'), /needs heal_cmd/],
    [svc('cmd = "x"\nheal = "reboot"'), /heal "reboot": none, drain, hook or replace/],
    [svc('cmd = "x"\nretries = 2'), /health: unknown key retries/],
    [svc('[services.s.health.http]\nport = 80\nstatus = "200-700"'), /codes \(100 to 599\)/],
    [mach('cmd = "x"\nheal = "replace"'), /a machine heals by none or hook; put it under a supervisor/],
    [`[templates.a]\nsite = "duckdb"\n[machines.m]\ntemplate = "a"\n[machines.m.health.http]\nport = 80`, /no network device on the page, so its HTTP check can't reach it/],
  ]) {
    const p = F.plan(F.parse(file), runtimes);
    assert.match(p.problems.map((x) => x.message).join('\n'), want, file);
  }
  const drain = F.plan(F.parse(svc('cmd = "x"\nheal = "drain"')), runtimes);
  assert.ok(drain.notes.some((n) => /heal drain only reports here/.test(n)));
});

const supFile = `[templates.db]
site = "supabase"
[templates.app]
site = "python"
[templates.web]
site = "web"
[machines.db]
template = "db"
[machines.db.health]
cmd = "pg_isready"
[services.app]
template = "app"
ports = ["80:8000"]
[services.app.health]
cmd = "app-ok"
[machines.web]
template = "web"
[supervisors.inner]
strategy = "rest_for_one"
children = ["db", "app"]
[supervisors.top]
strategy = "one_for_all"
children = ["inner", "web"]
max_restarts = 1
max_seconds = "30s"
[supervisors.top.restart]
web = "temporary"
`;

test('plan: supervisors are applied: their children\'s steps, restart types and nesting', () => {
  const p = F.plan(F.parse(supFile), runtimes);
  assert.deepEqual(p.problems, []);
  const by = Object.fromEntries(p.supervisors.map((s) => [s.name, s]));
  assert.deepEqual(by.inner.children.map((c) => [c.kind, c.key, c.restart]), [['machine', 'machine/db', 'permanent'], ['service', 'service/app', 'permanent']]);
  assert.equal(by.inner.parent, 'top');
  assert.equal(by.inner.maxRestarts, 3);
  assert.equal(by.inner.maxMs, 60000);
  assert.deepEqual(by.top.children.map((c) => [c.key, c.restart]), [['supervisor/inner', 'permanent'], ['machine/web', 'temporary']]);
  assert.equal(by.top.maxRestarts, 1);
  assert.equal(by.top.maxMs, 30000);
  assert.equal(p.steps.find((s) => s.key === 'service/app').supervisor, 'inner');
  assert.equal(p.steps.find((s) => s.key === 'machine/web').supervisor, 'top');
  assert.ok(!p.notes.some((n) => /supervisors/.test(n)), p.notes.join('\n'));
});

test('plan: a supervisor the CLI refuses is a problem here, and one whose child can\'t run is left out', () => {
  const base = '[templates.a]\nsite = "python"\n[machines.m]\ntemplate = "a"\n[machines.k]\ntemplate = "a"\n';
  for (const [sup, want] of [
    ['[supervisors.s]\nchildren = ["nope"]', /child nope: no service, machine or supervisor/],
    ['[supervisors.s]\nchildren = ["m", "m"]', /child m twice/],
    ['[supervisors.s]\nchildren = []', /children: at least one/],
    ['[supervisors.s]\nchildren = ["m"]\nstrategy = "all_for_none"', /strategy "all_for_none"/],
    ['[supervisors.s]\nchildren = ["m"]\n[supervisors.s.restart]\nk = "temporary"', /restart k: not one of its children/],
    ['[supervisors.s]\nchildren = ["m"]\n[supervisors.s.restart]\nm = "sometimes"', /permanent, transient or temporary/],
    ['[supervisors.s]\nchildren = ["m"]\n[supervisors.t]\nchildren = ["m"]', /child m is a child of supervisor s too/],
    ['[supervisors.s]\nchildren = ["t"]\n[supervisors.t]\nchildren = ["s"]', /go round in a circle/],
    ['[supervisors.m]\nchildren = ["k"]', /a machine has that name/],
  ]) {
    const p = F.plan(F.parse(base + sup), runtimes);
    assert.match(p.problems.map((x) => x.message).join('\n'), want, sup);
  }
  const p = F.plan(F.parse('[templates.a]\nsite = "nowhere"\n[machines.m]\ntemplate = "a"\n[supervisors.s]\nchildren = ["m"]'), runtimes);
  assert.ok(p.problems.some((x) => x.where === 'supervisors.s' && /machine m can't run here/.test(x.message)));
  assert.deepEqual(p.supervisors, []);
  const shared = F.plan(F.parse(base + '[supervisors.s]\nchildren = ["m", "k"]'), runtimes);
  assert.ok(shared.notes.includes('supervisors.s: m, k run in python, so restarting one restarts them all'));
});

/** A run over the stand-in orchestrator with a clock of its own, health checks answered by `checks`
 *  (runtime → { exit } / { status } / null), and the machines started fresh logged. */
function healthRun(text, { checks = () => ({ exit: 0 }), status = () => 'awake' } = {}) {
  const api = fakeApi();
  let t = 0;
  api.healthCheck = async (req) => { api.log.push(`check ${req.runtime}`); const r = checks(req); return r && { last: r.exit !== undefined ? `exit ${r.exit}` : `HTTP ${r.status}`, ...r }; };
  api.startFresh = async (rt) => { api.log.push(`fresh ${rt}`); return true; };
  api.status = async (rt) => ({ state: status(rt) });
  const p = F.plan(F.parse(text), runtimes);
  assert.deepEqual(p.problems, []);
  const run = F.createRun(api, p, { ...fast, now: () => t });
  return { api, run, plan: p, at: (ms) => { t = ms; }, later: (ms) => { t += ms; } };
}
const svcHealth = (h) => `[templates.a]\nsite = "python"\n[services.s]\ntemplate = "a"\nports = ["80:8000"]\n[services.s.health]\ninterval = "1s"\n${/grace/.test(h) ? '' : 'grace = "5s"\n'}${h}\n`;

test('run: a check that fails within its grace doesn\'t count; after it, failures in a row make it unhealthy and it is replaced', async () => {
  let ok = true;
  const r = healthRun(svcHealth('cmd = "ok"'), { checks: () => ({ exit: ok ? 0 : 1 }) });
  assert.equal(await r.run.runAll(), true);
  assert.equal(r.run.health('service/s').state, 'starting');
  ok = false;
  for (let i = 0; i < 4; i++) { r.later(1000); await r.run.tick(); }
  assert.equal(r.run.health('service/s').state, 'starting', 'within its grace a failed check doesn\'t count');
  assert.equal(r.run.health('service/s').failures, 0);
  for (let i = 0; i < 2; i++) { r.later(1000); await r.run.tick(); }
  assert.equal(r.run.health('service/s').failures, 2);
  r.api.log.length = 0;
  r.later(1000); await r.run.tick();
  ok = true; // the restart brings it back
  assert.deepEqual(r.api.log.filter((l) => !l.startsWith('check')), ['fresh python', 'preview python:8000 (fleet)'], 'started from its image, its steps run again');
  assert.equal(r.run.health('service/s').state, 'starting', 'checked over again, from a new grace');
  assert.equal(r.run.health('service/s').heals, 1);
  r.later(1000); await r.run.tick();
  assert.equal(r.run.health('service/s').state, 'healthy');
  assert.equal(r.run.health('service/s').heals, 0, 'a passed check ends the heals in a row');
});

test('run: a check never wakes a machine: asleep, it isn\'t checked', async () => {
  const r = healthRun(svcHealth('cmd = "ok"'), { checks: () => null });
  await r.run.runAll();
  for (let i = 0; i < 20; i++) { r.later(1000); await r.run.tick(); }
  assert.equal(r.run.health('service/s').state, 'starting');
  assert.ok(!r.api.log.some((l) => l.startsWith('fresh')));
});

test('run: an HTTP check passes on a status in its range', async () => {
  let status = 204;
  const r = healthRun(svcHealth('[services.s.health.http]\nport = 8000\nstatus = "200,204"'), { checks: () => ({ status }) });
  await r.run.runAll();
  r.later(1000); await r.run.tick();
  assert.equal(r.run.health('service/s').state, 'healthy');
  status = 500;
  r.later(6000);
  for (let i = 0; i < 3; i++) { r.later(1000); await r.run.tick(); }
  assert.ok(['healing', 'starting', 'unhealthy'].includes(r.run.health('service/s').state));
  assert.ok(r.api.log.includes('fresh python'));
});

test('run: hook runs heal_cmd and checks again; unhealthy again, a service is replaced and a machine reports', async () => {
  const r = healthRun(svcHealth('cmd = "ok"\nfailures = 1\nheal = "hook"\nheal_cmd = "fix-it"'), { checks: () => ({ exit: 1 }) });
  await r.run.runAll();
  r.later(6000); await r.run.tick();
  assert.ok(r.api.log.some((l) => l.startsWith('run python fix-it')), r.api.log.join('\n'));
  assert.match(r.run.health('service/s').last, /ran its heal command \(exit 0\), checking it again/);
  assert.equal(r.run.health('service/s').state, 'checking');
  r.later(500); await r.run.tick(); // its next check isn't due
  assert.ok(!r.api.log.includes('fresh python'), 'not replaced before it is checked again');
  r.later(500); await r.run.tick(); // checked again, failing: replaced, its hook tried
  assert.ok(r.api.log.includes('fresh python'), r.api.log.join('\n'));

  const m = healthRun('[templates.a]\nsite = "python"\n[machines.m]\ntemplate = "a"\n[machines.m.health]\ncmd = "ok"\ninterval = "1s"\ngrace = "0s"\nfailures = 1\nheal = "hook"\nheal_cmd = "fix-it"\n', { checks: () => ({ exit: 1 }) });
  await m.run.runAll();
  for (let i = 0; i < 10; i++) { m.later(1000); await m.run.tick(); }
  assert.equal(m.api.log.filter((l) => l.startsWith('run python fix-it')).length, 1, 'one hook');
  assert.ok(!m.api.log.includes('fresh python'), 'a machine no supervisor watches is never restarted');
  assert.equal(m.run.health('machine/m').state, 'unhealthy');
});

test('run: after 5 heals in a row with no check passing it is degraded, and healing stops', async () => {
  const r = healthRun(svcHealth('cmd = "ok"\nfailures = 1\ngrace = "0s"'), { checks: () => ({ exit: 1 }) });
  await r.run.runAll();
  for (let i = 0; i < 400; i++) { r.later(1000); await r.run.tick(); }
  assert.equal(r.api.log.filter((l) => l === 'fresh python').length, 5);
  assert.equal(r.run.health('service/s').state, 'degraded');
  assert.match(r.run.health('service/s').why, /healed 5 times in a row/);
});

test('run: wait_ready holds the service step until it passes a check, within its grace', async () => {
  let n = 0;
  const r = healthRun(svcHealth('cmd = "ok"\nwait_ready = true'), { checks: () => ({ exit: ++n >= 3 ? 0 : 1 }) });
  assert.equal(await r.run.runAll(), true);
  assert.match(r.run.state('service/s').detail, /passed its check/);
  assert.equal(n, 3);
  const never = healthRun(svcHealth('cmd = "ok"\nwait_ready = true'), { checks: () => { never.later(1000); return { exit: 1 }; } });
  assert.equal(await never.run.runAll(), false);
  assert.match(never.run.state('service/s').error, /didn't pass its check within its grace \(5s\): exit 1/);
});

test('run: supervisors restart by strategy, leave temporary children alone, escalate, and degrade at the top', async () => {
  const sick = new Set();
  const file = supFile.replace('[machines.db.health]\ncmd = "pg_isready"', '[machines.db.health]\ncmd = "pg_isready"\ninterval = "1s"\ngrace = "0s"\nfailures = 1')
    .replace('[services.app.health]\ncmd = "app-ok"', '[services.app.health]\ncmd = "app-ok"\ninterval = "1s"\ngrace = "0s"\nfailures = 1');
  const r = healthRun(file, { checks: (req) => ({ exit: sick.has(req.runtime) ? 1 : 0 }) });
  assert.equal(await r.run.runAll(), true);
  const fresh = () => r.api.log.filter((l) => l.startsWith('fresh')).map((l) => l.slice(6));
  // rest_for_one: app (after db) fails: only app restarted
  sick.add('python');
  r.later(1000); await r.run.tick();
  sick.delete('python');
  assert.deepEqual(fresh(), ['python']);
  assert.match(r.run.supervisor('inner').last, /restarted app \(rest_for_one, restart 1 of 3/);
  // db fails: db and app, app stopped first
  r.api.log.length = 0;
  sick.add('supabase');
  r.later(1000); await r.run.tick();
  sick.delete('supabase');
  assert.deepEqual(fresh(), ['python', 'supabase']);
  assert.deepEqual(r.api.log.filter((l) => /^(wake|preview)/.test(l)), ['wake supabase', 'preview python:8000 (fleet)'], 'started again in order');
  // a third and a fourth restart in a minute: inner fails top, whose one_for_all restarts inner
  // (and so db and app) but not web, temporary
  r.api.log.length = 0;
  for (let i = 0; i < 2; i++) { sick.add('python'); r.later(1000); await r.run.tick(); sick.delete('python'); }
  assert.match(r.run.supervisor('inner').last, /it failed top/);
  assert.match(r.run.supervisor('top').last, /restarted inner \(one_for_all/);
  assert.ok(!fresh().includes('web'), 'web is temporary: left alone');
  assert.equal(r.run.supervisor('inner').restarts.length, 0, 'inner, restarted, starts over');
  // top's second restart in its 30s is more than its 1: degraded
  for (let i = 0; i < 4; i++) { sick.add('python'); r.later(1000); await r.run.tick(); sick.delete('python'); }
  assert.equal(r.run.supervisor('top').state, 'degraded');
  r.api.log.length = 0;
  for (let i = 0; i < 4; i++) { sick.add('python'); r.later(1000); await r.run.tick(); sick.delete('python'); }
  assert.deepEqual(fresh(), [], 'degraded: nothing is restarted');
  assert.equal(r.run.health('service/app').state, 'unhealthy');
  await r.run.restartSupervisor('top');
  assert.equal(r.run.supervisor('top').state, 'running');
  assert.deepEqual(fresh().filter((x, i, a) => a.indexOf(x) === i).sort(), ['python', 'supabase'], 'restarted by hand: its children but the temporary one');
});

test('run: a supervised machine that stops by itself has ended: restarted when permanent, not when transient', async () => {
  const file = (type) => `[templates.a]\nsite = "python"\n[machines.m]\ntemplate = "a"\n[supervisors.s]\nchildren = ["m"]\n[supervisors.s.restart]\nm = "${type}"\n`;
  let state = 'awake';
  const r = healthRun(file('permanent'), { status: () => state });
  await r.run.runAll();
  state = 'failed';
  await r.run.tick();
  state = 'awake';
  assert.deepEqual(r.api.log.slice(-2), ['fresh python', 'wake python']);
  const t = healthRun(file('transient'), { status: () => state });
  await t.run.runAll();
  state = 'failed';
  await t.run.tick();
  assert.ok(!t.api.log.includes('fresh python'));
  assert.match(t.run.supervisor('s').last, /transient, so a normal exit/);
});

test('run: stop forgets health and supervisors\' restarts', async () => {
  const r = healthRun(svcHealth('cmd = "ok"'));
  await r.run.runAll();
  r.later(1000); await r.run.tick();
  assert.equal(r.run.health('service/s').state, 'healthy');
  await r.run.stop();
  assert.equal(r.run.health('service/s'), null);
});

// The example with its server started by the serving template, not kept by the snapshot
const started = example
  .replace(`       "cd /srv && python3 -m http.server 8000 >/dev/null 2>&1 &"]`, `       "true"]`)
  .replace(`ready = "wget -q -O /dev/null http://127.0.0.1:8000/"\n`, '')
  .replace(`[templates.serving]\nsnapshot = "serving"`, `[templates.serving]\nsnapshot = "serving"\nstart = ["cd /srv && python3 -m http.server 8000 >/dev/null 2>&1 &", { cmd = "wget -q -O /dev/null http://127.0.0.1:8000/", timeout = "30s" }]`);

test('plan: a template\'s start commands go with its services\' and machines\' steps, each with its time', () => {
  const p = F.plan(F.parse(started), runtimes);
  assert.deepEqual(p.problems, []);
  const web = p.steps.find((s) => s.key === 'service/web');
  assert.deepEqual(web.start, [
    { cmd: 'cd /srv && python3 -m http.server 8000 >/dev/null 2>&1 &', timeoutMs: 120000 },
    { cmd: 'wget -q -O /dev/null http://127.0.0.1:8000/', timeoutMs: 30000 },
  ]);
  assert.match(web.summary, /^Start python \(2 commands\), then open python's port 8000/);
  // The scratch machine's template (py) has none
  assert.deepEqual(p.steps.find((s) => s.key === 'machine/scratch').start, []);
  for (const [bad, said] of [
    ['start = "one"', /start: an array of commands/],
    ['start = [""]', /start\[0\]: a command/],
    ['start = [{ cmd = "x", when = "now" }]', /start\[0\]: unknown key when/],
    ['start = [{ cmd = "x", timeout = "soon" }]', /start\[0\]: timeout: a duration/],
  ]) {
    const q = F.plan(F.parse(example.replace('[templates.serving]\nsnapshot = "serving"', `[templates.serving]\nsnapshot = "serving"\n${bad}`)), runtimes);
    assert.ok(q.problems.some((x) => x.where === 'templates.serving' && said.test(x.message)), `${bad}: ${JSON.stringify(q.problems)}`);
  }
});

test('run: start commands run in the machine before its service opens, once, and one that fails fails the step', async () => {
  const api = fakeApi();
  const run = F.createRun(api, F.plan(F.parse(started), runtimes), fast);
  assert.equal(await run.runAll(), true);
  const at = (re) => api.log.findIndex((l) => re.test(l));
  assert.ok(at(/http\.server/) > at(/run python true/), api.log.join('\n'));
  assert.ok(at(/preview python:8000/) > at(/run python wget .*\(30s, fleet\)/), api.log.join('\n'));
  assert.match(api.log[at(/http\.server/)], /\(120s, fleet\)/);
  assert.equal(api.log.filter((l) => /http\.server/.test(l)).length, 1);

  const failing = fakeApi({ exits: (c) => (/wget/.test(c) ? 1 : 0) });
  const broken = F.createRun(failing, F.plan(F.parse(started), runtimes), fast);
  const r = await broken.runStep('snapshot/serving').then(() => broken.runStep('service/web'));
  assert.equal(r.status, 'failed');
  assert.match(r.error, /start command 2 of 2 exited 1/);
  assert.ok(!failing.log.some((l) => /^preview/.test(l)), 'the service is not opened');
});
