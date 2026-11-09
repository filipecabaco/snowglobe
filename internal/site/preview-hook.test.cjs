// preview-hook.js's WebSocket shim: a preview address's WebSockets go to the framing page over a
// MessageChannel; every other address gets the browser's own WebSocket, untouched
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const src = fs.readFileSync(require.resolve('./preview-hook.js'), 'utf8');

const tick = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };

/** Two linked ports, as a MessageChannel's: what one posts reaches the other's onmessage, later. */
class FakeChannel {
  constructor() {
    const mk = () => ({ onmessage: null, closed: false, got: [], postMessage(data, transfer) { const o = this.other; if (this.closed) return; queueMicrotask(() => { if (!o.closed) { o.got.push({ data, transfer }); o.onmessage?.({ data }); } }); }, close() { this.closed = true; } });
    this.port1 = mk();
    this.port2 = mk();
    this.port1.other = this.port2;
    this.port2.other = this.port1;
  }
}

/** The hook run in a stand-in window: { w, posted (to the parent), warned, RealWS, page() (the
 *  page's port of the last socket), fire(type) }. */
function hookWindow({ framed = true, parentOrigin = 'https://x.example', href = 'https://x.example/snowglobe/agent/preview/web/4173/index.html',
  hookSrc = 'https://x.example/snowglobe/agent/preview-hook.js', timers = globalThis } = {}) {
  const posted = [];
  const warned = [];
  const listeners = {};
  const real = [];
  class RealWS { constructor(...a) { this.args = a; real.push(this); } }
  const parent = { location: { origin: parentOrigin }, postMessage: (msg, origin, transfer) => posted.push({ msg, origin, transfer }) };
  const w = {
    location: new URL(href), document: { currentScript: { src: hookSrc } },
    console: { warn: (...a) => warned.push(a.join(' ')), error() {}, log() {}, info() {}, debug() {} },
    addEventListener: (t, fn) => (listeners[t] ??= []).push(fn),
    WebSocket: RealWS, EventTarget, Event, MessageEvent, CloseEvent, Blob, DOMException, TextEncoder, URL, MessageChannel: FakeChannel,
    setTimeout: (fn, ms) => timers.setTimeout(fn, ms), clearTimeout: (t) => timers.clearTimeout(t),
  };
  w.parent = framed ? parent : w;
  new Function('window', src)(w);
  const sockets = () => posted.filter((p) => p.msg.type === 'snowglobe-preview-socket');
  return { w, posted, sockets, warned, real, RealWS, page: () => sockets().at(-1).transfer[0], fire: (t) => (listeners[t] ?? []).forEach((fn) => fn({ type: t })) };
}

function events(ws) {
  const out = [];
  ws.onopen = () => out.push(['open']);
  ws.onmessage = (e) => out.push(['message', e.data]);
  ws.onerror = () => out.push(['error']);
  ws.onclose = (e) => out.push(['close', e.code, e.reason, e.wasClean]);
  return out;
}

const SB = 'wss://x.example/snowglobe/agent/preview/supabase/54321/realtime/v1/websocket?apikey=anon&vsn=1.0.0';

test('the shim: any other address is the browser\'s own WebSocket, untouched', () => {
  const { w, real, RealWS, sockets } = hookWindow();
  assert.notEqual(w.WebSocket, RealWS, 'replaced');
  for (const url of ['wss://realtime.supabase.co/socket', 'ws://x.example/snowglobe/agent/other', 'wss://x.example/snowglobe/fleet/preview/supabase/54321/',
    'wss://x.example:8443/snowglobe/agent/preview/supabase/54321/', 'wss://x.example/snowglobe/agent/preview/supabase/', 'ws://[not a url']) {
    const ws = new w.WebSocket(url);
    assert.ok(ws instanceof RealWS, url);
    assert.deepEqual(ws.args, [url], 'one argument stays one');
  }
  const two = new w.WebSocket('wss://elsewhere.example/', ['graphql-ws']);
  assert.deepEqual(two.args, ['wss://elsewhere.example/', ['graphql-ws']]);
  assert.ok(two instanceof w.WebSocket, 'instanceof WebSocket still holds for the real one');
  assert.equal(real.length, 7);
  assert.equal(sockets().length, 0, 'none went to the page');
});

test('the shim: a preview address goes to the framing page; open, messages both ways (text, binary, a Blob in order), bufferedAmount, the close handshake', async () => {
  const { w, sockets, page } = hookWindow();
  const ws = new w.WebSocket(SB, ['phoenix']);
  const heard = events(ws);
  assert.ok(ws instanceof w.WebSocket);
  assert.equal(ws.readyState, w.WebSocket.CONNECTING);
  assert.equal(ws.url, SB);
  assert.equal(ws.protocol, '');
  const [{ msg, origin, transfer }] = sockets();
  assert.deepEqual(msg, { type: 'snowglobe-preview-socket', url: 'https://x.example/snowglobe/agent/preview/supabase/54321/realtime/v1/websocket?apikey=anon&vsn=1.0.0', protocols: ['phoenix'] });
  assert.equal(origin, 'https://x.example', 'to this origin only');
  assert.equal(transfer.length, 1, 'the channel\'s other port, handed over');
  assert.throws(() => ws.send('x'), (e) => e.name === 'InvalidStateError');

  const p = page();
  p.postMessage({ type: 'taken' });
  p.postMessage({ type: 'open', protocol: 'phoenix', extensions: '' });
  await tick();
  assert.deepEqual(heard, [['open']]);
  assert.equal(ws.readyState, w.WebSocket.OPEN);
  assert.equal(ws.protocol, 'phoenix');

  p.postMessage({ type: 'message', data: '{"event":"phx_reply"}' });
  p.postMessage({ type: 'message', data: new Uint8Array([1, 2]).buffer });
  await tick();
  assert.equal(heard[1][1], '{"event":"phx_reply"}');
  assert.ok(heard[2][1] instanceof Blob, 'binaryType blob by default');
  ws.binaryType = 'arraybuffer';
  p.postMessage({ type: 'message', data: new Uint8Array([3]).buffer });
  await tick();
  assert.ok(heard[3][1] instanceof ArrayBuffer);

  ws.send('héllo');
  assert.equal(ws.bufferedAmount, 6, 'bytes of UTF-8');
  const buf = new Uint8Array([9, 8, 7]).buffer;
  ws.send(buf);
  ws.send(new Blob(['blob']));
  ws.send(new Uint8Array([0, 5, 6, 0]).subarray(1, 3));
  assert.equal(buf.byteLength, 3, 'the caller\'s buffer kept (a copy is handed over)');
  await tick();
  const sent = p.got.filter((g) => g.data.type === 'send');
  assert.deepEqual(sent.map((g) => (typeof g.data.data === 'string' ? g.data.data : [...new Uint8Array(g.data.data)].join())), ['héllo', '9,8,7', '98,108,111,98', '5,6'], 'in order, the Blob read first');
  assert.deepEqual(sent.map((g) => g.data.n), [6, 3, 4, 2]);
  assert.equal(sent[1].transfer[0], sent[1].data.data, 'binary handed over');
  assert.equal(ws.bufferedAmount, 15);
  for (const n of [6, 3, 4, 2]) p.postMessage({ type: 'sent', n });
  await tick();
  assert.equal(ws.bufferedAmount, 0);

  ws.close(1000, 'bye');
  assert.equal(ws.readyState, w.WebSocket.CLOSING);
  ws.close(); // already closing: nothing
  await tick();
  assert.deepEqual(p.got.filter((g) => g.data.type === 'close').map((g) => g.data), [{ type: 'close', code: 1000, reason: 'bye' }]);
  p.postMessage({ type: 'close', code: 1000, reason: 'bye', wasClean: true });
  await tick();
  assert.deepEqual(heard.at(-1), ['close', 1000, 'bye', true]);
  assert.equal(ws.readyState, w.WebSocket.CLOSED);
  assert.ok(!heard.some(([t]) => t === 'error'));
});

test('the shim: a refusal is an error then a close, and says why in the console; another machine\'s preview and http(s) addresses are carried too', async () => {
  const { w, page, sockets, warned } = hookWindow();
  const ws = new w.WebSocket(SB);
  const heard = events(ws);
  page().postMessage({ type: 'taken' });
  page().postMessage({ type: 'error', message: 'no preview is open' });
  page().postMessage({ type: 'close', code: 1006, reason: '', wasClean: false });
  await tick();
  assert.deepEqual(heard, [['error'], ['close', 1006, '', false]]);
  assert.match(warned.join('\n'), /WebSocket wss:\/\/x\.example\/.* failed: no preview is open/);

  new w.WebSocket('ws://x.example/snowglobe/agent/preview/python/8000/ws');
  assert.equal(sockets().at(-1).msg.url, 'https://x.example/snowglobe/agent/preview/python/8000/ws', 'another machine\'s preview under the same page: the page decides');
  const h = new w.WebSocket('https://x.example/snowglobe/agent/preview/web/4173/hmr');
  assert.equal(h.url, 'wss://x.example/snowglobe/agent/preview/web/4173/hmr', 'http(s) made ws(s)');
  const rel = new w.WebSocket('../../supabase/54321/realtime/v1/websocket');
  assert.equal(sockets().at(-1).msg.url, 'https://x.example/snowglobe/agent/preview/supabase/54321/realtime/v1/websocket', 'relative to the page');
  assert.ok(rel instanceof w.WebSocket);
  assert.throws(() => new w.WebSocket(SB, ['a', 'a']), (e) => e.name === 'SyntaxError');
  assert.throws(() => new w.WebSocket(SB, 'not a token'), (e) => e.name === 'SyntaxError');
  assert.throws(() => new w.WebSocket(SB + '#x'), (e) => e.name === 'SyntaxError');
  assert.throws(() => h.close(1001), (e) => e.name === 'InvalidAccessError');
  assert.throws(() => h.close(1000, 'x'.repeat(124)), (e) => e.name === 'SyntaxError');
  assert.deepEqual([w.WebSocket.CONNECTING, w.WebSocket.OPEN, w.WebSocket.CLOSING, w.WebSocket.CLOSED], [0, 1, 2, 3]);
});

test('the shim: in a tab of its own (or under another site\'s page) a preview address fails at once, cleanly; nothing is posted', async () => {
  for (const o of [{ framed: false }, { parentOrigin: 'https://evil.example' }]) {
    const { w, posted, warned, RealWS } = hookWindow(o);
    const ws = new w.WebSocket(SB);
    const heard = events(ws);
    assert.equal(ws.readyState, w.WebSocket.CLOSED);
    await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(heard, [['error'], ['close', 1006, '', false]]);
    assert.deepEqual(posted, [], 'nothing to any parent');
    assert.match(warned[0], /only inside the page that shows it/);
    assert.ok(new w.WebSocket('wss://elsewhere.example/') instanceof RealWS, 'other addresses as ever');
  }
});

test('the shim: a page that doesn\'t take it in time fails it; the page going away ends its sockets at the other side', async () => {
  const pending = new Map();
  let n = 0;
  const timers = { setTimeout: (fn, ms) => { pending.set(++n, { fn, ms }); return n; }, clearTimeout: (id) => pending.delete(id) };
  const { w, page, fire } = hookWindow({ timers });
  const ws = new w.WebSocket(SB);
  const heard = events(ws);
  const [[, t]] = [...pending];
  assert.equal(t.ms, 5000);
  t.fn();
  assert.deepEqual(heard, [['error'], ['close', 1006, '', false]]);

  const live = new w.WebSocket(SB);
  const p = page();
  p.postMessage({ type: 'taken' });
  p.postMessage({ type: 'open', protocol: '' });
  await tick();
  assert.equal(pending.size, 0, 'taken: no timer left');
  const said = events(live);
  // The page in the frame goes (a navigation, the frame closed): the framing page hears "gone"
  const before = p.got.length;
  fire('pagehide');
  await tick();
  assert.deepEqual(p.got.slice(before).map((g) => g.data), [{ type: 'gone' }]);
  assert.deepEqual(said, [['close', 1001, '', false]]);
  assert.equal(live.readyState, w.WebSocket.CLOSED);
});
