// The workspace controls' suspend (session-ui.js), on a page of stand-in elements
const { test } = require('node:test');
const assert = require('node:assert/strict');

// Just enough of a page for SnowglobeSessionUI: every element a stand-in
function element() {
  return {
    disabled: false, hidden: false, inert: false, open: false, value: '', textContent: '', title: '', dataset: {},
    querySelector: () => element(), querySelectorAll: () => [], contains: () => false, addEventListener() {},
    replaceChildren() {}, focus() {},
  };
}
const elements = new Map();
Object.assign(globalThis, {
  document: { getElementById: (id) => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
    addEventListener() {}, activeElement: null, body: null, hidden: false },
  location: { href: 'https://x.example/python/agent.html', origin: 'https://x.example' },
  addEventListener() {},
  requestAnimationFrame: (fn) => setTimeout(fn, 0),
});
require('./sessions.js');
require('./session-ui.js');
const S = globalThis.SnowglobeSessions;

// A stopped machine, and a store that keeps its own copies (as IndexedDB and a folder do)
function setup({ storeFails = false } = {}) {
  const ui = new globalThis.SnowglobeSessionUI({ build: 'b', memory: 256, cpus: 1, network: 'none', scope: '/python/agent' });
  const kept = new Map();
  ui.browser = { settings: async () => {} };
  ui.store = {
    put: async (c) => {
      if (storeFails) throw new Error('quota');
      kept.set(c.id, { ...c, state: new Blob([await c.state.arrayBuffer()]) });
    },
    get: async (id) => kept.get(id),
  };
  ui.active = { version: 1, id: 'w1', name: 'Workspace', config: ui.config };
  ui.vm = { running: false, stop: async () => {}, run() {}, save_state: async () => new Uint8Array([1, 2, 3, 4]) };
  return { ui, kept };
}

test('suspend: what wakes the machine, and this.active, are the copy read back from the store, not the one captured', async () => {
  const { ui, kept } = setup();
  const c = await ui.suspend();
  const stored = kept.get('w1');
  assert.equal(c, stored, 'the wake restores from the copy in the store');
  assert.equal(ui.active, stored, 'this.active holds no copy of its own');
  assert.equal(ui.vm, null);
  assert.deepEqual(new Uint8Array(await (await S.stateBlob(c)).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
});

test('suspend: kept in the page when the store refuses it, the wake still has it', async () => {
  const { ui } = setup({ storeFails: true });
  const before = ui.active;
  const c = await ui.suspend();
  assert.deepEqual(new Uint8Array(await (await S.stateBlob(c)).arrayBuffer()), new Uint8Array([1, 2, 3, 4]));
  assert.equal(ui.active, before, 'not saved: the workspace is still the last one saved');
});

test('suspend: nothing goes on the tape from the capture to the wake', async () => {
  const { ui } = setup();
  ui.record(new Uint8Array([65]));
  const c = await ui.suspend();
  // The old machine's last words and a resize, after the capture: not on the tape
  ui.record(new Uint8Array([66]));
  ui.resize(100, 40);
  ui.resume({ running: true, stop: async () => {}, run() {} });
  ui.record(new Uint8Array([67]));
  const tape = S.consoleEvents(await new Blob(ui.records).arrayBuffer());
  const printed = tape.filter((e) => e.bytes).map((e) => String.fromCharCode(...e.bytes)).join('');
  assert.equal(printed, 'AC');
  assert.ok(!tape.some((e) => e.cols === 100), 'no resize while asleep');
  assert.deepEqual(S.consoleEvents(await c.console.arrayBuffer()).filter((e) => e.bytes).map((e) => String.fromCharCode(...e.bytes)), ['A'],
    'the state saved and its tape agree');
});
