// What an agent sees of the preview and does in it (inspect.js), on a small fake DOM: the outline
// and its refs, names from labels, hidden things left out, the console of the page shown, the
// actions with the events a page listens for, stale refs, and the preview hook (preview-hook.js)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const I = require('./inspect.js');

// ---------------------------------------------------------------- a fake DOM

class Text {
  constructor(t) { this.nodeType = 3; this.textContent = t; }
}

class El {
  constructor(doc, tag, attrs = {}, kids = []) {
    this.nodeType = 1;
    this.ownerDocument = doc;
    this.tagName = tag.toUpperCase();
    this.attrs = { ...attrs };
    this.childNodes = [];
    this.parentElement = null;
    this.hidden = 'hidden' in attrs;
    this.disabled = 'disabled' in attrs;
    this.type = attrs.type ?? (tag === 'input' ? 'text' : undefined);
    this.checked = 'checked' in attrs;
    this._value = attrs.value ?? '';
    this.events = [];
    this.listeners = {};
    this.style = {};
    for (const k of kids) this.append(k);
  }
  get children() { return this.childNodes.filter((n) => n.nodeType === 1); }
  get isConnected() { for (let e = this; e; e = e.parentElement) if (e === this.ownerDocument.documentElement) return true; return false; }
  get textContent() { return this.childNodes.map((n) => n.textContent).join(''); }
  set textContent(t) { this.childNodes = [new Text(t)]; }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get form() { for (let e = this.parentElement; e; e = e.parentElement) if (e.tagName === 'FORM') return e; return null; }
  get label() { return this.textContent; }
  get selected() { return this.parentElement?.value === this.value; }
  getAttribute(n) { return n in this.attrs ? String(this.attrs[n]) : null; }
  setAttribute(n, v) { this.attrs[n] = String(v); }
  append(...ks) { for (const k of ks) { const n = typeof k === 'string' ? new Text(k) : k; if (n.nodeType === 1) n.parentElement = this; this.childNodes.push(n); } }
  remove() { const p = this.parentElement; if (p) { p.childNodes = p.childNodes.filter((n) => n !== this); this.parentElement = null; } }
  addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn); }
  dispatchEvent(ev) {
    for (let e = this; e; e = e.parentElement) {
      e.events.push(ev.type);
      for (const fn of e.listeners[ev.type] ?? []) fn.call(e, Object.assign(ev, { target: this }));
    }
    return !ev.defaultPrevented;
  }
  focus() { this.ownerDocument.activeElement = this; }
  scrollIntoView() { this.scrolled = true; }
  click() {
    if (this.disabled) return;
    if (this.tagName === 'INPUT' && (this.type === 'checkbox' || this.type === 'radio')) {
      this.checked = this.type === 'radio' ? true : !this.checked;
      this.dispatchEvent(new Event('click', { bubbles: true }));
      this.dispatchEvent(new Event('input', { bubbles: true }));
      this.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    this.dispatchEvent(new Event('click', { bubbles: true }));
  }
  requestSubmit() { this.submitted = (this.submitted ?? 0) + 1; this.dispatchEvent(new Event('submit', { bubbles: true })); }
}
// The value as the element's own prototype has it: what typing goes through
Object.defineProperty(El.prototype, 'value', { get() { return this._value; }, set(v) { this._value = String(v); }, configurable: true });

function page(build) {
  const doc = { title: 'Notes', readyState: 'complete', URL: 'https://x.example/agent/preview/web/4173/', activeElement: null };
  const h = (tag, attrs, ...kids) => new El(doc, tag, attrs ?? {}, kids);
  const win = { HTMLInputElement: El, HTMLTextAreaElement: El, HTMLSelectElement: El, location: { href: doc.URL }, Event,
    getComputedStyle: (el) => ({ display: el.style.display ?? 'block', visibility: 'visible' }) };
  doc.defaultView = win;
  doc.body = h('body', {}, ...build(h));
  doc.documentElement = h('html', {}, h('head', {}, h('script', {}, 'var secret = 1')), doc.body);
  doc.getElementById = (id) => { let f = null; const go = (e) => { if (e.attrs?.id === id) f = e; for (const c of e.children ?? []) if (!f) go(c); }; go(doc.documentElement); return f; };
  doc.querySelector = (sel) => {
    if (/[^\w#.\-\[\]="]/.test(sel)) throw new SyntaxError('bad selector');
    let f = null;
    const m = (e) => sel.startsWith('#') ? e.attrs.id === sel.slice(1) : sel.startsWith('.') ? (e.attrs.class ?? '').split(' ').includes(sel.slice(1)) : e.tagName === sel.toUpperCase();
    const go = (e) => { if (m(e)) f = e; for (const c of e.children) if (!f) go(c); };
    go(doc.body);
    return f;
  };
  return { doc, win, frame: { contentDocument: doc, contentWindow: win }, h };
}

const notes = (h) => [
  h('header', {}, h('h1', {}, 'Notes'), h('nav', { 'aria-label': 'Main' }, h('a', { href: '/about' }, 'About'))),
  h('main', {},
    h('form', { id: 'add' },
      h('label', { for: 'title' }, 'Title'), h('input', { id: 'title', placeholder: 'What to remember' }),
      h('input', { type: 'password', id: 'pw', 'aria-label': 'Password', value: 'hunter2' }),
      h('select', { 'aria-label': 'Colour', value: 'b' }, h('option', { value: 'a' }, 'Red'), h('option', { value: 'b' }, 'Blue')),
      h('button', { type: 'submit' }, 'Add')),
    h('ul', {}, h('li', {}, h('label', {}, h('input', { type: 'checkbox', checked: '' }), ' Buy milk'))),
    h('p', { role: 'alert' }, 'Could not load notes'),
    h('div', { hidden: '' }, h('button', {}, 'Secret')),
    h('button', { 'aria-label': 'Delete', disabled: '' }, h('svg', {})),
    h('p', {}, 'Two notes.')),
];

// ---------------------------------------------------------------- tests

test('the outline: landmarks, headings and controls with refs, names from labels; hidden things left out', () => {
  const { frame } = page(notes);
  const ins = new I.Inspector();
  const s = ins.read(frame);
  assert.equal(s.title, 'Notes');
  const o = s.outline;
  assert.match(o, /^- banner\n  - heading "Notes" \[level 1\]\n  - navigation "Main"\n    - link "About" \[e1\] -> \/about$/m);
  assert.match(o, /- textbox "Title" \[e2\] value="" placeholder="What to remember"/, 'a label for= names the field');
  assert.match(o, /- textbox "Password" \[e3\] value=\(hidden\) type=password/, 'a password is never shown');
  assert.match(o, /- combobox "Colour" \[e4\] value="Blue" options: Red \| Blue/);
  assert.match(o, /- button "Add" \[e5\]/);
  assert.match(o, /- checkbox "Buy milk" \[e6\] checked/, 'a wrapping label names the box, without the box');
  assert.match(o, /- alert "Could not load notes"/, 'an alert is shown with its words');
  assert.match(o, /- button "Delete" \[e7\] disabled/);
  assert.doesNotMatch(o, /Secret/, 'a hidden subtree is left out');
  assert.match(s.text, /Notes\nAbout\nTitle/);
  assert.match(s.text, /Two notes\./);
  assert.doesNotMatch(s.text, /secret = 1|Secret/, 'no script text, nothing hidden');
  // The same element keeps its ref in the next snapshot
  assert.match(ins.read(frame).outline, /button "Add" \[e5\]/);
  // Bounded
  const small = ins.read(frame, { maxChars: 500 });
  assert.ok(small.outline.length + small.text.length <= 520);
});

test('actions: typing goes through the prototype setter with input and change; click, check, select, press', async () => {
  const { frame, doc } = page(notes);
  const ins = new I.Inspector();
  ins.read(frame);
  const title = doc.getElementById('title');
  // A framework's own value property on the instance (React's tracker) is bypassed, as typing does
  let tracked = 0;
  Object.defineProperty(title, 'value', { get() { return this._value; }, set(v) { tracked++; this._value = v; }, configurable: true });
  const form = doc.getElementById('add');
  let r = await I.run(ins, frame, [
    { type: 'type', ref: 'e2', value: 'Buy bread' },
    { type: 'select', ref: 'e4', value: 'Red' },
    { type: 'check', text: 'Buy milk', value: false },
    { type: 'press', ref: 'e2', key: 'Enter' },
    { type: 'click', ref: 'e5' },
  ], { pause: async () => {} });
  assert.equal(r.error, undefined, r.error);
  assert.equal(title.value, 'Buy bread');
  assert.equal(tracked, 0, 'set through the prototype, not the instance');
  assert.deepEqual(title.events.filter((e) => ['input', 'change', 'keydown', 'keyup'].includes(e)), ['input', 'change', 'keydown', 'keyup']);
  assert.equal(doc.querySelector('select').value, 'a');
  assert.equal(doc.querySelector('ul').children[0].children[0].children[0].checked, false);
  assert.equal(form.submitted, 1, 'Enter in a form field submits it');
  const add = form.children.find((c) => c.tagName === 'BUTTON');
  assert.deepEqual(add.events.filter((e) => /pointer|mouse|click/.test(e)), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
  assert.deepEqual(r.done, ['typed "Buy bread" in textbox "Title"', 'selected "Red" in combobox "Colour"', 'unchecked checkbox "Buy milk"',
    'pressed Enter in textbox "Title"', 'clicked button "Add"']);
  assert.equal(I.stepsTitle(r.done), 'Typed "Buy bread", selected "Red", unchecked "Buy milk", pressed Enter, clicked "Add"');

  // It stops at the first that fails, and says why
  r = await I.run(ins, frame, [{ type: 'click', ref: 'e7' }, { type: 'click', ref: 'e5' }], {});
  assert.match(r.error, /action 1 \(click\): button "Delete" is disabled/);
  assert.deepEqual(r.done, []);
  r = await I.run(ins, frame, [{ type: 'type', ref: 'e5', value: 'x' }], {});
  assert.match(r.error, /is not a text field/);
  r = await I.run(ins, frame, [{ type: 'click', selector: '#nope' }], {});
  assert.match(r.error, /nothing in the page matches "#nope"/);
  r = await I.run(ins, frame, [{ type: 'click', text: 'Launch' }], {});
  assert.match(r.error, /no button, link or field labelled "Launch"/);
  r = await I.run(ins, frame, [{ type: 'dance' }], {});
  assert.match(r.error, /type: one of click/);
  await assert.rejects(I.run(ins, frame, []), /actions: a list/);
});

test('refs: one from a re-render is stale, one from before a reload unknown; wait_for appears and goes', async () => {
  const p = page(notes);
  const ins = new I.Inspector();
  ins.read(p.frame);
  // The page re-renders: the button is replaced
  const form = p.doc.getElementById('add');
  const add = form.children.find((c) => c.tagName === 'BUTTON');
  add.remove();
  form.append(p.h('button', {}, 'Add'));
  let r = await I.run(ins, p.frame, [{ type: 'click', ref: 'e5' }], {});
  assert.match(r.error, /ref e5 is stale: the page re-rendered/);
  assert.match(ins.read(p.frame).outline, /button "Add" \[e8\]/, 'the new button gets a new ref');
  // A reload: another document, every ref from before is unknown
  const fresh = page(notes);
  p.frame.contentDocument = fresh.doc;
  r = await I.run(ins, p.frame, [{ type: 'click', ref: 'e8' }], {});
  assert.match(r.error, /not in the latest snapshot/);

  // wait_for: text that comes, a control that goes, and a bounded wait
  const q = page(notes);
  const ins2 = new I.Inspector();
  ins2.read(q.frame);
  setTimeout(() => q.doc.body.append(q.h('p', {}, 'Saved!')), 30);
  r = await I.run(ins2, q.frame, [{ type: 'wait_for', text: 'saved', timeoutMs: 2000 }], { pause: (ms) => new Promise((res) => setTimeout(res, 10)) });
  assert.equal(r.error, undefined);
  assert.match(r.done[0], /"saved" appeared after \d+ ms/);
  r = await I.run(ins2, q.frame, [{ type: 'wait_for', text: 'Never', timeoutMs: 50 }], { pause: (ms) => new Promise((res) => setTimeout(res, 10)) });
  assert.match(r.error, /the text "Never" did not appear within 50 ms/);
  q.doc.getElementById('title').style.display = 'none';
  r = await I.run(ins2, q.frame, [{ type: 'wait_for', ref: 'e2', gone: true, timeoutMs: 100 }], { pause: async () => {} });
  assert.equal(r.error, undefined);
  // A cancelled call stops before its next action
  const c = new AbortController();
  c.abort();
  r = await I.run(ins2, q.frame, [{ type: 'click', ref: 'e5' }], { signal: c.signal });
  assert.match(r.error, /cancelled/);
});

test('the console: entries since the page last loaded, errors kept first, and the snapshot text', () => {
  let now = 1000000;
  const ins = new I.Inspector({ now: () => now });
  ins.log({ level: 'load', text: 'page loaded: /' });
  ins.log({ level: 'error', text: 'old error' });
  now += 1000;
  ins.log({ level: 'load', text: 'page loaded: /' });
  ins.log({ level: 'error', text: 'Uncaught TypeError: notes.map is not a function' });
  ins.log({ level: 'network', text: 'GET /rest/v1/notes -> 404' });
  for (let i = 0; i < 40; i++) ins.log({ level: 'log', text: `log ${i}` });
  now += 3000;
  const c = ins.consoleSince();
  assert.deepEqual(c.counts, { error: 1, warn: 0, network: 1, log: 40 });
  assert.equal(c.lines.length, I.limits.LOG_SHOWN);
  assert.equal(c.lines[0], '[error 3 s ago] Uncaught TypeError: notes.map is not a function', 'errors are kept when there are many');
  assert.ok(!c.lines.some((l) => /old error/.test(l)), 'not from an earlier load');
  const { frame } = page(notes);
  const text = I.snapshotText(ins.read(frame), { build: I.buildText({ version: 3, state: 'ok', ms: 2100 }), consoleInfo: c, path: 'web:4173/' });
  assert.match(text, /^page: web:4173\/  \(title "Notes"\)\nbuild: build 3 ok \(2\.1 s\): the preview shows the latest build\n\noutline/);
  assert.match(text, /console since the page loaded: 1 error, 1 failed request, 40 other/);
  assert.match(text, /\[12 earlier entries not shown\]/);

  assert.match(I.buildText({ version: 4, state: 'error', error: '\nsrc/App.jsx:3: Unexpected token' }), /build 4 FAILED \(src\/App\.jsx:3: Unexpected token\): the preview shows the last build that worked/);
  assert.match(I.buildText({ version: 4, state: 'building' }), /build 5 under way/);
  assert.match(I.buildText({ version: 5, state: 'ok' }, 4), /not reloaded with it yet/);
  assert.match(I.buildText(null), /no build information/);
  // Bounded entries; a load far in the past or future isn't trusted for its time
  ins.log({ level: 'error', text: 'x'.repeat(5000), at: 0 });
  assert.ok(ins.logs.at(-1).text.length <= 600);
  assert.equal(ins.logs.at(-1).at, now);
});

test('the hook: what a framed page logs goes to its same-origin parent; nothing when not framed', async () => {
  const src = fs.readFileSync(path.join(__dirname, 'preview-hook.js'), 'utf8');
  const make = ({ framed = true, sameOrigin = true } = {}) => {
    const posted = [];
    const listeners = {};
    const origLog = [];
    const parent = { postMessage: (m, o) => posted.push([m, o]), location: { origin: sameOrigin ? 'https://x.example' : 'https://evil.example' } };
    const w = {
      location: { origin: 'https://x.example', href: 'https://x.example/agent/preview/web/4173/', pathname: '/agent/preview/web/4173/', search: '' },
      console: { error: (...a) => origLog.push(a), warn() {}, log() {}, info() {}, debug() {} },
      addEventListener: (t, fn) => { listeners[t] = fn; },
      fetch: async (u) => ({ status: u.includes('missing') ? 404 : 200, statusText: u.includes('missing') ? 'Not Found' : 'OK' }),
      Error, JSON, Date, String,
    };
    w.parent = framed ? parent : w;
    w.window = w;
    vm.runInContext(src, vm.createContext(w));
    return { w, posted, listeners, origLog };
  };
  const { w, posted, listeners, origLog } = make();
  assert.equal(posted[0][0].level, 'load');
  assert.equal(posted[0][1], 'https://x.example', 'posted to this origin only');
  w.console.error('boom', { a: 1 });
  assert.deepEqual(origLog, [['boom', { a: 1 }]], 'the page\'s console still gets it');
  listeners.error({ error: new Error('bad'), filename: 'app.js', lineno: 3, colno: 7 });
  listeners.error({ target: { tagName: 'SCRIPT', src: '/assets/x.js' } });
  listeners.unhandledrejection({ reason: 'nope' });
  await w.fetch('/rest/v1/missing');
  await w.fetch('/rest/v1/ok');
  const got = posted.slice(1).map(([m]) => `${m.level}: ${m.text.split('\n')[0]}`);
  assert.deepEqual(got, ['error: boom {"a":1}', 'error: Uncaught Error: bad', 'network: failed to load <script> /assets/x.js',
    'error: Unhandled promise rejection: nope', 'network: GET /rest/v1/missing -> 404 Not Found']);
  assert.ok(posted.every(([m]) => m.type === 'snowglobe-preview-log'));
  assert.equal(make({ framed: false }).posted.length, 0, 'not framed: nothing');
  assert.equal(make({ sameOrigin: false }).posted.length, 0, 'framed by another site: nothing');
});

test('settling: an action that leaves the page waits for the next one to load; one that doesn\'t, for the DOM to be quiet', async () => {
  const a = page(notes);
  const b = page(notes);
  const frame = { contentDocument: a.doc };
  const t0 = Date.now();
  setTimeout(() => { b.doc.readyState = 'complete'; frame.contentDocument = b.doc; }, 120);
  b.doc.readyState = 'loading';
  await I.settle(frame, { before: a.doc, leaving: () => true, quietMs: 10 });
  assert.ok(Date.now() - t0 >= 110, 'waited for the next page');
  assert.equal(frame.contentDocument, b.doc);
  const t1 = Date.now();
  await I.settle({ contentDocument: a.doc }, { before: a.doc, leaving: () => false, quietMs: 10 });
  assert.ok(Date.now() - t1 < 100, 'no navigation: no wait for one');
});

test('check: a controlled box the app puts back at once and sets after its save counts once it is set; never set, a timeout', async () => {
  const { frame, doc } = page(notes);
  const ins = new I.Inspector();
  ins.read(frame);
  const box = doc.querySelector('ul').children[0].children[0].children[0];
  // React's controlled checkbox: the click is reverted at once, the saved state applied 2 s later
  const realClick = box.click.bind(box);
  box.click = () => { const was = box.checked; realClick(); box.checked = was; setTimeout(() => { box.checked = !was; }, 2000); };
  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  let r = await I.run(ins, frame, [{ type: 'check', ref: 'e6', value: false }], { pause });
  assert.equal(r.error, undefined, r.error);
  assert.equal(box.checked, false);
  assert.match(r.done[0], /^unchecked checkbox "Buy milk" \(after \d+ ms\)$/);
  // Never applied: a bounded wait, and what to do next
  box.click = () => {};
  r = await I.run(ins, frame, [{ type: 'check', ref: 'e6', timeoutMs: 300 }], { pause });
  assert.match(r.error, /never became checked within 300 ms .*preview_snapshot/);
});
