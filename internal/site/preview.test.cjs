// The preview (preview.js): its routes, HTTP/1.1 over a machine's connection, and the agent page's
// service worker (agent-sw.js) that carries a frame's requests to the page
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const P = require('./preview.js');

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const scope = 'https://x.example/snowglobe/agent/';

test('route: preview/<runtime>/<port>/<path>, under the page only', () => {
  assert.deepEqual(P.route(scope + 'preview/web/4173/assets/a.js?v=1', scope),
    { runtime: 'web', port: 4173, path: '/assets/a.js?v=1', prefix: '/snowglobe/agent/preview/web/4173', slash: true });
  assert.equal(P.route(scope + 'preview/web/4173', scope).slash, false, 'the root without its slash: redirected to it');
  assert.equal(P.route(scope + 'preview/supabase/54321/rest/v1/notes', scope).path, '/rest/v1/notes');
  assert.match(P.route(scope + 'preview/web/0/', scope).error, /not a port/);
  assert.match(P.route(scope + 'preview/web/70000/', scope).error, /not a port/);
  assert.match(P.route(scope + 'preview/Web!/1/', scope).error, /runtime/);
  assert.match(P.route(scope + 'preview/web', scope).error, /preview\/<runtime>/);
  assert.equal(P.route(scope + 'agent-page.js', scope), null);
  assert.equal(P.route('https://x.example/snowglobe/python/', scope), null);
  assert.equal(P.route('https://other.example/snowglobe/agent/preview/web/1/', scope), null);
  assert.equal(P.previewUrl(scope + '?runtime=web', 'web', 4173, '/a'), scope + 'preview/web/4173/a');
  assert.throws(() => P.previewUrl(scope, 'web', 4173, 'a'), /starting with \//);
  assert.throws(() => P.previewUrl(scope, 'web', 4173, '//evil.example/'), /path/);
  assert.throws(() => P.checkPort(99999), /port/);
});

test('the request: HTTP/1.1, Connection: close, identity encoding, no hop-by-hop headers, no line breaks', () => {
  const head = dec(P.requestHead({ method: 'POST', path: '/rest/v1/notes?select=id', port: 54321, bodyLength: 12,
    headers: [['Content-Type', 'application/json'], ['Host', 'evil'], ['Connection', 'keep-alive'], ['Accept-Encoding', 'gzip'], ['apikey', 'k'], ['Content-Length', '999']] }));
  assert.equal(head, 'POST /rest/v1/notes?select=id HTTP/1.1\r\nHost: localhost:54321\r\nContent-Type: application/json\r\napikey: k\r\n' +
    'Accept-Encoding: identity\r\nConnection: close\r\nContent-Length: 12\r\n\r\n');
  assert.equal(dec(P.requestHead({ path: '/', port: 80 })), 'GET / HTTP/1.1\r\nHost: localhost:80\r\nAccept-Encoding: identity\r\nConnection: close\r\n\r\n');
  assert.throws(() => P.requestHead({ path: '/', port: 1, headers: [['X', 'a\r\nX-Smuggled: 1']] }), /line break/);
  assert.throws(() => P.requestHead({ path: '/ HTTP/1.1\r\n', port: 1 }), /not a path/);
  assert.throws(() => P.requestHead({ method: 'GE T', path: '/', port: 1 }), /method/);
});

function parseAll(chunks, opts) {
  const p = new P.ResponseParser(opts);
  const events = [];
  for (const c of chunks) events.push(...p.push(typeof c === 'string' ? enc(c) : c));
  return { p, events };
}
const body = (events) => Buffer.concat(events.filter((e) => e.type === 'data').map((e) => Buffer.from(e.bytes)));

test('a response with a length, split anywhere, binary as it is', () => {
  const bin = new Uint8Array([0, 255, 13, 10, 13, 10, 128, 1]);
  const raw = Buffer.concat([Buffer.from('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nContent-Length: 8\r\n\r\n'), Buffer.from(bin)]);
  // One byte at a time
  const { events } = parseAll([...raw].map((b) => new Uint8Array([b])));
  assert.deepEqual(events[0], { type: 'head', status: 200, statusText: 'OK', headers: [['Content-Type', 'application/octet-stream'], ['Content-Length', '8']] });
  assert.deepEqual([...body(events)], [...bin]);
  assert.equal(events.at(-1).type, 'end');
});

test('a chunked response, its sizes and data split across reads, trailers ignored', () => {
  const { events } = parseAll(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhel', 'lo\r\n', 'a;ext=1\r', '\n world, hi\r\n0\r\nX-Trailer: 1\r\n\r\n']);
  assert.equal(dec(body(events)), 'hello world, hi');
  assert.equal(events.at(-1).type, 'end');
  assert.throws(() => parseAll(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n']), /chunk size/);
});

test('no length: the body runs to the close; 100 Continue skipped; HEAD and 204 have none', () => {
  const { p, events } = parseAll(['HTTP/1.1 100 Continue\r\n\r\nHTTP/1.0 200 OK\r\n\r\nall of ', 'it']);
  assert.equal(events[0].status, 200);
  const rest = p.close();
  assert.equal(dec(body([...events, ...rest])), 'all of it');
  assert.equal(rest.at(-1).type, 'end');
  assert.deepEqual(parseAll(['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\n'], { method: 'HEAD' }).events.map((e) => e.type), ['head', 'end']);
  assert.deepEqual(parseAll(['HTTP/1.1 204 No Content\r\n\r\n']).events.map((e) => e.type), ['head', 'end']);
});

test('cut short or malformed: an error, never a quiet half answer', () => {
  assert.throws(() => parseAll(['HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc']).p.close(), /cut short in its body/);
  assert.throws(() => new P.ResponseParser().close(), /without answering/);
  assert.throws(() => parseAll(['SSH-2.0-OpenSSH\r\n\r\n']), /not an HTTP response/);
  assert.throws(() => parseAll(['HTTP/1.1 200 OK\r\nContent-Length: 1\r\nContent-Length: 2\r\n\r\n']), /Content-Length/);
});

test('Location stays inside the preview; other sites are left alone', () => {
  const ctx = { prefix: '/snowglobe/agent/preview/web/4173', port: 4173, origin: 'https://x.example' };
  assert.equal(P.rewriteLocation('/login?next=/', ctx), '/snowglobe/agent/preview/web/4173/login?next=/');
  assert.equal(P.rewriteLocation('http://localhost:4173/a', ctx), 'https://x.example/snowglobe/agent/preview/web/4173/a');
  assert.equal(P.rewriteLocation('http://127.0.0.1:4173', ctx), 'https://x.example/snowglobe/agent/preview/web/4173/');
  assert.equal(P.rewriteLocation('http://0.0.0.0:4173/x', ctx), 'https://x.example/snowglobe/agent/preview/web/4173/x');
  assert.equal(P.rewriteLocation('http://localhost:9999/a', ctx), 'http://localhost:9999/a', 'another port: not this preview');
  assert.equal(P.rewriteLocation('https://github.com/login', ctx), 'https://github.com/login');
  assert.equal(P.rewriteLocation('//evil.example/', ctx), '//evil.example/');
  assert.equal(P.rewriteLocation('next', ctx), 'next', 'relative: resolves inside already');
  const h = P.responseHeaders([['Location', '/b'], ['Set-Cookie', 'a=1'], ['Transfer-Encoding', 'chunked'], ['Content-Length', '3'], ['X-Ok', '1']], ctx);
  assert.deepEqual(h, [['Location', '/snowglobe/agent/preview/web/4173/b'], ['X-Ok', '1']]);
});

// A machine's connection, scripted: what the server sends once the request has arrived
function fakeOpen({ refuse = false, answer = [], silent = false } = {}) {
  const log = { written: [], aborted: false, port: null };
  const open = (port) => {
    log.port = port;
    const c = {
      write: (b) => {
        log.written.push(dec(b));
        if (log.written.join('').includes('\r\n\r\n') && !c.answered && !silent) {
          c.answered = true;
          setImmediate(() => { for (const a of answer) c.ondata(typeof a === 'string' ? enc(a) : a); c.onclose(); });
        }
      },
      end() {}, abort() { log.aborted = true; },
    };
    setImmediate(() => (refuse ? c.onclose() : c.onconnect()));
    return c;
  };
  return { open, log };
}

test('serve: the request written, the answer streamed back with Location rewritten', async () => {
  const { open, log } = fakeOpen({ answer: ['HTTP/1.1 302 Found\r\nLocation: /next\r\nTransfer-Encoding: chunked\r\n\r\n', '3\r\nabc\r\n0\r\n\r\n'] });
  const sent = [];
  await P.serve(open, { runtime: 'web', port: 4173, method: 'POST', path: '/form', headers: [['Content-Type', 'text/plain']], body: enc('hi'),
    prefix: '/snowglobe/agent/preview/web/4173', origin: 'https://x.example' }, (m) => sent.push(m));
  assert.equal(log.port, 4173);
  assert.match(log.written.join(''), /^POST \/form HTTP\/1\.1\r\nHost: localhost:4173\r\n.*Content-Length: 2\r\n\r\nhi$/s);
  assert.deepEqual(sent.map((m) => m.type), ['head', 'data', 'end']);
  assert.equal(sent[0].status, 302);
  assert.deepEqual(sent[0].headers, [['Location', '/snowglobe/agent/preview/web/4173/next']]);
  assert.equal(dec(sent[1].bytes), 'abc');
});

test('serve: nothing listening is a clear 502; a server that never answers, a 504', async () => {
  const sent = [];
  await P.serve(fakeOpen({ refuse: true }).open, { runtime: 'web', port: 9, method: 'GET', path: '/', prefix: '/p', origin: 'o' }, (m) => sent.push(m));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].type, 'error');
  assert.equal(sent[0].status, 502);
  assert.match(sent[0].body, /Nothing is listening/);
  assert.match(sent[0].body, /0\.0\.0\.0/);

  const late = [];
  await P.serve(fakeOpen({ silent: true }).open, { runtime: 'web', port: 9, method: 'GET', path: '/', prefix: '/p', origin: 'o' }, (m) => late.push(m), { answerMs: 30 });
  assert.equal(late[0].status, 504);
  assert.match(late[0].body, /did not answer/);

  const broken = [];
  await P.serve(fakeOpen({ answer: ['HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc'] }).open,
    { runtime: 'web', port: 9, method: 'GET', path: '/', prefix: '/p', origin: 'o' }, (m) => broken.push(m));
  assert.deepEqual(broken.map((m) => m.type), ['head', 'data', 'abort'], 'cut short after it started: the stream errors');

  const off = [];
  await P.serve(() => { throw new Error('the machine has no network device'); }, { port: 1, method: 'GET', path: '/', prefix: '/p' }, (m) => off.push(m));
  assert.equal(off[0].status, 502);
  assert.match(off[0].body, /no network device/);
});

// ---------------------------------------------------------------- the service worker

function loadWorker({ clients = [] } = {}) {
  const listeners = {};
  const posted = [];
  const fetched = [];
  // The worker's global is its self, as in a browser
  const ctx = vm.createContext({
    registration: { scope },
    addEventListener: (ev, fn) => { listeners[ev] = fn; },
    skipWaiting() {},
    clients: { claim: async () => {}, matchAll: async () => clients.map((c) => ({ ...c, postMessage: (msg, transfer) => { posted.push({ msg, transfer }); c.onmessage?.(msg, transfer); } })) },
    URL, Headers, Response, ReadableStream, MessageChannel, Uint8Array, setTimeout, clearTimeout, Promise, TextEncoder, TextDecoder, console,
    DecompressionStream, TransformStream, DOMException, AbortController, Date,
    importScripts: (name) => vm.runInContext(fs.readFileSync(path.join(__dirname, name), 'utf8'), ctx),
    fetch: async (req) => { fetched.push(req); return new Response('page', { status: 200, headers: { 'Content-Type': 'text/html' } }); },
  });
  vm.runInContext('globalThis.self = globalThis', ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'agent-sw.js'), 'utf8'), ctx);
  const dispatch = (request, ids = {}) => new Promise((resolve) => {
    let responded = false;
    listeners.fetch({ request, clientId: '', resultingClientId: '', ...ids, respondWith: (p) => { responded = true; resolve(Promise.resolve(p)); } });
    if (!responded) resolve(null);
  });
  // A tab's message to the worker
  const message = (data, sourceId) => listeners.message({ data, source: { id: sourceId } });
  return { dispatch, posted, fetched, message };
}
const req = (url, { mode = 'cors', referrer = scope, method = 'GET', destination = '', signal } = {}) =>
  ({ url, mode, referrer, method, destination, signal, headers: new Headers({ Accept: '*/*' }), arrayBuffer: async () => new ArrayBuffer(0) });

test('service worker: the page and its workers isolated; the rest passed through untouched', async () => {
  const { dispatch } = loadWorker();
  const page = await dispatch(req(scope + '?runtime=web', { mode: 'navigate', referrer: '' }));
  assert.equal(page.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(page.headers.get('Cross-Origin-Opener-Policy'), 'same-origin');
  const worker = await dispatch(req(scope + 'machine-worker.js', { destination: 'worker' }));
  assert.equal(worker.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp');
  assert.equal(await dispatch(req('https://x.example/snowglobe/python/system/state.bin.zst')), null, 'a machine\'s files: the network, as ever');
  assert.equal(await dispatch(req('https://blobs.example/abc.bin.zst')), null);
});

test('service worker: a preview request goes to the agent page over a channel, and its answer streams back', async () => {
  const page = { url: scope + '?runtime=web', frameType: 'top-level', focused: true,
    onmessage(msg, [port]) {
      assert.equal(msg.type, 'snowglobe-preview');
      assert.deepEqual([msg.request.runtime, msg.request.port, msg.request.path, msg.request.prefix], ['web', 4173, '/assets/a.js', '/snowglobe/agent/preview/web/4173']);
      port.postMessage({ type: 'taken' });
      port.postMessage({ type: 'head', status: 200, statusText: 'OK', headers: [['Content-Type', 'text/javascript']] });
      port.postMessage({ type: 'data', bytes: enc('let a') });
      port.postMessage({ type: 'data', bytes: enc(' = 1') });
      port.postMessage({ type: 'end' });
    } };
  const { dispatch } = loadWorker({ clients: [{ url: scope + 'preview/web/4173/', frameType: 'nested' }, page] });
  const r = await dispatch(req(scope + 'preview/web/4173/assets/a.js'));
  assert.equal(r.status, 200);
  assert.equal(await r.text(), 'let a = 1');
  assert.equal(r.headers.get('Content-Type'), 'text/javascript');
  assert.equal(r.headers.get('X-Frame-Options'), 'SAMEORIGIN', 'framed by this site only');
  assert.equal(r.headers.get('Cross-Origin-Embedder-Policy'), 'require-corp', 'its frame is isolated as the page is');
});

test('service worker: nothing runs from an address alone', async () => {
  const { dispatch, posted } = loadWorker({ clients: [{ url: scope, frameType: 'top-level', focused: true }] });
  // Typed in, or linked from another site: refused, and the page never asked
  for (const referrer of ['', 'https://evil.example/']) {
    const r = await dispatch(req(scope + 'preview/supabase/54321/rest/v1/notes', { mode: 'navigate', referrer }));
    assert.equal(r.status, 403);
    assert.match(await r.text(), /Open it from the agent page/);
  }
  assert.equal(posted.length, 0);
  // The root without its slash: to it
  const redirect = await dispatch(req(scope + 'preview/web/4173', { mode: 'navigate' }));
  assert.equal(redirect.status, 301);
  assert.equal(redirect.headers.get('Location'), scope + 'preview/web/4173/');
  // No agent page open: said so
  const none = loadWorker();
  const r = await none.dispatch(req(scope + 'preview/web/4173/'));
  assert.equal(r.status, 503);
});

test('service worker: an error page from the agent page is the answer; the address bad, 400', async () => {
  const page = { url: scope, frameType: 'top-level', focused: true,
    onmessage(msg, [port]) { port.postMessage({ type: 'error', ...P.errorPage(502, 'Nothing is listening', 'start a server') }); } };
  const { dispatch } = loadWorker({ clients: [page] });
  const r = await dispatch(req(scope + 'preview/web/4173/'));
  assert.equal(r.status, 502);
  assert.match(await r.text(), /Nothing is listening/);
  const bad = await dispatch(req(scope + 'preview/web/notaport/'));
  assert.equal(bad.status, 400);
});

test('header bytes: written and read as bytes (latin1), not re-encoded as UTF-8', () => {
  const head = P.requestHead({ method: 'GET', path: '/', port: 1, headers: [['X-Name', 'caf\xe9']] });
  const i = head.indexOf(0xe9);
  assert.ok(i > 0, 'é is one byte, 0xE9');
  assert.equal(head[i - 1], 'f'.charCodeAt(0));
  assert.throws(() => P.requestHead({ method: 'GET', path: '/', port: 1, headers: [['X', '€']] }), /not a byte/);
  const bytes = new Uint8Array([...enc('HTTP/1.1 200 OK\r\nX-Name: '), 0x80, 0xe9, ...enc('\r\nContent-Length: 0\r\n\r\n')]);
  const [h] = new P.ResponseParser().push(bytes);
  assert.deepEqual(h.headers[0], ['X-Name', '\x80\xe9'], 'each byte one character, 0x80 included');
});

test('statuses a Response can\'t carry: out of range refused, a reason phrase cleaned, 205 without a body', () => {
  assert.throws(() => new P.ResponseParser().push(enc('HTTP/1.1 099 Odd\r\n\r\n')), /status out of range/);
  assert.throws(() => new P.ResponseParser().push(enc('HTTP/1.1 600 Odd\r\n\r\n')), /status out of range/);
  const [h] = new P.ResponseParser().push(enc('HTTP/1.1 200 O\x01K\x7f\r\nContent-Length: 0\r\n\r\n'));
  assert.equal(h.statusText, 'OK');
  assert.deepEqual(new P.ResponseParser().push(enc('HTTP/1.1 205 Reset Content\r\n\r\n')).map((e) => e.type), ['head', 'end']);
  assert.equal(P.decoding([['Content-Encoding', 'gzip']]), 'gzip');
  assert.equal(P.decoding([['content-encoding', 'deflate']]), 'deflate');
  assert.equal(P.decoding([['Content-Encoding', 'br']]), null, 'one the page can\'t undo: passed on');
  assert.equal(P.decoding([['Content-Encoding', 'gzip'], ['Content-Encoding', 'gzip']]), null);
  assert.equal(P.decoding([]), null);
});

test('serve: a body that stops coming is given up; a stop asked for once the head is in ends it there', async () => {
  // Head and a first byte, then nothing
  let aborted = false;
  const stall = () => {
    const c = { write: (b) => { if (dec(b).endsWith('\r\n\r\n')) setImmediate(() => c.ondata(enc('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\na'))); },
      end() {}, abort() { aborted = true; } };
    setImmediate(() => c.onconnect());
    return c;
  };
  const sent = [];
  await P.serve(stall, { runtime: 'web', port: 1, method: 'GET', path: '/', prefix: '/p', origin: 'o' }, (m) => sent.push(m), { idleMs: 20 });
  assert.deepEqual(sent.map((m) => m.type), ['head', 'data', 'abort']);
  assert.match(sent[2].message, /stopped sending its answer/);
  assert.equal(aborted, true, 'its connection ended');

  // The probe's way: the head, then stop (the body is never read)
  const { open, log } = fakeOpen({ answer: ['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'] });
  const stop = new AbortController();
  const got = [];
  await P.serve(open, { runtime: 'web', port: 1, method: 'GET', path: '/', prefix: '/p', origin: 'o' }, (m) => {
    got.push(m.type);
    if (m.type === 'head') stop.abort();
  }, { signal: stop.signal });
  assert.deepEqual(got, ['head', 'abort']);
  assert.equal(log.aborted, true);
});

// An agent tab that answers every request with `answer(port)`, and keeps what it was sent
function tab(id, { focused = false, answer } = {}) {
  const t = { id, url: scope, frameType: 'top-level', focused, got: [],
    onmessage(msg, [port]) {
      t.got.push(msg.request);
      t.port = port;
      port.onmessage = ({ data }) => { if (data?.type === 'cancel') t.cancelled = true; };
      port.postMessage({ type: 'taken' });
      answer?.(port);
    } };
  return t;
}
const ok = (body = 'hi') => (port) => {
  port.postMessage({ type: 'head', status: 200, statusText: 'OK', headers: [['Content-Type', 'text/plain']] });
  port.postMessage({ type: 'data', bytes: enc(body) });
  port.postMessage({ type: 'end' });
};

test('service worker: a request goes to the tab whose preview frame made it, not the focused one', async () => {
  const a = tab('tab-a', { focused: true, answer: ok('from a') });
  const b = tab('tab-b', { answer: ok('from b') });
  const { dispatch, message } = loadWorker({ clients: [a, b] });
  // b says it is about to load its frame; the navigation (no referrer: the guest's policy) is b's
  const url = scope + 'preview/web/4173/';
  message({ type: 'snowglobe-preview-nav', url }, 'tab-b');
  const nav = await dispatch(req(url, { mode: 'navigate', referrer: '', destination: 'iframe' }), { resultingClientId: 'frame-1' });
  assert.equal(nav.status, 200);
  assert.equal(await nav.text(), 'from b');
  assert.equal(nav.headers.get('Referrer-Policy'), 'same-origin', 'the guest\'s policy can\'t hide where the next navigation comes from');
  // What that frame fetches goes to b too
  const sub = await dispatch(req(url + 'app.js'), { clientId: 'frame-1' });
  assert.equal(await sub.text(), 'from b');
  assert.equal(a.got.length, 0);
  // A frame the worker doesn't know: as before, the focused tab
  const other = await dispatch(req(url + 'x.js'), { clientId: 'frame-unknown' });
  assert.equal(await other.text(), 'from a');
  // Still refused: a top-level navigation from another site, with no tab's word for it
  const evil = await dispatch(req(url, { mode: 'navigate', referrer: 'https://evil.example/' }));
  assert.equal(evil.status, 403);
});

test('service worker: an answer a Response can\'t carry is a 502, never a hang; a compressed body is undone', async () => {
  const bad = tab('t', { focused: true, answer: (port) => port.postMessage({ type: 'head', status: 205, statusText: 'Reset\r\nX', headers: [] }) });
  let r = await loadWorker({ clients: [bad] }).dispatch(req(scope + 'preview/web/1/'));
  assert.equal(r.status, 205, 'a status without a body gets none');
  assert.equal(r.statusText, 'ResetX');
  const odd = tab('t', { focused: true, answer: (port) => port.postMessage({ type: 'head', status: 99, statusText: 'x', headers: [] }) });
  r = await loadWorker({ clients: [odd] }).dispatch(req(scope + 'preview/web/1/'));
  assert.equal(r.status, 502);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(odd.cancelled, true, 'the page is told to stop');

  const zipped = require('node:zlib').gzipSync(Buffer.from('hello, unzipped'));
  const gz = tab('t', { focused: true, answer: (port) => {
    port.postMessage({ type: 'head', status: 200, statusText: 'OK', headers: [['Content-Encoding', 'gzip'], ['Content-Type', 'text/plain']] });
    port.postMessage({ type: 'data', bytes: new Uint8Array(zipped) });
    port.postMessage({ type: 'end' });
  } });
  r = await loadWorker({ clients: [gz] }).dispatch(req(scope + 'preview/web/1/'));
  assert.equal(await r.text(), 'hello, unzipped');
  assert.equal(r.headers.get('Content-Encoding'), null);
});

test('service worker: a request its page gave up on tells the agent page to stop', async () => {
  const t = tab('t', { focused: true });
  const { dispatch } = loadWorker({ clients: [t] });
  const c = new AbortController();
  const pending = dispatch(req(scope + 'preview/web/1/slow', { signal: c.signal }));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(t.got.length, 1);
  c.abort();
  const r = await pending;
  assert.equal(r.status, 504);
  await new Promise((res) => setTimeout(res, 10));
  assert.equal(t.cancelled, true);
});

test('the hook: where it goes in a page, and only in one', () => {
  const tag = P.hookTag('/a/preview-hook.js');
  assert.equal(tag, '<script src="/a/preview-hook.js"></script>');
  assert.equal(P.hookAt('<!doctype html><html lang="en"><head><meta charset="utf-8">'), '<!doctype html><html lang="en"><head>'.length);
  assert.equal(P.hookAt('<!DOCTYPE html>\n<HTML>\n<Head data-x="1">'), '<!DOCTYPE html>\n<HTML>\n<Head data-x="1">'.length);
  assert.equal(P.hookAt('<!doctype html><header>'), 15, 'no <head>: before the first element (<header> is not <head>)');
  assert.equal(P.hookAt('<!doctype html><html><title>x</title>'), 21);
  assert.equal(P.hookAt('<!doctype html><html><head '), -1, 'a <head> tag not finished yet');
  assert.equal(P.hookAt('<!doctype html><html><he'), -1, 'more is needed');
  assert.equal(P.hookAt('<!doctype html><html>', true), 21, 'the whole of it: after <html>');
  assert.equal(P.hookAt('hello', true), 0);
  const want = (o) => P.wantsHook({ navigate: true, method: 'GET', status: 200, headers: [['content-type', 'text/html; charset=utf-8']], ...o });
  assert.equal(want({}), true);
  assert.equal(want({ navigate: false }), false, 'a fetch of HTML is the page\'s business');
  assert.equal(want({ headers: [['content-type', 'application/json']] }), false);
  assert.equal(want({ headers: [['content-type', 'text/html'], ['content-encoding', 'br']] }), false, 'bytes it can\'t read are left alone');
  assert.equal(want({ method: 'HEAD' }), false);
  assert.equal(want({ status: 204 }), false);
});

test('service worker: a page the preview shows gets the hook first in its head; nothing else is touched', async () => {
  const html = (chunks, headers = [['Content-Type', 'text/html; charset=utf-8'], ['Content-Length', '999']]) => tab('t', { focused: true, answer: (port) => {
    port.postMessage({ type: 'head', status: 200, statusText: 'OK', headers });
    for (const c of chunks) port.postMessage({ type: 'data', bytes: typeof c === 'string' ? enc(c) : c });
    port.postMessage({ type: 'end' });
  } });
  const tagText = '<script src="/snowglobe/agent/preview-hook.js"></script>';
  const nav = (t) => loadWorker({ clients: [t] }).dispatch(req(scope + 'preview/web/4173/', { mode: 'navigate', destination: 'iframe' }));
  // Split anywhere, even inside the <head> tag, and UTF-8 after it kept byte for byte
  let r = await nav(html(['<!doctype html><html><he', 'ad><title>Café ☕</title></head><body>hi</body></html>']));
  assert.equal(await r.text(), `<!doctype html><html><head>${tagText}<title>Café ☕</title></head><body>hi</body></html>`);
  assert.equal(r.headers.get('Content-Length'), null, 'its length changed: none is said');
  // Compressed: undone, then the hook
  const zipped = require('node:zlib').gzipSync(Buffer.from('<html><head></head></html>'));
  r = await nav(html([new Uint8Array(zipped)], [['Content-Type', 'text/html'], ['Content-Encoding', 'gzip']]));
  assert.equal(await r.text(), `<html><head>${tagText}</head></html>`);
  // Not a navigation (the app fetching HTML), not HTML, an encoding it can't undo, UTF-16: as they were
  const t = html(['<html><head></head></html>']);
  r = await loadWorker({ clients: [t] }).dispatch(req(scope + 'preview/web/4173/partial.html'));
  assert.equal(await r.text(), '<html><head></head></html>');
  r = await nav(html(['{"a":1}'], [['Content-Type', 'application/json']]));
  assert.equal(await r.text(), '{"a":1}');
  r = await nav(html(['<html><head>'], [['Content-Type', 'text/html'], ['Content-Encoding', 'br']]));
  assert.equal(await r.text(), '<html><head>');
  const utf16 = new Uint8Array([0xff, 0xfe, 0x3c, 0, 0x68, 0]);
  r = await nav(html([utf16]));
  assert.deepEqual([...new Uint8Array(await r.arrayBuffer())], [...utf16]);
  // A short page with no head at all: at its start, after the doctype
  r = await nav(html(['<!doctype html>hello']));
  assert.equal(await r.text(), `<!doctype html>${tagText}hello`);
});
