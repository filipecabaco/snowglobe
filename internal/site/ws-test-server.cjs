// For the tests: a WebSocket server in memory (RFC 6455's server side), written apart from
// ws-client.js (its accept key from node's crypto, its frames from Buffers), and the byte stream a
// client speaks over to it, shaped as machine-host.js's tcpOpen() is.
const crypto = require('node:crypto');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const accept = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

/** A server frame's bytes (unmasked unless `mask`). */
function frame(opcode, payload = Buffer.alloc(0), { fin = true, mask = null, rsv = 0, len } = {}) {
  payload = Buffer.from(payload);
  const n = len ?? payload.length;
  let head;
  if (n < 126) head = Buffer.from([0, n]);
  else if (n < 65536) { head = Buffer.alloc(4); head[1] = 126; head.writeUInt16BE(n, 2); }
  else { head = Buffer.alloc(10); head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = (fin ? 0x80 : 0) | (rsv << 4) | opcode;
  if (mask) {
    head[1] |= 0x80;
    const body = Buffer.from(payload.map((b, i) => b ^ mask[i & 3]));
    return Buffer.concat([head, Buffer.from(mask), body]);
  }
  return Buffer.concat([head, payload]);
}

const closeBody = (code, reason = '') => {
  if (code === undefined) return Buffer.alloc(0);
  const b = Buffer.alloc(2);
  b.writeUInt16BE(code);
  return Buffer.concat([b, Buffer.isBuffer(reason) ? reason : Buffer.from(reason)]);
};

/**
 * A server, and `stream` (the client's side of the connection to it). Options: respond(head,
 * accept) → the handshake answer's text (default: a correct 101, with `protocol(offered)`'s choice);
 * refuse (nothing listens: closed with no connect); echo (messages sent back); echoClose (default
 * true: a client's close answered with one, and the TCP connection closed after it); writeMs (each
 * write resolves after this long: the guest taking its time).
 */
function server(opts = {}) {
  const sv = { head: null, received: [], frames: [], pongs: [], gotClose: null, sentClose: false, clientEnded: false, aborted: false, unmasked: false, written: 0 };
  let buf = Buffer.alloc(0);
  let upgraded = false;
  const later = (fn) => setImmediate(fn);
  const stream = {
    onconnect: null, ondata: null, onend: null, onclose: null, onerror: null,
    write(bytes) {
      const b = Buffer.from(bytes);
      sv.written += b.length;
      later(() => sv._in(b));
      return opts.writeMs ? new Promise((r) => setTimeout(() => r(true), opts.writeMs)) : undefined;
    },
    end() { sv.clientEnded = true; },
    abort() { sv.aborted = true; },
  };
  sv.stream = stream;
  sv.connect = () => { later(() => (opts.refuse ? stream.onclose?.() : stream.onconnect?.())); return stream; };
  sv.raw = (bytes) => later(() => stream.ondata?.(new Uint8Array(bytes)));
  sv.send = (data, o) => sv.raw(frame(typeof data === 'string' ? 1 : 2, Buffer.from(data), o));
  sv.close = (code, reason) => { sv.sentClose = true; sv.raw(frame(8, closeBody(code, reason))); };
  sv.closeTcp = () => later(() => stream.onclose?.());
  sv.endTcp = () => later(() => stream.onend?.());
  sv.fail = (e) => later(() => stream.onerror?.(e));
  sv._in = (b) => {
    buf = Buffer.concat([buf, b]);
    if (!upgraded) {
      const i = buf.indexOf('\r\n\r\n');
      if (i < 0) return;
      const text = buf.subarray(0, i).toString('latin1');
      buf = buf.subarray(i + 4);
      const [line, ...hs] = text.split('\r\n');
      const headers = {};
      for (const h of hs) headers[h.slice(0, h.indexOf(':')).toLowerCase()] = h.slice(h.indexOf(':') + 1).trim();
      sv.head = { line, headers, text };
      const key = accept(headers['sec-websocket-key'] ?? '');
      let answer;
      if (opts.respond) answer = opts.respond(sv.head, key);
      else {
        const offered = (headers['sec-websocket-protocol'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
        const chosen = opts.protocol ? opts.protocol(offered) : offered[0];
        answer = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${key}\r\n${chosen ? `Sec-WebSocket-Protocol: ${chosen}\r\n` : ''}\r\n`;
      }
      if (answer === null) return;
      sv.raw(Buffer.from(answer, 'latin1'));
      upgraded = true;
    }
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); at = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); at = 10; }
      if (!masked) sv.unmasked = true;
      const mask = masked ? buf.subarray(at, at + 4) : null;
      if (masked) at += 4;
      if (buf.length < at + len) return;
      const payload = Buffer.from(buf.subarray(at, at + len).map((x, i) => (mask ? x ^ mask[i & 3] : x)));
      buf = buf.subarray(at + len);
      sv.frames.push({ fin, opcode, payload, mask: mask && Buffer.from(mask) });
      if (opcode === 8) {
        sv.gotClose = payload.length >= 2 ? { code: payload.readUInt16BE(0), reason: payload.subarray(2).toString() } : { code: null, reason: '' };
        if (opts.echoClose !== false) {
          if (!sv.sentClose) sv.close(sv.gotClose.code ?? undefined, sv.gotClose.reason);
          sv.closeTcp();
        }
      } else if (opcode === 10) sv.pongs.push(payload);
      else if (opcode === 1 || opcode === 2) {
        sv.received.push(opcode === 1 ? payload.toString() : payload);
        if (opts.echo) sv.send(opcode === 1 ? payload.toString() : payload);
      }
    }
  };
  return sv;
}

module.exports = { server, frame, closeBody, accept, GUID };
