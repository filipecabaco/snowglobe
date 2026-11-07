// What an agent changed (builder.js): the wrapper's report, its parsing, the rebuild watch, the
// walkthrough's edits against the web example's real starter app, and the feed
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const B = require('./builder.js');

const NONCE = 'abcdef0123456789';
const report = (body) => `\n${'SGCHANGES'}_${NONCE} BEGIN\n${body}SGCHANGES_${NONCE} END\n`;

test('a command is wrapped, never changed: it runs from a job file, and the job exits with its status', () => {
  const w = B.wrapCommand("echo 'hi'; exit 3", '/root/app/', NONCE);
  assert.equal(new TextDecoder().decode(w.files.cmd), "echo 'hi'; exit 3\n");
  assert.match(w.command, /^sg_w='\/root\/app'; sg_s='\/var\/lib\/snowglobe\/watch\/root\/app'; /m);
  assert.match(w.command, /^sh "\$EXCLAVE_WORKSPACE\/in\/cmd"$/m);
  assert.match(w.command, /^exit \$sg_rc$/m);
  assert.ok(!w.command.includes("echo 'hi'"), 'the command is not in the wrapper');
  assert.throws(() => B.wrapCommand('x', '/root/app', 'short'), /nonce/);
  assert.throws(() => B.wrapCommand('x', 'relative', NONCE), /absolute/);
  assert.throws(() => B.wrapCommand('x', '/a\nb', NONCE), /absolute/);
  assert.equal(B.snapshotDir('/'), '/var/lib/snowglobe/watch/root-dir');
});

// The wrapper itself, in a shell on this computer (BusyBox's in the machine): a real report
const tools = ['sh', 'diff', 'cmp', 'awk', 'find', 'sort', 'tr'].every((t) => {
  try { execFileSync('sh', ['-c', `command -v ${t}`], { stdio: 'ignore' }); return true; } catch { return false; }
});
test('the wrapper reports what a command added, changed and deleted, and measures the next one from there', { skip: !tools && 'no POSIX tools' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgw-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(app, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src', 'App.jsx'), 'one\ntwo\nthree\n');
  fs.writeFileSync(path.join(app, 'gone.txt'), 'bye\n');
  const run = (command, n) => {
    const w = B.wrapCommand(command, app, NONCE + n, { snapshots: path.join(tmp, 'snap') });
    const ws = path.join(tmp, `job${n}`);
    fs.mkdirSync(path.join(ws, 'in'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'in', 'cmd'), w.files.cmd);
    let out;
    let status = 0;
    try {
      out = execFileSync('sh', ['-c', w.command], { cwd: tmp, env: { ...process.env, EXCLAVE_WORKSPACE: ws, LC_ALL: 'C' }, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout;
      status = e.status;
    }
    return { status, ...B.splitChanges(out, NONCE + n) };
  };
  const a = run(`cd ${app} && sed -i.bak 's/two/TWO/' src/App.jsx && rm src/App.jsx.bak && rm gone.txt && echo new >"src/a b.txt" && echo dep >node_modules/x/i.js && echo done; exit 4`, 0);
  assert.equal(a.status, 4);
  assert.equal(a.output, 'done\n');
  assert.deepEqual(a.changes.files.map((f) => [f.status, f.path, f.added, f.removed]),
    [['deleted', 'gone.txt', 0, 1], ['modified', 'src/App.jsx', 1, 1], ['added', 'src/a b.txt', 1, 0]]); // C order, as the guest sorts
  assert.match(a.changes.files[1].diff, /^@@ .* @@\n one\n-two\n\+TWO\n three\n$/);
  // Measured from the last report: nothing changed since
  const b = run('echo again', 1);
  assert.deepEqual([b.status, b.output, b.changes.files.length], [0, 'again\n', 0]);
});

test('undo and revert: each change is kept, undo goes back one step at a time, and start is how the project began', { skip: !tools && 'no POSIX tools' }, () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sgr-'));
  const app = path.join(tmp, 'app');
  fs.mkdirSync(path.join(app, 'src'), { recursive: true });
  fs.mkdirSync(path.join(app, 'node_modules', 'x'), { recursive: true });
  fs.writeFileSync(path.join(app, 'src', 'App.jsx'), 'v1\n');
  const snapshots = path.join(tmp, 'snap');
  let n = 0;
  const run = (command) => {
    const nonce = NONCE + n++;
    const w = B.wrapCommand(command, app, nonce, { snapshots });
    const ws = path.join(tmp, `job${n}`);
    fs.mkdirSync(path.join(ws, 'in'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'in', 'cmd'), w.files.cmd);
    let out;
    let status = 0;
    try {
      out = execFileSync('sh', ['-c', w.command], { cwd: tmp, env: { ...process.env, EXCLAVE_WORKSPACE: ws }, encoding: 'utf8' });
    } catch (e) {
      out = e.stdout;
      status = e.status;
    }
    return { status, ...B.splitChanges(out, nonce) };
  };
  const read = (f) => fs.existsSync(path.join(app, f)) ? fs.readFileSync(path.join(app, f), 'utf8') : null;
  const revert = (to) => run(B.revertCommand(app, to, { snapshots }));
  assert.equal(revert('previous').status, 3); // nothing kept yet
  run(`echo v2 >${app}/src/App.jsx`);
  run(`echo new >${app}/src/New.jsx && echo dep >${app}/node_modules/x/i.js`);
  run('echo nothing changes');
  run(`echo v3 >${app}/src/App.jsx`);
  let r = revert('previous');
  assert.equal(r.status, 0);
  assert.deepEqual(r.changes.files.map((f) => [f.status, f.path]), [['modified', 'src/App.jsx']]);
  assert.equal(read('src/App.jsx'), 'v2\n');
  r = revert('previous');
  assert.deepEqual(r.changes.files.map((f) => [f.status, f.path]), [['deleted', 'src/New.jsx']]);
  assert.equal(read('src/New.jsx'), null);
  assert.equal(read('node_modules/x/i.js'), 'dep\n'); // never touched
  run(`echo v4 >${app}/src/App.jsx && echo b >${app}/src/B.jsx`);
  r = revert('start');
  assert.equal(r.status, 0);
  assert.equal(read('src/App.jsx'), 'v1\n');
  assert.equal(read('src/B.jsx'), null);
  // The revert to start is itself a step: undo brings v4 back
  revert('previous');
  assert.equal(read('src/App.jsx'), 'v4\n');
  assert.equal(read('src/B.jsx'), 'b\n');
  assert.throws(() => B.revertCommand(app, 'sideways'), /previous/);
});

test('the report is taken out of the output: whole, still arriving, or cut off', () => {
  const body = 'SGC_FILE M src/App.jsx\n@@ -1,2 +1,2 @@\n-a\n+b\n c\nSGC_FILE A new.txt\n@@ -0,0 +1 @@\n+x\n';
  const done = B.splitChanges('built\n' + report(body), NONCE);
  assert.equal(done.output, 'built\n');
  assert.deepEqual(done.changes.files.map((f) => [f.status, f.path, f.added, f.removed]), [['modified', 'src/App.jsx', 1, 1], ['added', 'new.txt', 1, 0]]);
  // Under way: the start of the line, or the report without its end
  assert.deepEqual(B.splitChanges('built\n\nSGCHANGES_abc', NONCE), { output: 'built\n', changes: null });
  assert.deepEqual(B.splitChanges(`built\n\nSGCHANGES_${NONCE} BEGIN\nSGC_FILE M x\n`, NONCE), { output: 'built\n', changes: null });
  // Another job's nonce is output like any other
  const other = `x\nSGCHANGES_ffffffffffffffff BEGIN\nSGCHANGES_ffffffffffffffff END\n`;
  assert.deepEqual(B.splitChanges(other, NONCE), { output: other, changes: null });
});

test('the report: large and binary files have no diff, long diffs are cut, and too many files are said', () => {
  const c = B.parseChanges('SGC_FILE A big.bin\nSGC_BIG 300000\nSGC_FILE A b.bin\nSGC_BINARY\nSGC_FILE M long.js\n@@ -1 +1 @@\n-a\n+b\nSGC_CUT 12\nSGC_MORE\n');
  assert.deepEqual(c.files.map((f) => [f.path, f.big, f.binary, f.cut]), [['big.bin', 300000, false, 0], ['b.bin', 0, true, 0], ['long.js', 0, false, 12]]);
  assert.equal(c.more, true);
  assert.equal(B.summary(c), '3+ files: big.bin (added), b.bin (added), long.js (+1 −1), …');
  assert.equal(B.summary({ files: [], more: false }), 'no files changed');
  assert.deepEqual(B.diffLines('@@ -1 +1 @@\n-a\n+b\n c\n\\ No newline at end of file\n').map((l) => l.kind), ['hunk', 'del', 'add', 'ctx', 'note']);
});

// Timers the test moves by hand
function fakeTimers() {
  let t = 0;
  let id = 0;
  const due = new Map();
  return {
    now: () => t,
    setTimeout: (fn, ms) => { due.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout: (i) => due.delete(i),
    next() { return Math.min(...[...due.values()].map((d) => d.at)) - t; },
    async advance(ms) {
      const end = t + ms;
      for (;;) {
        const [i, d] = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0] ?? [];
        if (!d || d.at > end) break;
        due.delete(i);
        t = d.at;
        d.fn();
        for (let k = 0; k < 5; k++) await new Promise((r) => setImmediate(r));
      }
      t = end;
    },
  };
}

test('the rebuild watch: the first build read is the baseline, each new one is heard; it reads often after a change', async () => {
  const timers = fakeTimers();
  let build = { version: 3, state: 'ok' };
  let reads = 0;
  const heard = [];
  const w = new B.BuildWatch({ timers, now: timers.now, slowMs: 5000, fastMs: 500, fastForMs: 3000,
    get: async () => { reads++; return { status: 200, body: JSON.stringify(build) }; }, onBuild: (b) => heard.push(b.version) });
  w.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.version, 3);
  assert.deepEqual(heard, []);
  assert.equal(timers.next(), 500); // just started: often
  await timers.advance(4000); // past fastForMs: rarely from here
  const before = reads;
  await timers.advance(10000);
  assert.ok(reads - before <= 3, `rarely when nothing changes: ${reads - before}`);
  build = { version: 4, state: 'building' };
  w.kick();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(heard, [4]); // a new version: heard, even while building
  build = { version: 5, state: 'ok' };
  await timers.advance(500);
  assert.deepEqual(heard, [4, 5]);
  w.stop();
  await timers.advance(60000);
  assert.deepEqual(heard, [4, 5]);
});

test('the rebuild watch: a server without /__build is said, and nothing reachable is read again later', async () => {
  const timers = fakeTimers();
  let answer = null;
  const w = new B.BuildWatch({ timers, now: timers.now, get: async () => answer });
  w.start();
  await new Promise((r) => setImmediate(r));
  assert.equal(w.supported, null);
  answer = { status: 404, body: 'not watching' };
  await timers.advance(500);
  assert.equal(w.supported, false);
  answer = { status: 200, body: '{"version":1,"state":"ok"}' };
  await timers.advance(5000);
  assert.equal(w.supported, true);
  w.stop();
});

const starter = fs.readFileSync(path.join(__dirname, '../../examples/web/app/src/App.jsx'), 'utf8');

test('the walkthrough applies to the web example\'s starter app, and refuses an app that isn\'t it', () => {
  // Step 1 is sed in the machine: the same edit here
  assert.ok(starter.includes('<h1>Notes</h1>'));
  let t = starter.replace('<h1>Notes</h1>', '<h1>Team notes</h1>');
  for (const step of B.DEMO) for (const a of step.actions) if (a.edit) t = a.apply(t, step.title);
  for (const s of ['done, created_at', 'async function toggle(n)', 'type="checkbox"', 'const [filter, setFilter]', 'shown.map((n) =>', 'aria-pressed={filter === f}']) assert.ok(t.includes(s), s);
  assert.ok(!t.includes('notes.map('));
  assert.throws(() => B.DEMO[1].actions[2].apply('nothing here', 'Add a done column'), /isn't the starter's/);
  // The SQL step can run again (a replay)
  assert.match(B.DEMO[1].actions[0].command, /add column if not exists done/);
  assert.match(B.DEMO[1].actions[0].command, /drop policy if exists "update own notes"/);
});

test('the walkthrough opens web\'s preview, then runs each step through the agent API, waiting for each job and each rebuild', async () => {
  const calls = [];
  let file = starter;
  let n = 0;
  const jobs = new Map();
  const agent = {
    openPreview: async (input, o) => { calls.push(['preview', input.runtime, input.port, o.source]); return { status: 200 }; },
    runCommand: async (input, o) => {
      calls.push(['run', input.runtime, input.command.split('\n')[0].slice(0, 40), o.source]);
      if (input.command.includes('sed -i')) file = file.replace('<h1>Notes</h1>', '<h1>Team notes</h1>');
      const jobId = String(++n);
      jobs.set(jobId, { state: 'exited', exitStatus: 0, runtime: input.runtime, output: input.command.startsWith('cat ') ? file : '' });
      return { jobId };
    },
    readJob: async (id) => jobs.get(id),
    writeFile: async (input, o) => { calls.push(['write', input.runtime, input.path, o.source]); file = input.content; return { bytes: input.content.length }; },
  };
  const said = [];
  let builds = 0;
  await B.playDemo(agent, { say: (t) => said.push(t), waitBuild: async () => { builds++; }, pause: async () => {} });
  assert.deepEqual(calls[0], ['preview', 'web', 4173, 'walkthrough']);
  assert.deepEqual(calls.filter((c) => c[0] !== 'preview').map((c) => c.slice(0, 2).join(' ')),
    ['run web', 'run supabase', 'run web', 'run web', 'write web', 'run web', 'run web', 'write web']);
  assert.ok(calls.every((c) => c[3] === 'walkthrough'));
  assert.equal(builds, 3);
  assert.ok(file.includes('shown.map((n) =>') && file.includes('<h1>Team notes</h1>'));
  assert.match(said.at(-1), /^Done/);
  // A failed command stops it, saying why
  jobs.clear();
  agent.readJob = async () => ({ state: 'exited', exitStatus: 1, runtime: 'web', output: '' });
  await assert.rejects(B.playDemo(agent, { say: () => {}, pause: async () => {} }), /web: the command exited 1/);
});

// Just enough of a document for the feed
function fakeDoc() {
  class El {
    constructor(tag) { Object.assign(this, { tag, children: [], parent: null, className: '', dataset: {}, hidden: false, attrs: {}, listeners: {}, _text: '' }); }
    set textContent(t) { this.children = []; this._text = String(t); }
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(''); }
    append(...xs) { for (const x of xs) { x.parent = this; this.children.push(x); } }
    prepend(x) { x.parent = this; this.children.unshift(x); }
    replaceChildren(...xs) { this.children = []; this._text = ''; this.append(...xs); }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); }
    setAttribute(k, v) { this.attrs[k] = v; }
    addEventListener(ev, fn) { (this.listeners[ev] ??= []).push(fn); }
    all(pred, out = []) { for (const c of this.children) { if (pred(c)) out.push(c); c.all(pred, out); } return out; }
  }
  return { createElement: (t) => new El(t), El };
}

test('the feed: newest first, a run\'s changed files with their diffs, the filter, and an open diff kept open as it is drawn again', () => {
  const doc = fakeDoc();
  const list = doc.createElement('ol');
  const empty = doc.createElement('p');
  const feed = new B.Feed(list, { doc, empty });
  const run = feed.add({ kind: 'run', runtime: 'web', source: 'webmcp', command: 'sed -i s/a/b/ src/App.jsx', state: 'running' });
  feed.add({ kind: 'run', runtime: 'supabase', source: 'webmcp', command: 'psql', state: 'exited', exitStatus: 0 });
  assert.equal(empty.hidden, true);
  assert.equal(list.children.length, 2);
  assert.match(list.children[0].textContent, /supabase, by WebMCP/);
  const changes = B.parseChanges('SGC_FILE M src/App.jsx\n@@ -1 +1 @@\n-a\n+b\n');
  feed.update(run, { state: 'exited', exitStatus: 0, changes });
  const li = list.children[1];
  assert.match(li.textContent, /exit 0/);
  assert.match(li.textContent, /Changed 1 file/);
  const det = li.all((c) => c.tag === 'details')[0];
  assert.equal(det.open, false); // not the newest entry
  det.open = true;
  det.listeners.toggle[0]();
  feed.update(run, {});
  assert.equal(list.children[1].all((c) => c.tag === 'details')[0].open, true);
  const lines = list.children[1].all((c) => c.className === 'dl');
  assert.deepEqual(lines.map((l) => l.dataset.kind), ['hunk', 'del', 'add']);
  assert.equal(list.children[1].all((c) => c.tag === 'pre')[0].attrs['aria-label'], 'Changes to src/App.jsx');
  feed.setFilter('supabase');
  assert.deepEqual(list.children.map((c) => c.hidden), [false, true]);
  feed.add({ kind: 'note', text: 'Step 1' });
  assert.equal(list.children[0].hidden, false); // notes belong to no machine
  assert.equal(list.children[0].all((c) => c.className === 'badge').length, 0); // and no outcome: no "failed" badge
  feed.clear();
  assert.equal(list.children.length, 0);
  assert.equal(empty.hidden, false);
});

test('each feed entry is a step of the agent\'s conversation, titled by what it did', () => {
  const ch = (files, more = false) => ({ files: files.map(([status, path]) => ({ status, path, added: 1, removed: 0 })), more });
  const t = (e) => B.stepOf(e);
  assert.deepEqual(t({ kind: 'run', command: 'write /root/app/src/App.jsx (8 bytes)', changes: ch([['modified', 'src/App.jsx']]) }), { step: 'edit', title: 'Edited src/App.jsx' });
  assert.equal(t({ kind: 'run', command: 'write 2 files', changes: ch([['added', 'a'], ['added', 'b']]) }).title, 'Changed 2 files');
  assert.equal(t({ kind: 'run', command: 'write 1 file', changes: ch([['added', 'src/Card.tsx']]) }).title, 'Created src/Card.tsx');
  assert.equal(t({ kind: 'run', command: 'write 1 file', state: 'running' }).title, 'Writing files…');
  assert.deepEqual(t({ kind: 'run', command: 'npm install zustand' }), { step: 'run', title: 'Ran npm install zustand', code: false });
  assert.deepEqual(t({ kind: 'run', runtime: 'web', command: 'cd /root/app && sed -i "s/a/b/" src/App.jsx && grep -n x src/App.jsx' }), { step: 'run', title: 'Ran a command in web', code: true });
  assert.equal(t({ kind: 'run', runtime: 'supabase', command: 'SQL: alter table notes' }).title, 'Ran SQL on supabase');
  assert.equal(t({ kind: 'run', command: 'undo the last change' }).step, 'undo');
  assert.equal(t({ kind: 'build', state: 'ok', version: 7, ms: 3012 }).title, 'Built version 7 in 3.0 s');
  assert.deepEqual(t({ kind: 'build', state: 'error', version: 8 }), { step: 'build-error', title: 'Build 8 failed' });
  assert.equal(t({ kind: 'read', paths: ['src/App.jsx'] }).title, 'Read src/App.jsx');
  assert.equal(t({ kind: 'read', paths: ['a', 'b'] }).title, 'Read 2 files');
  assert.equal(t({ kind: 'list', path: '/root/app' }).title, 'Looked at the files in /root/app');
  assert.equal(t({ kind: 'note', text: 'Step 1' }).title, 'Step 1');
});
