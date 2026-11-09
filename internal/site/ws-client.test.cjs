// ws-client.js: a WebSocket (RFC 6455) spoken over a byte stream, against the RFC's vectors and an
// in-memory server (ws-test-server.cjs) driving whole conversations
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const W = require('./ws-client.js');
const { server, frame, closeBody } = require('./ws-test-server.cjs');

const hex = (b) => Buffer.from(b).toString('hex');
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
/** The next `type` event of a socket. */
const next = (ws, type) => new Promise((resolve) => ws.addEventListener(type, resolve, { once: true }));
/** A client over a new server: { ws, sv, events } (events: what it said, in order). */
function pair(opts = {}, { url = 'ws://feed.internal:8080/live?x=1', protocols, client = {} } = {}) {
  const sv = server(opts);
  const ws = new W.WebSocketClient(url, protocols, { connect: () => sv.connect(), ...client });
  const events = [];
  for (const t of ['open', 'message', 'error', 'close']) {
    ws.addEventListener(t, (e) => events.push(t === 'message' ? ['message', e.data] : t === 'close' ? ['close', e.code, e.reason, e.wasClean] : [t]));
  }
  return { ws, sv, events };
}
async function opened(o, x) {
  const p = pair(o, x);
  await next(p.ws, 'open');
  return p;
}

test('SHA-1 and the accept key: the RFC\'s example, FIPS vectors, and node\'s own digest for every length around a block', () => {
  assert.equal(W.acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'RFC 6455 1.3');
  assert.equal(hex(W.sha1(new Uint8Array(0))), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(hex(W.sha1(Buffer.from('abc'))), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(hex(W.sha1(Buffer.from('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'))), '84983e441c3bd26ebaae4aa1f95129e5e54670f1');
  for (let n = 0; n < 200; n++) {
    const b = crypto.randomBytes(n);
    assert.equal(hex(W.sha1(b)), crypto.createHash('sha1').update(b).digest('hex'), `length ${n}`);
  }
  assert.equal(hex(W.sha1(Buffer.alloc(1e6, 'a'))), '34aa973cd4c4daa4f61eeb2bdbad27316534016f', 'a million a\'s');
});

test('frames: RFC 6455 5.7\'s examples, encoded and decoded (whole, and a byte at a time)', () => {
  const hello = Buffer.from('Hello');
  const mask = [0x37, 0xfa, 0x21, 0x3d];
  assert.equal(hex(W.encodeFrame(1, hello)), '810548656c6c6f', 'a single-frame unmasked text message');
  assert.equal(hex(W.encodeFrame(1, hello, { mask })), '818537fa213d7f9f4d5158', 'a single-frame masked text message');
  assert.equal(hex(W.encodeFrame(1, Buffer.from('Hel'), { fin: false })) + hex(W.encodeFrame(0, Buffer.from('lo'))), '010348656c80026c6f', 'a fragmented unmasked text message');
  assert.equal(hex(W.encodeFrame(9, hello)), '890548656c6c6f', 'an unmasked ping');
  assert.equal(hex(W.encodeFrame(10, hello, { mask })), '8a8537fa213d7f9f4d5158', 'a masked pong');
  assert.equal(hex(W.encodeFrame(2, Buffer.alloc(256)).subarray(0, 4)), '827e0100', '256 bytes: a 16-bit length');
  assert.equal(hex(W.encodeFrame(2, Buffer.alloc(65536)).subarray(0, 10)), '827f0000000000010000', '64 KiB: a 64-bit length');
  assert.equal(hex(W.encodeFrame(2, Buffer.alloc(125)).subarray(0, 2)), '827d', '125 bytes: still 7 bits');
  assert.equal(hex(W.encodeFrame(2, Buffer.alloc(65535)).subarray(0, 4)), '827effff');

  const read = (bytes, o) => new W.FrameDecoder(o).push(new Uint8Array(bytes));
  let [f] = read(Buffer.from('810548656c6c6f', 'hex'));
  assert.deepEqual({ ...f, payload: Buffer.from(f.payload).toString() }, { fin: true, opcode: 1, payload: 'Hello' });
  [f] = read(Buffer.from('818537fa213d7f9f4d5158', 'hex'), { masked: true });
  assert.equal(Buffer.from(f.payload).toString(), 'Hello', 'a client\'s masked frame, unmasked (as a server reads it)');
  const frags = read(Buffer.from('010348656c80026c6f', 'hex'));
  assert.deepEqual(frags.map((x) => [x.fin, x.opcode, Buffer.from(x.payload).toString()]), [[false, 1, 'Hel'], [true, 0, 'lo']]);
  // A byte at a time: nothing until a frame is whole
  const d = new W.FrameDecoder();
  const big = Buffer.concat([W.encodeFrame(2, Buffer.alloc(70000, 7)), W.encodeFrame(9, hello)]);
  const got = [];
  for (const b of big) got.push(...d.push(new Uint8Array([b])));
  assert.equal(got.length, 2);
  assert.equal(got[0].payload.length, 70000);
  assert.ok(got[0].payload.every((x) => x === 7));
  assert.equal(got[1].opcode, 9);
});

test('frames: what must fail the connection, with its code', () => {
  const bad = (bytes, code, re, o) => assert.throws(() => new W.FrameDecoder(o).push(new Uint8Array(bytes)), (e) => e.code === code && re.test(e.message));
  bad([0xc1, 0x00], 1002, /reserved bits/);
  bad([0x83, 0x00], 1002, /unknown opcode 3/);
  bad([0x8b, 0x00], 1002, /unknown opcode 11/);
  bad([0x09, 0x00], 1002, /control frame fragmented/);
  bad([0x89, 0x7e, 0x00, 0x7e], 1002, /over 125/);
  bad([0x81, 0x81, 1, 2, 3, 4, 5], 1002, /masked frame from the server/);
  bad([0x81, 0x01, 0x41], 1002, /unmasked frame from a client/, { masked: true });
  bad([0x82, 0x7f, 0x80, 0, 0, 0, 0, 0, 0, 0], 1002, /top bit/);
  bad([0x82, 0x7e, 0x04, 0x00], 1009, /1024 bytes, over the 1000/, { maxFrame: 1000 });
  // Close frames
  assert.deepEqual(W.parseClose(new Uint8Array(0)), { code: 1005, reason: '' });
  assert.deepEqual(W.parseClose(closeBody(1000, 'bye')), { code: 1000, reason: 'bye' });
  assert.deepEqual(W.parseClose(closeBody(4999)), { code: 4999, reason: '' });
  for (const code of [999, 1004, 1005, 1006, 1015, 1100, 2999, 5000]) assert.throws(() => W.parseClose(closeBody(code)), (e) => e.code === 1002, String(code));
  assert.throws(() => W.parseClose(new Uint8Array([3])), (e) => e.code === 1002);
  assert.throws(() => W.parseClose(closeBody(1000, Buffer.from([0xff]))), (e) => e.code === 1007);
});

test('a whole conversation: the handshake as sent, open, text and binary both ways, a fragmented message, ping and pong, the server\'s close', async () => {
  const { ws, sv, events } = pair({}, { protocols: ['phoenix', 'v2'], client: { origin: 'https://x.example' } });
  assert.equal(ws.readyState, W.WebSocketClient.CONNECTING);
  assert.equal(ws.url, 'ws://feed.internal:8080/live?x=1');
  await next(ws, 'open');
  const { line, headers } = sv.head;
  assert.equal(line, 'GET /live?x=1 HTTP/1.1');
  assert.equal(headers.host, 'feed.internal:8080', 'Host with its port');
  assert.equal(headers.upgrade, 'websocket');
  assert.equal(headers.connection, 'Upgrade');
  assert.match(headers['sec-websocket-key'], /^[A-Za-z0-9+/]{22}==$/, '16 random bytes, base64');
  assert.equal(Buffer.from(headers['sec-websocket-key'], 'base64').length, 16);
  assert.equal(headers['sec-websocket-version'], '13');
  assert.equal(headers.origin, 'https://x.example');
  assert.equal(headers['sec-websocket-protocol'], 'phoenix, v2');
  assert.equal(headers['sec-websocket-extensions'], undefined, 'no extension offered');
  assert.equal(ws.readyState, W.WebSocketClient.OPEN);
  assert.equal(ws.protocol, 'phoenix');
  assert.equal(ws.extensions, '');

  ws.send('{"topic":"realtime:x","event":"phx_join"}');
  ws.send(new Uint8Array([1, 2, 3]).buffer);
  const view = new Uint8Array([9, 9, 4, 5, 9]).subarray(2, 4);
  ws.send(view);
  ws.send(new Blob([Buffer.from('blob!')]));
  ws.send('après');
  await settle();
  assert.deepEqual(sv.received.map((r) => (typeof r === 'string' ? r : hex(r))), ['{"topic":"realtime:x","event":"phx_join"}', '010203', '0405', hex(Buffer.from('blob!')), 'après'], 'in order, a Blob\'s too');
  assert.equal(sv.unmasked, false, 'every client frame masked');
  assert.ok(new Set(sv.frames.map((f) => hex(f.mask))).size > 1, 'a fresh mask per frame');

  sv.send('hi');
  sv.send(Buffer.from([7, 8]));
  await settle();
  assert.deepEqual(events.slice(1, 2), [['message', 'hi']]);
  assert.ok(events[2][1] instanceof Blob, 'binaryType blob by default');
  assert.equal(hex(Buffer.from(await events[2][1].arrayBuffer())), '0708');
  ws.binaryType = 'arraybuffer';
  ws.binaryType = 'nonsense';
  assert.equal(ws.binaryType, 'arraybuffer');
  sv.send(Buffer.from([1]));
  sv.raw(frame(1, 'Hel', { fin: false }));
  sv.raw(frame(9, 'beat')); // a ping between the fragments
  sv.raw(frame(0, 'lo, ', { fin: false }));
  sv.raw(frame(0, 'wörld'));
  await settle();
  assert.ok(events[3][1] instanceof ArrayBuffer);
  assert.deepEqual(events[4], ['message', 'Hello, wörld']);
  assert.deepEqual(sv.pongs.map(String), ['beat'], 'ping answered with a pong of the same payload');

  sv.close(1000, 'bye');
  const close = await next(ws, 'close');
  assert.deepEqual([close.code, close.reason, close.wasClean], [1000, 'bye', true]);
  assert.deepEqual(sv.gotClose, { code: 1000, reason: '' }, 'its close echoed: the code');
  assert.equal(ws.readyState, W.WebSocketClient.CLOSED);
  assert.ok(!events.some(([t]) => t === 'error'));
});

test('the client\'s close: the closing handshake, a code and reason; a server that never answers is dropped after the timeout', async () => {
  const { ws, sv } = await opened();
  ws.close(4000, 'done');
  assert.equal(ws.readyState, W.WebSocketClient.CLOSING);
  ws.send('dropped');
  assert.equal(ws.bufferedAmount, 7, 'counted, as a WebSocket does, never sent');
  sv.send('after close: dropped');
  const close = await next(ws, 'close');
  assert.deepEqual([close.code, close.reason, close.wasClean], [4000, 'done', true]);
  assert.deepEqual(sv.gotClose, { code: 4000, reason: 'done' });
  assert.deepEqual(sv.received, []);
  ws.close(); // over: nothing

  const quiet = await opened({ echoClose: false }, { client: { closeMs: 20 } });
  const events = [];
  quiet.ws.onerror = () => events.push('error');
  quiet.ws.onclose = (e) => events.push(['close', e.code, e.wasClean]);
  quiet.ws.close();
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(events, [['close', 1006, false]], 'no answer to the close: dropped');
  assert.deepEqual(quiet.sv.gotClose, { code: null, reason: '' }, 'close() with no code: an empty close frame');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(quiet.sv.aborted, true, 'the connection let go');
});

test('handshake failures: each one an error, then close 1006, with what went wrong', async () => {
  const fails = async (opts, re, x = {}) => {
    const { ws, events } = pair(opts, x);
    await next(ws, 'close');
    assert.deepEqual(events, [['error'], ['close', 1006, '', false]], String(re));
    assert.match(ws.failure, re);
    assert.equal(ws.readyState, W.WebSocketClient.CLOSED);
  };
  const ok = (key, extra = '') => `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n${extra}\r\n`;
  await fails({ respond: () => 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n' }, /answered 403 Forbidden, not 101/);
  await fails({ respond: () => ok('d3Jvbmc=') }, /Sec-WebSocket-Accept is wrong/);
  await fails({ respond: (h, key) => ok(key).replace('Upgrade: websocket\r\n', '') }, /Upgrade is not websocket/);
  await fails({ respond: (h, key) => ok(key).replace('Connection: Upgrade', 'Connection: keep-alive') }, /Connection has no Upgrade/);
  await fails({ respond: (h, key) => ok(key, 'Sec-WebSocket-Extensions: permessage-deflate\r\n') }, /extension none was offered/);
  await fails({ protocol: () => 'mqtt' }, /subprotocol not offered: mqtt/, { protocols: ['phoenix'] });
  await fails({ protocol: () => undefined }, /none of the subprotocols/, { protocols: ['phoenix'] });
  await fails({ respond: (h, key) => ok(key, 'Sec-WebSocket-Protocol: phoenix\r\n') }, /subprotocol not offered: phoenix/);
  await fails({ respond: () => 'HTTP/1.0 101 Switching Protocols\r\n\r\n' }, /not an HTTP\/1.1 answer/);
  await fails({ respond: () => `HTTP/1.1 101 OK\r\nX: ${'a'.repeat(20000)}` }, /too long/);
  await fails({ refuse: true }, /the connection closed/);
  await fails({ respond: () => null }, /no handshake within 0.02 s/, { client: { handshakeMs: 20 } });
  const thrown = new W.WebSocketClient('ws://x/', [], { connect: () => { throw new Error('the machine is not running'); } });
  await next(thrown, 'close');
  assert.match(thrown.failure, /could not connect: the machine is not running/);
  // What a server says after a good handshake, in the same bytes, is the first message
  const both = pair({ respond: (h, key) => ok(key) + frame(1, 'first').toString('latin1') });
  const m = await next(both.ws, 'message');
  assert.equal(m.data, 'first');
});

test('protocol errors after open: a close frame with the code where one can be sent, then error and close 1006', async () => {
  const fails = async (send, code, re, opts = {}, client = {}) => {
    const { ws, sv, events } = await opened(opts, { client });
    send(sv);
    await next(ws, 'close');
    await settle();
    assert.deepEqual(events.slice(1), [['error'], ['close', 1006, '', false]], String(re));
    assert.match(ws.failure, re);
    assert.equal(sv.gotClose?.code ?? null, code, `close frame ${code}`);
  };
  await fails((sv) => sv.raw(frame(1, Buffer.from([0xc3, 0x28]))), 1007, /not UTF-8/);
  await fails((sv) => sv.raw(frame(1, Buffer.alloc(2000, 0x41))), 1009, /over the 1000/, {}, { maxMessage: 1000 });
  await fails((sv) => { sv.raw(frame(2, Buffer.alloc(600), { fin: false })); sv.raw(frame(0, Buffer.alloc(600))); }, 1009, /a message over 1000 bytes/, {}, { maxMessage: 1000 });
  await fails((sv) => sv.raw(frame(0, 'x')), 1002, /continuation frame with no message/);
  await fails((sv) => { sv.raw(frame(1, 'a', { fin: false })); sv.raw(frame(1, 'b')); }, 1002, /new message inside a fragmented one/);
  await fails((sv) => sv.raw(frame(8, Buffer.from([3]))), 1002, /close frame of 1 byte/);
  await fails((sv) => sv.raw(frame(8, closeBody(1005))), 1002, /close code that can't be sent: 1005/);
  await fails((sv) => sv.raw(frame(8, closeBody(1000, Buffer.from([0xff])))), 1007, /close reason that is not UTF-8/);
  await fails((sv) => sv.raw(frame(1, 'x', { mask: [1, 2, 3, 4] })), 1002, /masked frame from the server/);
  await fails((sv) => sv.raw(frame(1, 'x', { rsv: 4 })), 1002, /reserved bits/);
  // A connection that just ends: no close frame to send, error and close 1006
  const { ws, sv, events } = await opened();
  sv.closeTcp();
  await next(ws, 'close');
  assert.deepEqual(events.slice(1), [['error'], ['close', 1006, '', false]]);
  const e = await opened();
  e.sv.fail(new Error('the machine was put away'));
  await next(e.ws, 'close');
  assert.match(e.ws.failure, /put away/);
});

test('the WebSocket API: constants, the constructor\'s checks, send while connecting, close\'s checks, handlers and listeners', async () => {
  const C = W.WebSocketClient;
  assert.deepEqual([C.CONNECTING, C.OPEN, C.CLOSING, C.CLOSED], [0, 1, 2, 3]);
  assert.equal(C.prototype.OPEN, 1);
  const connect = () => server().connect();
  const syntax = (url, protocols) => assert.throws(() => new C(url, protocols, { connect }), (e) => e.name === 'SyntaxError', `${url} ${protocols}`);
  syntax('not a url');
  syntax('ftp://x/');
  syntax('ws://x/#frag');
  syntax('ws://x/', ['a', 'a']);
  syntax('ws://x/', 'has space');
  syntax('ws://x/', ['']);
  assert.throws(() => new C('ws://x/', []), TypeError, 'a stream is needed');
  assert.equal(new C('https://x.example/a', undefined, { connect }).url, 'wss://x.example/a', 'http(s) made ws(s)');
  assert.equal(new C('/rel', undefined, { connect, base: 'http://x.example/dir/' }).url, 'ws://x.example/rel');

  const { ws, sv } = pair({ echo: true });
  assert.throws(() => ws.send('x'), (e) => e.name === 'InvalidStateError');
  assert.throws(() => ws.close(1001), (e) => e.name === 'InvalidAccessError', 'a script may only send 1000 or 3000 to 4999');
  assert.throws(() => ws.close(2999), (e) => e.name === 'InvalidAccessError');
  assert.throws(() => ws.close(1000, 'x'.repeat(124)), (e) => e.name === 'SyntaxError');
  assert.equal(ws.onopen, null);
  const heard = [];
  const first = () => heard.push('first');
  ws.onopen = first;
  assert.equal(ws.onopen, first);
  ws.onopen = () => heard.push('second'); // replaced, not added
  ws.addEventListener('open', () => heard.push('listener'));
  const removed = () => heard.push('removed');
  ws.addEventListener('open', removed);
  ws.removeEventListener('open', removed);
  ws.addEventListener('open', { handleEvent: () => heard.push('object') });
  await next(ws, 'open');
  assert.deepEqual(heard, ['second', 'listener', 'object']);
  ws.onopen = null;
  assert.equal(ws.onopen, null);
  ws.onmessage = function (e) { heard.push([this === ws, e.target === ws, e.type, e.data]); };
  ws.send('ping');
  await settle();
  assert.deepEqual(heard.at(-1), [true, true, 'message', 'ping'], 'this and target are the socket; an echo');
  assert.equal(sv.head.headers.origin, undefined, 'no Origin unless given');
  assert.equal(sv.head.headers.host, 'feed.internal:8080');

  // close() while connecting: error and close 1006, nothing sent
  const early = pair();
  early.ws.close();
  assert.equal(early.ws.readyState, C.CLOSING);
  await next(early.ws, 'close');
  assert.deepEqual(early.events, [['error'], ['close', 1006, '', false]]);
  assert.equal(early.ws.readyState, C.CLOSED);
});

test('bufferedAmount: what was sent and not yet taken by the stream, down to 0 as it is', async () => {
  const { ws, sv } = await opened({ writeMs: 20 });
  ws.send('12345');
  ws.send(new Uint8Array(1000));
  assert.equal(ws.bufferedAmount, 1005);
  const taken = ws.send(new Blob(['abc']));
  assert.equal(ws.bufferedAmount, 1008);
  assert.equal(await taken, true, 'send\'s promise: taken');
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(ws.bufferedAmount, 0);
  assert.deepEqual(sv.received.map((r) => r.length), [5, 1000, 3]);
  // A close() behind a Blob being read waits for it: what was sent before it goes first
  const b = await opened();
  b.ws.send(new Blob(['last words']));
  b.ws.close(1000);
  await next(b.ws, 'close');
  assert.deepEqual(b.sv.received.map(String), ['last words']);
  assert.deepEqual(b.sv.gotClose, { code: 1000, reason: '' });
});

test('a large message in small pieces (a TCP segment at a time), and one with a 64-bit length each way', async () => {
  const { ws, sv } = await opened();
  ws.binaryType = 'arraybuffer';
  const big = crypto.randomBytes(200000);
  const f = frame(2, big);
  for (let i = 0; i < f.length; i += 1460) sv.raw(f.subarray(i, i + 1460));
  const m = await next(ws, 'message');
  assert.equal(Buffer.compare(Buffer.from(m.data), big), 0);
  assert.equal(m.data.byteLength, m.data.constructor === ArrayBuffer ? 200000 : -1, 'an ArrayBuffer of exactly the message');
  ws.send(big);
  await settle();
  assert.equal(Buffer.compare(sv.received[0], big), 0);
  assert.equal(sv.frames[0].payload.length, 200000);
});
