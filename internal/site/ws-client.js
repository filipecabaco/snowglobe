// A WebSocket client (RFC 6455) spoken by this code over any duplex byte stream, for the two places
// where the browser's own WebSocket can't be used:
//  - a machine's guest opening a WebSocket to a link's name on port 80 or 443 (armless hands such a
//    WebSocket to the page's WebSocket class with its real url, ws://feed.internal/path): the
//    machine's LinkSocket (machine-core.js) speaks it over the link's TCP pipe to the machine it
//    links to;
//  - a page in the preview opening a WebSocket to a machine (preview-hook.js's shim): the page that
//    runs the machines (orchestrator.js's previewSocket) speaks it over a TCP connection into the
//    machine (host.tcpOpen) and passes the messages on.
//
// The stream is { write(bytes) (may return a promise: resolved once taken), end(), abort(), and the
// callbacks onconnect, ondata(bytes), onend, onclose, onerror(e) } that this sets: what
// machine-host.js's tcpOpen() gives. WebSocketClient is the standard WebSocket API over one
// (constructor(url, protocols, options), readyState, binaryType, on*/addEventListener, send, close,
// bufferedAmount, protocol, extensions, url), enough for supabase realtime-js, phoenix.js and
// clients written against the browser's WebSocket. No extension is offered (no permessage-deflate).
//
// Pure: no DOM, nothing of the page or a machine; it runs in a page, a worker and node alike.
(function (root) {
  "use strict";

  const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  // A message's size, in bytes, beyond which the connection is closed (1009)
  const MAX_MESSAGE = 16 << 20;
  // The server's handshake answer, in bytes
  const MAX_HEAD = 16 << 10;
  // How long the server gets to accept the connection and answer the handshake
  const HANDSHAKE_MS = 30000;
  // How long a closing handshake may take before the connection is dropped
  const CLOSE_MS = 5000;
  const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
  const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
  const utf8 = new TextEncoder();
  const strict = () => new TextDecoder("utf-8", { fatal: true });

  // ---------------------------------------------------------------- the handshake's key

  /** SHA-1 of bytes (20 bytes). Small and synchronous: crypto.subtle is async, and missing outside
   *  secure contexts. Only for the handshake's accept key, never for security. */
  function sha1(msg) {
    const ml = msg.length;
    const size = ((ml + 8) >> 6) + 1 << 6;
    const buf = new Uint8Array(size);
    buf.set(msg);
    buf[ml] = 0x80;
    const dv = new DataView(buf.buffer);
    dv.setUint32(size - 8, Math.floor(ml / 0x20000000));
    dv.setUint32(size - 4, (ml * 8) >>> 0);
    let h0 = 0x67452301, h1 = 0xefcdab89, h2 = 0x98badcfe, h3 = 0x10325476, h4 = 0xc3d2e1f0;
    const w = new Uint32Array(80);
    for (let off = 0; off < size; off += 64) {
      for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
      for (let i = 16; i < 80; i++) {
        const x = w[i - 3] ^ w[i - 8] ^ w[i - 14] ^ w[i - 16];
        w[i] = (x << 1) | (x >>> 31);
      }
      let a = h0, b = h1, c = h2, d = h3, e = h4;
      for (let i = 0; i < 80; i++) {
        let f, k;
        if (i < 20) { f = (b & c) | (~b & d); k = 0x5a827999; }
        else if (i < 40) { f = b ^ c ^ d; k = 0x6ed9eba1; }
        else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
        else { f = b ^ c ^ d; k = 0xca62c1d6; }
        const t = (((a << 5) | (a >>> 27)) + f + e + k + w[i]) >>> 0;
        e = d; d = c; c = ((b << 30) | (b >>> 2)) >>> 0; b = a; a = t;
      }
      h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0; h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
    }
    const out = new Uint8Array(20);
    const o = new DataView(out.buffer);
    [h0, h1, h2, h3, h4].forEach((h, i) => o.setUint32(i * 4, h));
    return out;
  }

  function base64(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  /** The Sec-WebSocket-Accept a server must answer `key` with. */
  function acceptKey(key) { return base64(sha1(utf8.encode(key + GUID))); }

  function randomBytes(n) {
    const b = new Uint8Array(n);
    (root.crypto ?? globalThis.crypto).getRandomValues(b);
    return b;
  }

  // ---------------------------------------------------------------- frames

  /** One frame's bytes: `mask` (4 bytes, a client's frames always have one) or null (a server's). */
  function encodeFrame(opcode, payload, { fin = true, mask = null } = {}) {
    const n = payload.length;
    const ext = n < 126 ? 0 : n < 65536 ? 2 : 8;
    const head = 2 + ext + (mask ? 4 : 0);
    const out = new Uint8Array(head + n);
    out[0] = (fin ? 0x80 : 0) | opcode;
    out[1] = (mask ? 0x80 : 0) | (n < 126 ? n : n < 65536 ? 126 : 127);
    if (ext === 2) { out[2] = n >> 8; out[3] = n & 0xff; }
    else if (ext === 8) {
      const dv = new DataView(out.buffer);
      dv.setUint32(2, Math.floor(n / 0x100000000));
      dv.setUint32(6, n >>> 0);
    }
    if (mask) {
      out.set(mask, 2 + ext);
      for (let i = 0; i < n; i++) out[head + i] = payload[i] ^ mask[i & 3];
    } else {
      out.set(payload, head);
    }
    return out;
  }

  /** A protocol error: the connection is failed with `code` (1002, 1007, 1009). */
  class ProtocolError extends Error {
    constructor(code, message) {
      super(message);
      this.name = "ProtocolError";
      this.code = code;
    }
  }

  /** Bytes as they arrive, kept as a list of chunks (no copy of a large message per arrival). */
  class Chunks {
    constructor() { this.list = []; this.first = 0; this.size = 0; }
    push(b) { if (b.length) { this.list.push(b); this.size += b.length; } }
    /** The first `n` bytes (a copy when they span chunks), left in place. */
    peek(n) {
      const head = this.list[this.first];
      if (head.length >= n) return head.subarray(0, n);
      const out = new Uint8Array(n);
      let at = 0;
      for (let i = this.first; at < n; i++) {
        const c = this.list[i];
        const k = Math.min(c.length, n - at);
        out.set(c.subarray(0, k), at);
        at += k;
      }
      return out;
    }
    /** The first `n` bytes, taken out. */
    take(n) {
      const head = this.list[this.first];
      let out;
      if (n === 0) out = new Uint8Array(0);
      else if (head.length >= n) {
        out = head.subarray(0, n);
        if (head.length === n) this.first++;
        else this.list[this.first] = head.subarray(n);
      } else {
        out = new Uint8Array(n);
        let at = 0;
        while (at < n) {
          const c = this.list[this.first];
          const k = Math.min(c.length, n - at);
          out.set(c.subarray(0, k), at);
          at += k;
          if (k === c.length) this.first++;
          else this.list[this.first] = c.subarray(k);
        }
      }
      // Taken chunks dropped now and then, not one at a time (shift() is linear)
      if (this.first > 64 && this.first * 2 > this.list.length) {
        this.list = this.list.slice(this.first);
        this.first = 0;
      }
      this.size -= n;
      return out;
    }
  }

  /**
   * Frames from bytes as they arrive: push(bytes) returns the frames now complete, { fin, opcode,
   * payload }. Throws a ProtocolError for what RFC 6455 says must fail the connection: reserved bits
   * (no extension is agreed), an unknown opcode, a fragmented or long control frame, a masked frame
   * from a server (`masked`: true where a client's frames are read, as a server does), a length
   * beyond `maxFrame` (1009) or with its top bit set.
   */
  class FrameDecoder {
    constructor({ maxFrame = MAX_MESSAGE, masked = false } = {}) {
      this.maxFrame = maxFrame;
      this.masked = masked;
      this.chunks = new Chunks();
    }

    push(bytes) {
      this.chunks.push(bytes);
      const out = [];
      for (;;) {
        const c = this.chunks;
        if (c.size < 2) return out;
        const h = c.peek(Math.min(c.size, 14));
        const fin = (h[0] & 0x80) !== 0;
        const opcode = h[0] & 0x0f;
        const masked = (h[1] & 0x80) !== 0;
        let len = h[1] & 0x7f;
        let at = 2;
        if (h[0] & 0x70) throw new ProtocolError(1002, "a frame with reserved bits set (no extension was agreed)");
        if (![0, 1, 2, 8, 9, 10].includes(opcode)) throw new ProtocolError(1002, `a frame with an unknown opcode ${opcode}`);
        if (opcode >= 8 && (!fin || len > 125)) throw new ProtocolError(1002, "a control frame fragmented or over 125 bytes");
        if (masked !== this.masked) throw new ProtocolError(1002, masked ? "a masked frame from the server" : "an unmasked frame from a client");
        if (len === 126) {
          if (c.size < 4) return out;
          len = (h[2] << 8) | h[3];
          at = 4;
        } else if (len === 127) {
          if (c.size < 10) return out;
          const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
          const hi = dv.getUint32(2);
          if (hi & 0x80000000) throw new ProtocolError(1002, "a frame length with its top bit set");
          len = hi * 0x100000000 + dv.getUint32(6);
          at = 10;
        }
        if (len > this.maxFrame) throw new ProtocolError(1009, `a frame of ${len} bytes, over the ${this.maxFrame} a message may have`);
        let mask = null;
        if (masked) {
          if (c.size < at + 4) return out;
          mask = h.slice(at, at + 4);
          at += 4;
        }
        if (c.size < at + len) return out;
        c.take(at);
        let payload = c.take(len);
        if (mask) {
          payload = payload.slice();
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        }
        out.push({ fin, opcode, payload });
      }
    }
  }

  /** May a close frame carry this code (RFC 6455 7.4, and the registry since)? */
  function validCloseCode(code) {
    return (code >= 1000 && code <= 1003) || (code >= 1007 && code <= 1014) || (code >= 3000 && code <= 4999);
  }

  /** A close frame's payload: { code, reason } (1005: none given). Throws a ProtocolError when it
   *  is malformed (1 byte, a code that can't be sent, a reason that isn't UTF-8). */
  function parseClose(payload) {
    if (payload.length === 0) return { code: 1005, reason: "" };
    if (payload.length === 1) throw new ProtocolError(1002, "a close frame of 1 byte");
    const code = (payload[0] << 8) | payload[1];
    if (!validCloseCode(code)) throw new ProtocolError(1002, `a close code that can't be sent: ${code}`);
    let reason;
    try { reason = strict().decode(payload.subarray(2)); } catch { throw new ProtocolError(1007, "a close reason that is not UTF-8"); }
    return { code, reason };
  }

  function closePayload(code, reasonBytes = new Uint8Array(0)) {
    if (code === undefined || code === 1005) return new Uint8Array(0);
    const out = new Uint8Array(2 + reasonBytes.length);
    out[0] = code >> 8;
    out[1] = code & 0xff;
    out.set(reasonBytes, 2);
    return out;
  }

  // ---------------------------------------------------------------- the handshake

  /** The client's opening handshake, as bytes. */
  function handshakeRequest({ path, host, key, origin, protocols = [], headers = [] }) {
    for (const v of [path, host, origin ?? ""]) if (/[\s\x00-\x1f\x7f]/.test(v)) throw new Error(`a line break or space in the handshake: ${JSON.stringify(v)}`);
    let head = `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n`;
    if (origin) head += `Origin: ${origin}\r\n`;
    if (protocols.length) head += `Sec-WebSocket-Protocol: ${protocols.join(", ")}\r\n`;
    for (const [k, v] of headers) {
      if (!TOKEN.test(k) || /[\r\n\0]/.test(String(v))) throw new Error(`not a header: ${JSON.stringify(k)}`);
      head += `${k}: ${v}\r\n`;
    }
    return utf8.encode(head + "\r\n");
  }

  function indexOfHeadEnd(bytes) {
    for (let i = 0; i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
  }

  /**
   * The server's handshake answer, checked as RFC 6455 4.1 (and the browsers) do: 101, Upgrade:
   * websocket, Connection: Upgrade, the accept key for `key`, no extension (none was offered), and a
   * subprotocol that is one of those offered, and given when any was. { protocol } or throws.
   */
  function checkHandshake(text, { key, protocols = [] }) {
    const lines = text.split("\r\n");
    const m = /^HTTP\/1\.1 (\d{3})(?: (.*))?$/.exec(lines[0]);
    if (!m) throw new Error(`not an HTTP/1.1 answer: ${JSON.stringify(lines[0].slice(0, 80))}`);
    if (m[1] !== "101") throw new Error(`the server answered ${m[1]}${m[2] ? ` ${m[2]}` : ""}, not 101 Switching Protocols`);
    const headers = new Map();
    for (const line of lines.slice(1)) {
      const at = line.indexOf(":");
      if (at <= 0) throw new Error(`a malformed header: ${JSON.stringify(line.slice(0, 80))}`);
      const k = line.slice(0, at).trim().toLowerCase();
      headers.set(k, [...(headers.get(k) ?? []), line.slice(at + 1).trim()]);
    }
    const one = (k) => (headers.get(k) ?? []).join(", ");
    if (one("upgrade").toLowerCase() !== "websocket") throw new Error("the answer's Upgrade is not websocket");
    if (!one("connection").toLowerCase().split(",").map((s) => s.trim()).includes("upgrade")) throw new Error("the answer's Connection has no Upgrade");
    if (one("sec-websocket-accept") !== acceptKey(key)) throw new Error("the answer's Sec-WebSocket-Accept is wrong");
    if (one("sec-websocket-extensions")) throw new Error(`the server chose an extension none was offered: ${one("sec-websocket-extensions")}`);
    const protocol = one("sec-websocket-protocol");
    if (protocol && !protocols.includes(protocol)) throw new Error(`the server chose a subprotocol not offered: ${protocol}`);
    if (!protocol && protocols.length) throw new Error("the server chose none of the subprotocols offered");
    return { protocol };
  }

  // ---------------------------------------------------------------- events

  function makeEvent(type, init = {}) {
    if (type === "message" && typeof MessageEvent === "function") return new MessageEvent("message", { data: init.data, origin: init.origin ?? "" });
    if (type === "close" && typeof CloseEvent === "function") return new CloseEvent("close", { code: init.code, reason: init.reason, wasClean: init.wasClean });
    const e = new Event(type);
    for (const [k, v] of Object.entries(init)) Object.defineProperty(e, k, { value: v, enumerable: true });
    return e;
  }

  /** onopen, onmessage, onerror, onclose as a WebSocket has them: one listener each, called in
   *  order with the others, replaced when set again. */
  function defineHandlers(proto) {
    for (const type of ["open", "message", "error", "close"]) {
      Object.defineProperty(proto, `on${type}`, {
        configurable: true,
        get() { return this._handlers?.[type]?.fn ?? null; },
        set(fn) {
          this._handlers ??= {};
          const h = this._handlers[type];
          if (h) {
            this.removeEventListener(type, h.wrap);
            delete this._handlers[type];
          }
          if (typeof fn !== "function") return;
          const entry = { fn, wrap: (e) => entry.fn.call(this, e) };
          this._handlers[type] = entry;
          this.addEventListener(type, entry.wrap);
        },
      });
    }
  }

  const domError = (name, message) => typeof DOMException === "function" ? new DOMException(message, name) : Object.assign(new Error(message), { name });

  /** The subprotocols asked for, as a WebSocket's constructor checks them. */
  function checkProtocols(protocols) {
    const list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : Array.from(protocols, String);
    const seen = new Set();
    for (const p of list) {
      if (!TOKEN.test(p) || seen.has(p)) throw domError("SyntaxError", `not a subprotocol, or given twice: ${JSON.stringify(p)}`);
      seen.add(p);
    }
    return list;
  }

  /** The url as a WebSocket's constructor takes it: ws(s), or http(s) made ws(s); no fragment. */
  function checkUrl(url, base) {
    let u;
    try { u = base ? new URL(String(url), base) : new URL(String(url)); } catch { throw domError("SyntaxError", `not a URL: ${String(url)}`); }
    if (u.protocol === "http:") u.protocol = "ws:";
    else if (u.protocol === "https:") u.protocol = "wss:";
    if (u.protocol !== "ws:" && u.protocol !== "wss:") throw domError("SyntaxError", `not a WebSocket URL: ${u.href}`);
    if (u.hash) throw domError("SyntaxError", `a WebSocket URL has no fragment: ${u.href}`);
    return u;
  }

  const byteLength = (data) => typeof data === "string" ? utf8.encode(data).length : data?.byteLength ?? data?.size ?? 0;

  // ---------------------------------------------------------------- the client

  /**
   * A WebSocket over a stream of this code's choosing. `options`: connect() → the stream (called
   * once, just after construction), host (the Host header; the url's by default), path (the
   * request's path and query; the url's by default), origin (an Origin header, when given),
   * headers ([[k, v]] more), maxMessage, handshakeMs, closeMs, timers ({ setTimeout,
   * clearTimeout }), random(n) (bytes for the key and masks).
   */
  class WebSocketClient extends EventTarget {
    constructor(url, protocols, options = {}) {
      super();
      const u = checkUrl(url, options.base);
      this._protocols = checkProtocols(protocols);
      if (typeof options.connect !== "function") throw new TypeError("WebSocketClient: options.connect, the stream to speak over");
      this.url = u.href;
      this.protocol = "";
      this.extensions = "";
      this._binaryType = "blob";
      this._readyState = CONNECTING;
      this._buffered = 0;
      this._o = {
        connect: options.connect, host: options.host ?? u.host, path: options.path ?? (u.pathname + u.search), origin: options.origin,
        headers: options.headers ?? [], maxMessage: options.maxMessage ?? MAX_MESSAGE, handshakeMs: options.handshakeMs ?? HANDSHAKE_MS,
        closeMs: options.closeMs ?? CLOSE_MS, timers: options.timers ?? root, random: options.random ?? randomBytes,
      };
      this._stream = null;
      this._streamOver = false;
      this._head = new Uint8Array(0);
      this._decoder = new FrameDecoder({ maxFrame: this._o.maxMessage });
      this._frag = null; // a fragmented message being read: { opcode, parts, size }
      this._sentClose = false;
      this._pendingClose = null; // close()'s frame, waiting for what was sent before it
      this._gotClose = null; // { code, reason }
      this._timer = null;
      this._queue = []; // what send() was given, in order: { bytes } or { blob }
      this._finished = false;
      /** Why the connection failed, when it did (not part of the WebSocket API: for messages). */
      this.failure = null;
      queueMicrotask(() => this._start());
    }

    get readyState() { return this._readyState; }
    get bufferedAmount() { return this._buffered; }
    get binaryType() { return this._binaryType; }
    set binaryType(v) { if (v === "blob" || v === "arraybuffer") this._binaryType = v; }

    _arm(ms, fn) {
      const t = this._o.timers;
      if (this._timer !== null) t.clearTimeout(this._timer);
      this._timer = ms === null ? null : t.setTimeout(() => { this._timer = null; fn(); }, ms);
    }

    _start() {
      if (this._readyState !== CONNECTING) return;
      const key = base64(this._o.random(16));
      this._key = key;
      let request;
      try {
        request = handshakeRequest({ path: this._o.path, host: this._o.host, key, origin: this._o.origin, protocols: this._protocols, headers: this._o.headers });
      } catch (e) {
        return this._fail(1006, String(e?.message ?? e));
      }
      let s;
      try {
        s = this._stream = this._o.connect();
      } catch (e) {
        return this._fail(1006, `could not connect: ${e?.message ?? e}`);
      }
      this._arm(this._o.handshakeMs, () => this._fail(1006, `no handshake within ${this._o.handshakeMs / 1000} s`));
      s.onconnect = () => {
        if (this._readyState === CONNECTING && !this._finished) this._write(request);
      };
      s.ondata = (bytes) => this._data(bytes);
      s.onend = () => this._gone("the server ended the connection");
      s.onclose = () => { this._streamOver = true; this._gone("the connection closed"); };
      s.onerror = (e) => { this._streamOver = true; this._gone(String(e?.message ?? e ?? "the connection failed")); };
    }

    /** Bytes to the stream; resolves once it took them (at once, for a stream that doesn't say). */
    _write(bytes) {
      if (!this._stream || this._streamOver) return Promise.resolve(false);
      try {
        const r = this._stream.write(bytes);
        return r && typeof r.then === "function" ? r.then(() => true, () => false) : Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    }

    _data(bytes) {
      if (this._finished) return;
      if (this._readyState === CONNECTING) {
        const all = new Uint8Array(this._head.length + bytes.length);
        all.set(this._head);
        all.set(bytes, this._head.length);
        const end = indexOfHeadEnd(all);
        if (end < 0) {
          if (all.length > MAX_HEAD) return this._fail(1006, "the server's handshake answer is too long");
          this._head = all;
          return;
        }
        this._head = null;
        let protocol;
        try {
          let text = "";
          for (let i = 0; i < end; i++) text += String.fromCharCode(all[i]);
          ({ protocol } = checkHandshake(text, { key: this._key, protocols: this._protocols }));
        } catch (e) {
          return this._fail(1006, String(e?.message ?? e));
        }
        this._arm(null);
        this.protocol = protocol;
        this._readyState = OPEN;
        this.dispatchEvent(makeEvent("open"));
        this._pump();
        bytes = all.subarray(end + 4);
        if (!bytes.length || this._finished) return;
      }
      let frames;
      try {
        frames = this._decoder.push(bytes);
      } catch (e) {
        return this._fail(e.code ?? 1002, e.message);
      }
      for (const f of frames) {
        if (this._finished || this._gotClose) return;
        try { this._frame(f); } catch (e) { return this._fail(e.code ?? 1002, e.message); }
      }
    }

    _frame({ fin, opcode, payload }) {
      if (opcode === 9) {
        if (this._readyState === OPEN) this._write(encodeFrame(10, payload, { mask: this._o.random(4) }));
        return;
      }
      if (opcode === 10) return;
      if (opcode === 8) return this._closeFrame(parseClose(payload));
      if (opcode === 0) {
        if (!this._frag) throw new ProtocolError(1002, "a continuation frame with no message to continue");
        this._frag.parts.push(payload);
        this._frag.size += payload.length;
        if (this._frag.size > this._o.maxMessage) throw new ProtocolError(1009, `a message over ${this._o.maxMessage} bytes`);
        if (!fin) return;
        const { opcode: first, parts, size } = this._frag;
        this._frag = null;
        const all = new Uint8Array(size);
        let at = 0;
        for (const p of parts) { all.set(p, at); at += p.length; }
        return this._message(first, all);
      }
      if (this._frag) throw new ProtocolError(1002, "a new message inside a fragmented one");
      if (!fin) {
        this._frag = { opcode, parts: [payload], size: payload.length };
        return;
      }
      this._message(opcode, payload);
    }

    _message(opcode, payload) {
      let data;
      if (opcode === 1) {
        try { data = strict().decode(payload); } catch { throw new ProtocolError(1007, "a text message that is not UTF-8"); }
      } else {
        const buf = payload.byteOffset === 0 && payload.byteLength === payload.buffer.byteLength ? payload.buffer : payload.slice().buffer;
        data = this._binaryType === "blob" && typeof Blob === "function" ? new Blob([buf]) : buf;
      }
      // Messages that come after close() was called are dropped, as a WebSocket's are
      if (this._readyState !== OPEN) return;
      this.dispatchEvent(makeEvent("message", { data, origin: new URL(this.url).origin }));
    }

    _closeFrame({ code, reason }) {
      this._gotClose = { code, reason };
      if (!this._sentClose) {
        // Theirs first: ours echoes its code, and the closing handshake is done
        this._readyState = CLOSING;
        this._sentClose = true;
        this._write(encodeFrame(8, closePayload(code === 1005 ? undefined : code), { mask: this._o.random(4) }));
      }
      // The server closes the TCP connection first (RFC 6455 7.1.1): our side ends now, and if it
      // doesn't close soon, it is dropped
      try { this._stream?.end?.(); } catch {}
      this._arm(this._o.closeMs, () => this._finish({ code, reason, wasClean: true }));
    }

    /** The stream ended or closed (or failed) under us. */
    _gone(why) {
      if (this._finished) return;
      if (this._gotClose && this._sentClose) return this._finish({ ...this._gotClose, wasClean: true });
      this.failure ??= why;
      this._finish({ code: 1006, reason: "", wasClean: false, error: true });
    }

    /** Fail the WebSocket connection (RFC 6455 7.1.7): a close frame when one can still be sent,
     *  the stream dropped, error then close (1006) said. */
    _fail(code, why) {
      if (this._finished) return;
      this.failure = why;
      let linger = 0;
      if (this._readyState === OPEN && !this._sentClose && code !== 1006) {
        this._sentClose = true;
        this._write(encodeFrame(8, closePayload(code), { mask: this._o.random(4) }));
        linger = 1000;
      }
      this._finish({ code: 1006, reason: "", wasClean: false, error: true, linger });
    }

    /** Over, once: no timers, the stream let go, close (after error, if it failed) said. */
    _finish({ code, reason, wasClean, error = false, linger = 0 }) {
      if (this._finished) return;
      this._finished = true;
      this._arm(null);
      // CLOSED when the events are said (as a WebSocket is), closing until then
      this._readyState = CLOSING;
      this._queue = [];
      const s = this._stream;
      if (s && !this._streamOver) {
        this._streamOver = true;
        try { s.end?.(); } catch {}
        // A close frame just written gets a moment to go before the connection is dropped
        const drop = () => { try { s.abort?.(); } catch {} };
        if (linger) this._o.timers.setTimeout(drop, linger);
        else drop();
      }
      const say = () => {
        this._readyState = CLOSED;
        if (error) this.dispatchEvent(makeEvent("error"));
        this.dispatchEvent(makeEvent("close", { code, reason, wasClean }));
      };
      queueMicrotask(say);
    }

    /**
     * Send a message: a string (text), or an ArrayBuffer, a view or a Blob (binary). Throws while
     * connecting; once closing, it is counted in bufferedAmount and dropped, as a WebSocket does.
     * Returns a promise for when the stream took it (not part of the WebSocket API).
     */
    send(data) {
      if (this._readyState === CONNECTING) throw domError("InvalidStateError", "the WebSocket is still connecting");
      let item;
      if (typeof data === "string") item = { opcode: 1, bytes: utf8.encode(data) };
      else if (data instanceof ArrayBuffer) item = { opcode: 2, bytes: new Uint8Array(data) };
      else if (ArrayBuffer.isView(data)) item = { opcode: 2, bytes: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
      else if (typeof Blob === "function" && data instanceof Blob) item = { opcode: 2, blob: data };
      else item = { opcode: 1, bytes: utf8.encode(String(data)) };
      const n = item.bytes ? item.bytes.length : item.blob.size;
      this._buffered += n;
      if (this._readyState !== OPEN || this._sentClose) return Promise.resolve(false);
      // A frame is made now (of a copy: the caller may change its buffer after), a Blob read first
      if (item.bytes) item.frame = encodeFrame(item.opcode, item.bytes, { mask: this._o.random(4) });
      item.bytes = null;
      return new Promise((resolve) => {
        item.done = resolve;
        item.n = n;
        this._queue.push(item);
        this._pump();
      });
    }

    _pump() {
      while (this._queue.length && (this._readyState === OPEN || this._pendingClose) && !this._sentClose && !this._finished) {
        const item = this._queue[0];
        if (item.blob) {
          if (!item.reading) {
            item.reading = true;
            item.blob.arrayBuffer().then((buf) => {
              item.frame = encodeFrame(2, new Uint8Array(buf), { mask: this._o.random(4) });
              item.blob = null;
              this._pump();
            }, () => this._fail(1006, "a Blob to send could not be read"));
          }
          return;
        }
        this._queue.shift();
        this._write(item.frame).then((ok) => {
          this._buffered = Math.max(0, this._buffered - item.n);
          item.done(ok);
        });
      }
      // close() called while messages were still queued (a Blob being read): its frame goes after them
      if (!this._queue.length && this._pendingClose && !this._sentClose && !this._finished) {
        const frame = this._pendingClose;
        this._pendingClose = null;
        this._sentClose = true;
        this._write(frame);
      }
    }

    /** Close it: `code` 1000 or 3000 to 4999, `reason` at most 123 bytes of UTF-8. */
    close(code, reason) {
      if (code !== undefined) {
        code = Number(code);
        if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) throw domError("InvalidAccessError", `a close code must be 1000 or 3000 to 4999, not ${code}`);
      }
      const r = reason === undefined ? new Uint8Array(0) : utf8.encode(String(reason));
      if (r.length > 123) throw domError("SyntaxError", "a close reason is at most 123 bytes");
      this._close(code, r);
    }

    /** close() without its checks on the code (the page's own: 1001 when the preview goes). */
    _close(code, reasonBytes = new Uint8Array(0)) {
      if (this._readyState === CLOSING || this._readyState === CLOSED) return;
      if (this._readyState === CONNECTING) {
        this._readyState = CLOSING;
        return this._fail(1006, "closed before it connected");
      }
      this._readyState = CLOSING;
      this._pendingClose = encodeFrame(8, closePayload(code, reasonBytes), { mask: this._o.random(4) });
      this._arm(this._o.closeMs, () => this._finish({ code: 1006, reason: "", wasClean: false }));
      this._pump();
    }
  }
  defineHandlers(WebSocketClient.prototype);
  for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
    Object.defineProperty(WebSocketClient, k, { value: v, enumerable: true });
    Object.defineProperty(WebSocketClient.prototype, k, { value: v, enumerable: true });
  }

  const SnowglobeWsClient = { WebSocketClient, FrameDecoder, ProtocolError, encodeFrame, acceptKey, sha1, base64, handshakeRequest, checkHandshake, parseClose,
    validCloseCode, checkProtocols, checkUrl, byteLength, defineHandlers, makeEvent, GUID, limits: { MAX_MESSAGE, MAX_HEAD, HANDSHAKE_MS, CLOSE_MS } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeWsClient;
  else root.SnowglobeWsClient = SnowglobeWsClient;
})(typeof window !== "undefined" ? window : globalThis);
