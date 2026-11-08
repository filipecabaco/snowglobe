// The fleet page's TOML, plan and run (fleet.js), over a stand-in orchestrator
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('./fleet.js');

// The repository's example fleet: live data on one machine, shown by another over a link
const live = fs.readFileSync(path.join(__dirname, '../../examples/fleet/snowglobe.toml'), 'utf8');
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
    ['a = """x"""', /multi-line/],
    ['a = 1979-05-27', /can't read/],
    ['[__proto__]\nx = 1', /isn't allowed/],
    ['__proto__ = 1', /isn't allowed/],
    ['a = 1\n[a]', /not a table/],
  ];
  for (const [text, re] of cases) assert.throws(() => F.parse(text), re, text);
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
function fakeApi({ exits = () => 0 } = {}) {
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

test('plan: the repository example links a viewer to a Supabase database over two machines', () => {
  const p = F.plan(F.parse(live), runtimes);
  assert.deepEqual(p.problems, []);
  assert.equal(p.name, 'live-data');
  assert.deepEqual(p.steps.map((s) => s.key), ['snapshot/db', 'snapshot/viewer', 'link/viewer-db', 'machine/db', 'service/viewer']);
  const byKey = Object.fromEntries(p.steps.map((s) => [s.key, s]));
  assert.equal(byKey['snapshot/db'].runtime, 'supabase');
  assert.equal(byKey['snapshot/viewer'].runtime, 'web');
  assert.deepEqual(p.links, [{ from: 'web', to: 'supabase', port: 54321, as: 'supabase.internal' }]);
  // The link waits for what both ends run; the viewer's service for its own setup and the link
  assert.deepEqual(byKey['link/viewer-db'].needs.sort(), ['snapshot/db', 'snapshot/viewer']);
  assert.deepEqual(byKey['service/viewer'].needs.sort(), ['link/viewer-db', 'snapshot/viewer']);
  assert.deepEqual(byKey['machine/db'].needs, ['snapshot/db']);
  assert.equal(byKey['service/viewer'].port, 8080);
  // The scripts in the file are what the machines run
  assert.match(byKey['snapshot/db'].run[0], /alter publication supabase_realtime add table public\.ticks/);
  assert.match(byKey['snapshot/viewer'].run[0], /createClient\('http:\/\/supabase\.internal:54321'/);
  assert.match(byKey['snapshot/viewer'].run[0], /postgres_changes/);
  assert.ok(!p.notes.some((n) => /links\./.test(n)));
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
  await assert.rejects(run.runStep('link/viewer-db'), /needs snapshot\/(db|viewer) first/);
  await run.runStep('snapshot/db');
  await run.runStep('snapshot/viewer');
  const r = await run.runStep('link/viewer-db');
  assert.equal(r.status, 'done');
  assert.deepEqual(seen, [[{ from: 'web', to: 'supabase', port: 54321, as: 'supabase.internal' }]]);
  assert.match(r.detail, /supabase\.internal → supabase:54321 \(web suspended/);
  // The viewer's service can't be opened before the link: a machine reads its links when it wakes
  const fresh = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  await fresh.runStep('snapshot/viewer');
  await assert.rejects(fresh.runStep('service/viewer'), /needs link\/viewer-db first/);
});

test('run: all of the live example, in order', async () => {
  const api = fakeApi();
  api.setLinks = async () => [];
  const run = F.createRun(api, F.plan(F.parse(live), runtimes), fast);
  assert.equal(await run.runAll(), true);
  const kinds = api.log.map((l) => l.split(' ')[0] + ' ' + l.split(' ')[1]);
  assert.deepEqual(kinds.slice(-2), ['wake supabase', 'preview web:8080']);
  assert.equal(run.state('service/viewer').status, 'done');
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
  const spec = { templates: 'TemplateSpec', snapshots: 'SnapshotSpec', services: 'ServiceSpec', machines: 'MachineSpec', links: 'LinkSpec' };
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

test('format: the Go planner and this one see the same entries in the repository examples', () => {
  const { execFileSync } = require('node:child_process');
  const repo = path.join(__dirname, '../..');
  for (const file of ['examples/fleet/snowglobe.toml', 'examples/todo-fleet/snowglobe.toml']) {
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
    assert.equal(go.name, f.name ?? go.name, file);
  }
});
