// One machine's own side: the armless machine itself, the warm pack that fills its file cache, its
// captured state, and (with agent.js loaded) the serial job runner and the file
// transfer over it. It runs wherever the machine runs: in the page (the terminal pages), or in a
// dedicated Web Worker of its own (the agent page, machine-worker.js), so that machines run on
// cores of their own and the page stays responsive. It never touches the DOM.
//
// What it says goes out through `emit(event, payload)`: progress ({file, loaded, total}), console
// (bytes), stop ({reason}), error ({name, message}), job ({jobId, state}: a job ended), xfer
// ({xid, phase, done, total}: a file transfer's progress), blobs ({ok, url, message}: the blob store the
// guest's files come from stopped or started answering), tcp ({sid, kind, bytes}: a connection
// into the machine, tcpOpen()), link ({cid, kind: open | data | end | close, runtime, port, bytes}:
// a TCP connection the guest opened to a link's name and port, which the page carries to the
// machine it links to and answers with linkIn(); see LinkSocket below).
(function (root) {
  "use strict";

  const errorOf = (e) => ({ name: e?.name ?? "Error", message: String(e?.message ?? e) });

  /** The machine's files as absolute URLs against `base` (the site's directory): armless loads
   *  some of them away from this script (the blobs, in a worker), where a relative URL would
   *  resolve against the wrong place. */
  function located(base, o) {
    const at = (url) => typeof url === "string" ? new URL(url, base).href : url;
    const r = { ...o, wasm: at(o.wasm), wasm_smp: at(o.wasm_smp), initial_state: at(o.initial_state),
      filesystem: { json: at(o.filesystem.json), baseurl: at(o.filesystem.baseurl) } };
    if (o.network) r.network = { ...o.network, tls: at(o.network.tls) };
    if (o.warm) r.warm = at(o.warm);
    return r;
  }

  // Request headers a package manager adds that only hint (caching, npm's and pacote's bookkeeping,
  // its user agent). None is CORS-safelisted, so with any of them the browser preflights the request,
  // and package registries (registry.npmjs.org answers OPTIONS with 404) refuse the preflight; with
  // them gone a GET is simple and goes through. Dropping them changes no answer. (web's npm also goes
  // through a relay that sends only Accept, examples/web/serve.mjs; this covers npm pointed at the
  // registry itself, and pnpm or yarn.)
  const DROPPED = /^(cache-control|pragma|user-agent|npm-[\w-]+|pacote-[\w-]+)$/i;

  /**
   * Where a request to a link's name goes: the page's own address for the machine it links to
   * (`<base>preview/<machine>/<port>/<path>`, which the page's service worker hands to the page, and
   * the page to that machine's server), or the url as it was. `links` maps a name the guest uses
   * (feed.internal) to { runtime, port }; `base` is the page's directory. Any port of the name goes
   * to the link's.
   */
  function linked(url, links, base) {
    if (!links || !base) return url;
    let u;
    try { u = new URL(typeof url === "string" ? url : url.url); } catch { return url; }
    const to = Object.hasOwn(links, u.hostname) ? links[u.hostname] : null;
    if (!to) return url;
    return new URL(`preview/${encodeURIComponent(to.runtime)}/${to.port}${u.pathname}${u.search}`, base).href;
  }

  // ------------------------------------------------------------------ raw TCP over links
  //
  // A link's name and port (db.internal:5432) is one of armless's tunnels: `network.tunnels`,
  // [{ host, port, url }], "guest TCP destinations carried over a WebSocket, as binary messages".
  // What armless.js does with them (read from its built copy; armless itself is not this repo's):
  //  - Matching: a guest connection that armless hands to the page as a TCP connection (its
  //    "tcp-connection" path, event 4) is checked against the tunnels by port AND host name:
  //    `t.port === port && (t.host == null || t.host === host)`, the host lower-cased, and the host
  //    being the name the guest connected to (armless's DNS keeps it). withLinks always gives the
  //    host, so a link never catches another name's port. The first match wins.
  //  - Precedence: the tunnel check sits in that TCP path only. Which path a connection takes is
  //    decided inside armless.wasm: connections to ports 80 and 443 are ended inside the machine and
  //    come out as an HTTP request (fetch(), event 9) or a WebSocket (event 10), never as event 4, so
  //    a tunnel on 80 or 443 is never consulted and a link's name on those ports goes the HTTP way
  //    (guestFetch's rewrite) as before. Every other port reaches the tunnel check. (Seen in a
  //    browser: a link with as_port 80 got raw bytes no answer, and http:// to it went through fetch.)
  //  - The socket: `new o.WebSocket(url)` with ONE argument (a guest's own WebSocket is opened with
  //    two, `new o.WebSocket(url, protocols)`), "ws:" made "wss:" on an https page. Then it sets
  //    binaryType = "arraybuffer", onopen (the guest's SYN, held until now, is accepted), onmessage
  //    ({ data }: an ArrayBuffer or a string, written to the guest), onclose (opened: the guest's side
  //    is closed with a FIN, conn.close(); never opened: the SYN is refused, so the guest sees
  //    connection refused). It never sets onerror, never reads bufferedAmount, protocol or the close
  //    event's code. It calls send(Uint8Array) when readyState === 1 (the guest's bytes), and
  //    close(1000) when readyState <= 1 on the guest's FIN ("end": a WebSocket can't half-close)
  //    and again on the guest's connection closing ("close"). A throwing constructor refuses.
  //
  // So a link's tunnel url is LINK_URL/<runtime>/<port>, which LinkSocket (armless's WebSocket in a
  // machine with links) recognises, for this machine's own tunnels only, and carries to the page
  // instead of the network: the page connects to <port> in <runtime> (its tcpOpen) and pipes.
  // A guest's own WebSocket to a link's name is spoken by this machine (see wsLinked below); anything
  // else, and any two-argument construction (a guest's own WebSocket, which could name such a url),
  // goes to the real WebSocket. ".invalid" never resolves (RFC 2606), so a link url
  // that reaches the network goes nowhere.
  const LINK_URL = "wss://link.invalid/";

  /** The tunnel url of a link to `port` in `runtime`. */
  function linkUrl(runtime, port) { return `${LINK_URL}${encodeURIComponent(runtime)}/${port}`; }

  /** { runtime, port } of a link's tunnel url, or null. */
  function parseLinkUrl(url) {
    if (typeof url !== "string" || !url.startsWith(LINK_URL)) return null;
    const m = /^([^/?#]+)\/(\d{1,5})$/.exec(url.slice(LINK_URL.length));
    if (!m) return null;
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return null;
    let runtime;
    try { runtime = decodeURIComponent(m[1]); } catch { return null; }
    return linkUrl(runtime, port) === url ? { runtime, port } : null;
  }

  // After the guest finished sending (its FIN, close() the first time), how long the page's side may
  // go without a byte before the connection is given up: Linux's own FIN-WAIT-2 timeout. Covers a
  // guest connection that ended with a reset (one close(), never a second)
  const LINK_LINGER_MS = 60000;

  // ------------------------------------------------------------------ WebSockets to a link's name
  //
  // A guest's own WebSocket to a link's name (ws://feed.internal/path) reaches armless's WebSocket
  // class only for ports 80 and 443 (ended inside the machine, event 10: `new WebSocket(url,
  // protocols)` with the url the guest asked for, made wss: on an https page); on any other port it
  // is plain TCP and goes over the link's tunnel, the guest's stack speaking WebSocket itself. For
  // those, the page's real WebSocket would go to the network (where the name means nothing), so
  // this machine speaks WebSocket itself (ws-client.js) over the same pipe a tunnel uses: a `link`
  // connection to the port the name links to, carried by the page. Any port of the name goes to the
  // link's, as its HTTP does (linked()).

  const WS = () => root.SnowglobeWsClient ?? (typeof require === "function" ? require("./ws-client.js") : null);

  /** { runtime, port, host } a guest's WebSocket url goes to over a link (`links`: name -> { runtime,
   *  port }), or null. */
  function wsLinked(url, links) {
    if (!links) return null;
    let u;
    try { u = new URL(String(url)); } catch { return null; }
    if (u.protocol !== "ws:" && u.protocol !== "wss:") return null;
    const to = Object.hasOwn(links, u.hostname) ? links[u.hostname] : null;
    return to ? { runtime: to.runtime, port: to.port, host: u.host } : null;
  }

  /**
   * A link connection to `port` in `runtime` as a byte stream (what ws-client.js speaks over, as
   * host.tcpOpen's): { write, end, abort, onconnect, ondata, onend, onclose, onerror }. The same
   * `link` events and linkIn() as a LinkSocket's; the page's end of it is the end (it can't say a
   * half-close to a WebSocket either).
   */
  function linkPipe(core, runtime, port) {
    let over = false;
    let cid = null;
    const s = {
      onconnect: null, ondata: null, onend: null, onclose: null, onerror: null,
      write(bytes) {
        if (over || !bytes?.length) return;
        // A buffer of its own: the worker hands it over
        core.emit("link", { cid, kind: "data", bytes: bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice() });
      },
      end() { if (!over) core.emit("link", { cid, kind: "end" }); },
      abort() {
        if (over) return;
        over = true;
        core._linkDelete(cid);
        core.emit("link", { cid, kind: "close" });
      },
      _hear(kind, bytes) {
        if (over) return;
        if (kind === "connect") s.onconnect?.();
        else if (kind === "data") { if (bytes instanceof Uint8Array) s.ondata?.(bytes); }
        else if (kind === "end" || kind === "close") {
          over = true;
          core._linkDelete(cid);
          if (kind === "end") s.onend?.();
          else s.onclose?.();
        } else if (kind === "error") {
          over = true;
          core._linkDelete(cid);
          s.onerror?.(new Error("the link's connection failed"));
        }
      },
      _drop() { over = true; },
    };
    cid = core._linkAdd(s);
    core.emit("link", { cid, kind: "open", runtime, port });
    return s;
  }

  /**
   * The WebSocket class a machine's armless uses: LinkSocket for this machine's link urls (`allowed`:
   * url -> { runtime, port }), the real one (`Real`) for everything else. `core` emits a `link` event
   * { cid, kind: "open", runtime, port } | { cid, kind: "data", bytes } | { cid, kind: "end" } |
   * { cid, kind: "close" } for each, and hands what the page says back to it (Core.linkIn). A guest's
   * own WebSocket to a link's name (`names`: name -> { runtime, port }, the machine's links) is
   * spoken here (ws-client.js) over such a connection.
   */
  function linkSockets(core, allowed, Real, timers = root, names = null) {
    const CONNECTING = 0, OPEN = 1, CLOSING = 2, CLOSED = 3;
    class LinkSocket {
      constructor(...args) {
        const url = String(args[0]);
        if (args.length !== 1 || !allowed.has(url)) {
          const to = wsLinked(url, names);
          const W = to && WS();
          if (W) {
            return new W.WebSocketClient(url, args[1], { connect: () => linkPipe(core, to.runtime, to.port), host: to.host, timers });
          }
          if (typeof Real !== "function") throw new Error("this browser has no WebSocket");
          return new Real(...args);
        }
        const { runtime, port } = allowed.get(url);
        this.url = url;
        this.protocol = "";
        this.extensions = "";
        this.binaryType = "blob";
        this.bufferedAmount = 0;
        this.readyState = CONNECTING;
        this.onopen = this.onmessage = this.onclose = this.onerror = null;
        this._listeners = new Map();
        this._ended = false; // the guest finished sending: the page's side still reads
        this._linger = null;
        this.cid = core._linkAdd(this);
        core.emit("link", { cid: this.cid, kind: "open", runtime, port });
      }

      addEventListener(type, fn) {
        if (typeof fn !== "function") return;
        if (!this._listeners.has(type)) this._listeners.set(type, new Set());
        this._listeners.get(type).add(fn);
      }
      removeEventListener(type, fn) { this._listeners.get(type)?.delete(fn); }
      dispatchEvent(e) {
        const on = this[`on${e.type}`];
        if (typeof on === "function") { try { on.call(this, e); } catch (err) { timers.setTimeout(() => { throw err; }); } }
        for (const fn of [...(this._listeners.get(e.type) ?? [])]) { try { fn.call(this, e); } catch (err) { timers.setTimeout(() => { throw err; }); } }
        return true;
      }
      _fire(type, extra) { this.dispatchEvent({ type, target: this, currentTarget: this, ...extra }); }

      /** The guest's bytes, to the page (a copy: armless's may be a view into a buffer it reuses). */
      send(data) {
        if (this.readyState === CONNECTING) {
          const e = new Error("the link is still connecting");
          e.name = "InvalidStateError";
          throw e;
        }
        if (this.readyState !== OPEN || this._ended) return;
        let bytes;
        if (typeof data === "string") bytes = new TextEncoder().encode(data);
        else if (data instanceof ArrayBuffer) bytes = new Uint8Array(data.slice(0));
        else if (ArrayBuffer.isView(data)) bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
        else return;
        if (bytes.length) core.emit("link", { cid: this.cid, kind: "data", bytes });
      }

      /**
       * armless calls this on the guest's FIN, and again when the guest's connection is over. The
       * first, on an open link, is a half-close: the page ends its side towards the server and
       * keeps reading, and readyState stays OPEN so that the second still reaches here (a real
       * WebSocket would turn CLOSING and drop what the server still says). The second, or one
       * before the link opened (the guest gave up on its SYN), closes it at once.
       */
      close() {
        if (this.readyState === CLOSED || this.readyState === CLOSING) return;
        if (this.readyState === OPEN && !this._ended) {
          this._ended = true;
          core.emit("link", { cid: this.cid, kind: "end" });
          this._arm();
          return;
        }
        const opened = this.readyState === OPEN;
        this._closed();
        core.emit("link", { cid: this.cid, kind: "close" });
        queueMicrotask(() => {
          if (!opened) this._fire("error");
          this._fire("close", { code: opened ? 1000 : 1006, reason: "", wasClean: opened });
        });
      }

      _arm() {
        if (this._linger !== null) timers.clearTimeout(this._linger);
        this._linger = timers.setTimeout(() => { this._linger = null; this.close(); }, LINK_LINGER_MS);
      }

      _closed() {
        this.readyState = CLOSED;
        if (this._linger !== null) timers.clearTimeout(this._linger);
        this._linger = null;
        core._linkDelete(this.cid);
      }

      /** What the page says: connect, data (bytes), end or close (its side is over), error. */
      _hear(kind, bytes) {
        if (this.readyState === CLOSED) return;
        if (kind === "connect") {
          if (this.readyState !== CONNECTING) return;
          this.readyState = OPEN;
          this._fire("open");
        } else if (kind === "data") {
          if (this.readyState !== OPEN || !(bytes instanceof Uint8Array)) return;
          if (this._ended) this._arm();
          // An ArrayBuffer of exactly these bytes, as binaryType "arraybuffer" has it (armless's)
          const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
          this._fire("message", { data: this.binaryType === "blob" && typeof Blob === "function" ? new Blob([buf]) : buf });
        } else if (kind === "end" || kind === "close") {
          // The server's FIN or its close: the guest's side is closed after what came (a WebSocket
          // can't say a half-close to armless); before a connect, nothing listened: refused
          const opened = this.readyState === OPEN;
          this._closed();
          if (!opened) this._fire("error");
          this._fire("close", { code: opened ? 1000 : 1006, reason: "", wasClean: opened });
        } else if (kind === "error") {
          this._closed();
          this._fire("error");
          this._fire("close", { code: 1006, reason: "", wasClean: false });
        }
      }

      /** The machine is going: no more events, to armless or the page. */
      _drop() {
        this.readyState = CLOSED;
        if (this._linger !== null) timers.clearTimeout(this._linger);
        this._linger = null;
      }
    }
    for (const [k, v] of Object.entries({ CONNECTING, OPEN, CLOSING, CLOSED })) {
      LinkSocket[k] = v;
      LinkSocket.prototype[k] = v;
    }
    return LinkSocket;
  }

  /** The page's fetch() as the guest's network uses it: without the headers in DROPPED, and a link's
   *  name sent to the machine it names (linked). */
  function guestFetch(url, init, links, base) {
    url = linked(url, links, base);
    if (init?.headers) {
      const headers = new Headers(init.headers);
      for (const name of [...headers.keys()]) if (DROPPED.test(name)) headers.delete(name);
      init = { ...init, headers };
    }
    return fetch(url, init);
  }

  // ------------------------------------------------------------------ the warm pack
  //
  // warm.pack is [u32 index size][index: JSON [[name, size, length], ...]][the files' bytes, in index
  // order], the files ordered by when the build saw them first read. It is read as it arrives: the
  // index from its first bytes, then each file as soon as its bytes are in, so a file the guest asks
  // for that the pack holds comes from the pack (waited for while it is near) instead of a request
  // of its own, and the files go into the machine in slices of time rather than one timer each
  // (a phone's browser stretches each timer, and the guest raced past a pack fed that way).

  /** How long a read waits for the pack to bring a file before it fetches the file itself. */
  const PACK_WAIT_MS = 2000;
  /** ... and, before the pack's rate is known, how far into what is still to come it waits. */
  const PACK_WAIT_BYTES = 4 << 20;
  /** How long a read waits for the pack's index (its first bytes) before it fetches its file itself. */
  const PACK_INDEX_WAIT_MS = 1000;
  /** How long a slice of handing files to the machine runs before it lets the machine run. */
  const PACK_SLICE_MS = 8;
  /** Reading ahead (Core._readAhead): files fetched at once, and at most so many bytes a machine. */
  const READ_AHEAD = 6;
  const READ_AHEAD_BYTES = 48 << 20;
  /** The chunks of a large file fetched after the one asked for. */
  const CHUNKS_AHEAD = 4;
  /** How often a `files` event says how the files are coming. */
  const FILES_EVERY_MS = 250;
  /**
   * The machine's own cache of file contents (armless's fs_cache_mb), decompressed, in its memory,
   * which never shrinks: armless's default is 256 MB, and the guest keeps what it reads in its own
   * page cache anyway. What it drops comes again from the warm pack, kept compressed in this page
   * (and let go with the machine), or the blob store.
   */
  const FS_CACHE_MB = 64;
  /** The pack's first files (the build read them first), up to this many bytes decompressed, go
   *  into the machine as they arrive; the rest wait in the pack until the guest reads them. */
  const PACK_GIVE_BYTES = 48 << 20;

  class WarmPack {
    /** `now()` the clock in ms. */
    constructor({ now = () => (typeof performance !== "undefined" ? performance.now() : Date.now()), indexWaitMs = PACK_INDEX_WAIT_MS } = {}) {
      this.now = now;
      this.indexWaitMs = indexWaitMs;
      this.buf = new Uint8Array(0);
      this.received = 0;
      this.entries = null; // name -> { start, end }, once the index is in
      this.order = []; // the entries in pack order
      this.ready = 0; // entries in order whose bytes are all in
      this.total = null; // the pack's size, once the index says it
      this.done = false; // all of it in, or given up on
      this.started = now();
      this._waiters = new Map(); // name -> [resolve]
      this._indexWaiters = [];
    }

    /** Bytes as they arrive. */
    push(chunk) {
      if (this.done) return;
      const need = this.received + chunk.length;
      if (need > this.buf.length) {
        const grown = new Uint8Array(Math.max(need, this.buf.length * 2, this.total ?? 0, 1 << 16));
        grown.set(this.buf.subarray(0, this.received));
        this.buf = grown;
      }
      this.buf.set(chunk, this.received);
      this.received = need;
      if (!this.entries) this._readIndex();
      if (this.entries) this._arrived();
    }

    /** The pack is all in (ok) or can't be had: whoever waits stops waiting. */
    end(ok = true) {
      if (this.done) return;
      if (ok && !this.entries) this._readIndex();
      if (ok && this.entries) this._arrived();
      this.done = true;
      for (const r of this._indexWaiters.splice(0)) r();
      for (const [name, list] of this._waiters) for (const r of list) r(this._bytes(name));
      this._waiters.clear();
    }

    _readIndex() {
      if (this.received < 4) return;
      const size = new DataView(this.buf.buffer, this.buf.byteOffset).getUint32(0, true);
      if (this.received < 4 + size) return;
      const index = JSON.parse(new TextDecoder().decode(this.buf.subarray(4, 4 + size)));
      this.entries = new Map();
      let at = 4 + size;
      for (const [name, size, length] of index) {
        const e = { name, size, start: at, end: at + length };
        this.entries.set(name, e);
        this.order.push(e);
        at += length;
      }
      this.total = at;
      if (this.buf.length < at) {
        const whole = new Uint8Array(at);
        whole.set(this.buf.subarray(0, this.received));
        this.buf = whole;
      }
      for (const r of this._indexWaiters.splice(0)) r();
    }

    _arrived() {
      while (this.ready < this.order.length && this.order[this.ready].end <= this.received) {
        const e = this.order[this.ready++];
        const list = this._waiters.get(e.name);
        if (list) {
          this._waiters.delete(e.name);
          for (const r of list) r(this._bytes(e.name));
        }
      }
    }

    /** A file's bytes, if they are in. */
    _bytes(name) {
      const e = this.entries?.get(name);
      return e && e.end <= this.received ? this.buf.subarray(e.start, e.end) : null;
    }

    /** Bytes a second so far (null until there is a measure). */
    rate() {
      const ms = this.now() - this.started;
      return ms > 50 && this.received > 0 ? (this.received / ms) * 1000 : null;
    }

    /**
     * A file the guest asks for: its bytes from the pack, now or once they arrive if that is soon
     * (PACK_WAIT_MS at the rate the pack comes in); null if the pack doesn't hold it, or it is too
     * far off, and the file should be fetched on its own.
     */
    async get(name) {
      // The index is the pack's first bytes: worth waiting for, a little (a pack slow to start
      // mustn't hold the guest's reads; they fetch their files until it comes)
      if (!this.entries && !this.done) {
        let timer;
        await new Promise((r) => {
          this._indexWaiters.push(r);
          timer = setTimeout(r, this.indexWaitMs);
        });
        clearTimeout(timer);
      }
      const e = this.entries?.get(name);
      if (!e) return null;
      const now = this._bytes(name);
      if (now || this.done) return now;
      // Near enough at the rate it comes, or (no rate yet: it has only just started) within its next
      // PACK_WAIT_BYTES
      const rate = this.rate();
      const left = e.end - this.received;
      if (rate ? (left / rate) * 1000 > PACK_WAIT_MS : left > PACK_WAIT_BYTES) return null;
      return new Promise((resolve) => {
        const list = this._waiters.get(name) ?? [];
        list.push(resolve);
        this._waiters.set(name, list);
      });
    }

    /** The files whose bytes are in, from `from` on in pack order: { name, size, bytes } (size
     *  decompressed). */
    *arrivedFrom(from) {
      for (let i = from; i < this.ready; i++) {
        const e = this.order[i];
        yield { name: e.name, size: e.size, bytes: this._bytes(e.name) };
      }
    }

    /** Whether the pack holds a file (its bytes in, or coming). */
    holds(name) {
      return !!this.entries?.has(name);
    }

    /** Let the bytes go (the machine is gone). */
    release() {
      this.buf = new Uint8Array(0);
      this.entries = null;
      this.order = [];
    }
  }

  class Core {
    /**
     * `config` is armless's options with absolute URLs (located()), plus `warm` (the warm pack's
     * URL). `Armless` the class; `emit(event, payload)` where what it says goes.
     */
    constructor({ config, Armless = root.Armless, emit = () => {}, agent = root.SnowglobeAgent, transfer = root.SnowglobeTransfer,
      sessions = root.SnowglobeSessions, uploadWindow = 1, blobRetryDelays = [250, 1000] }) {
      this.config = config;
      this.Armless = Armless;
      this.emit = emit;
      this.sessions = sessions;
      this.vm = null;
      this.state = "idle"; // idle, loading, ready, stopped
      this.capturing = false;
      this.xfers = new Map();
      this.controller = null;
      this.failedBlobs = new Set();
      this.blobRetryDelays = blobRetryDelays;
      // The guest's files: the warm pack as it comes (warm()), what is being fetched (by name, the
      // guest's reads and reading ahead share a request), the reads waiting, and how it all went
      this.pack = null;
      this.inflight = new Map();
      this.demanded = new Set();
      this.fetchedNames = new Set(); // fetched for a read: armless has them, or is handing them over
      this.prefetchQueue = [];
      this.prefetching = 0;
      this.fileStats = { fromPack: 0, fetched: 0, fetchedBytes: 0, prefetched: 0, prefetchedBytes: 0 };
      // The job runner for any machine with agent.js loaded (its Controller says what it supports)
      if (agent) {
        const core = this;
        this.controller = new agent.Controller({ get emulator() { return core.vm; }, cpus: config.cpus, network: config.network ? "fetch" : "none",
          state: () => core.state, saving: () => core.capturing });
        this.controller.uploadWindow = uploadWindow;
        this.controller.finishedListeners.push((job) => emit("job", { jobId: job?.id ?? null, state: job?.state ?? null }));
        this.files = transfer?.overJobs((command, opts) => this._job(command, opts), { token: agent.token });
      }
    }

    /** A new machine from a state (a URL, or a Blob of a captured state packed with `encoding`,
     *  as capture() and saves have it), ready to run(). */
    async boot(initialState, encoding = "raw") {
      if (this.vm) throw new Error("the machine is already booted");
      let url = initialState;
      let made = null;
      if (typeof Blob !== "undefined" && initialState instanceof Blob) {
        const raw = encoding === "raw" ? initialState : await this.sessions.stateBlob({ encoding, state: initialState });
        url = made = URL.createObjectURL(raw);
      }
      this.state = "loading";
      let vm;
      try {
        // The guest's files through fetchBlob, so a blob store that can't be reached is said
        // (the guest only sees an I/O error)
        const filesystem = this.config.filesystem ? { ...this.config.filesystem, fetch_blob: (name) => this.fetchBlob(name) } : undefined;
        const { links, link_base: linkBase } = this.config;
        let network;
        if (this.config.network) {
          network = { ...this.config.network, fetch: (url, init) => guestFetch(url, init, links, linkBase) };
          // A link's tunnels (withLinks) are carried to the page: only those this machine was given
          const allowed = new Map();
          for (const t of this.config.network.tunnels ?? []) {
            const to = parseLinkUrl(t?.url);
            if (to) allowed.set(t.url, to);
          }
          const names = links && Object.keys(links).length ? links : null;
          if (allowed.size || names) network.WebSocket = linkSockets(this, allowed, this.WebSocket ?? root.WebSocket, root, names);
        }
        vm = new this.Armless({ fs_cache_mb: FS_CACHE_MB, ...this.config, filesystem, network, warm: undefined, initial_state: url,
          autostart: false });
        this.vm = vm;
        vm.on("progress", (e) => this.emit("progress", { file: e.file, loaded: e.loaded, total: e.total }));
        vm.on("console", (bytes) => { if (vm === this.vm) this.emit("console", bytes); });
        vm.on("stop", ({ reason }) => {
          if (vm !== this.vm) return;
          this.state = "stopped";
          this.emit("stop", { reason });
        });
        vm.on("error", (e) => { if (vm === this.vm) this.emit("error", errorOf(e)); });
        this.controller?.bind(vm);
        await vm.ready;
      } catch (e) {
        try { vm?.destroy(); } catch {}
        if (this.vm === vm) this.vm = null;
        this.state = "idle";
        throw e;
      } finally {
        if (made) URL.revokeObjectURL(made);
      }
      return true;
    }

    /** Retry transient download failures before handing an I/O failure to the guest filesystem. */
    async _fetchBytes(url, timeoutMs = 30000) {
      for (let attempt = 0; ; attempt++) {
        const controller = new AbortController();
        let timer, reader;
        // A large warm pack can take minutes over a device/VPN connection. Time
        // out stalled I/O, rather than aborting a download that is progressing.
        const arm = () => {
          clearTimeout(timer);
          timer = setTimeout(() => controller.abort(new DOMException(`Environment download stalled: ${new URL(url, "https://runtime.invalid/").pathname}`, "TimeoutError")), timeoutMs);
        };
        const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
        try {
          arm();
          const r = await Promise.race([(this.fetch ?? fetch)(url, { signal: controller.signal, ...(attempt ? { cache: "reload" } : {}) }), aborted]);
          if (!r.ok) {
            const error = new Error(`${r.status} ${r.statusText ?? ""}`.trim());
            error.retryable = r.status >= 500 || r.status === 408 || r.status === 429;
            throw error;
          }
          arm();
          if (!r.body?.getReader) return new Uint8Array(await Promise.race([r.arrayBuffer(), aborted]));
          reader = r.body.getReader();
          const chunks = [];
          let length = 0;
          for (;;) {
            const { value, done } = await Promise.race([reader.read(), aborted]);
            if (done) break;
            if (value.byteLength) { arm(); chunks.push(value); length += value.byteLength; }
          }
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
          return bytes;
        } catch (e) {
          if (e.retryable === false || attempt >= this.blobRetryDelays.length) throw e;
          await new Promise(resolve => setTimeout(resolve, this.blobRetryDelays[attempt]));
        } finally {
          clearTimeout(timer);
          if (controller.signal.aborted) reader?.cancel().catch(() => {});
          else reader?.releaseLock();
        }
      }
    }

    /** A final failure emits `blobs` once until another file succeeds, and remains repairable. */
    async fetchBlob(name) {
      // From the warm pack, if it holds the file and brings it soon
      const packed = await this.pack?.get(name);
      if (packed) {
        this.failedBlobs.delete(name);
        this.fileStats.fromPack++;
        this._filesChanged();
        return packed;
      }
      this.demanded.add(name);
      try {
        // A file a read-ahead is already fetching: the same request
        let bytes = this.inflight.get(name);
        if (!bytes) {
          bytes = this._fetchBlob(name);
          this.inflight.set(name, bytes);
          this.fetchedNames.add(name);
          bytes.then(() => {}, () => this.fetchedNames.delete(name)).finally(() => this.inflight.delete(name)).catch(() => {});
          this.fileStats.fetched++;
          this._filesChanged();
          this._readAhead(name).catch(() => {});
        }
        const b = await bytes;
        this.fileStats.fetchedBytes += b.length;
        this._filesChanged();
        return b;
      } finally {
        this.demanded.delete(name);
      }
    }

    /** One file from the blob store, as fetchBlob says it. */
    async _fetchBlob(name) {
      const base = this.config.filesystem?.baseurl ?? "";
      const url = new URL(name, typeof location !== "undefined" ? new URL(base, location.href) : base).href;
      try {
        const bytes = await this._fetchBytes(url);
        this.failedBlobs.delete(name);
        if (this.blobsDown) {
          this.blobsDown = false;
          this.emit("blobs", { ok: true });
        }
        return bytes;
      } catch (e) {
        this.failedBlobs.add(name);
        if (!this.blobsDown) {
          this.blobsDown = true;
          this.emit("blobs", { ok: false, url: base, message: String(e?.message ?? e) });
        }
        throw e;
      }
    }

    /** Repair failed immutable image downloads in place. Project files and VM state stay intact.
     * A restored machine can have uncached image files without any JS failure records;
     * when no failed names are known, refill its missing warm-pack files. */
    async recoverFiles() {
      const vm = this.vm;
      if (!vm || this.state !== "ready") throw new Error("the machine is not ready to restore its files");
      const failed = [...this.failedBlobs];
      for (const name of failed) {
        const bytes = await this.fetchBlob(name);
        if (vm !== this.vm) throw new Error("the machine changed while restoring files");
        vm.provide_blob(name, bytes);
      }
      const warmed = failed.length ? 0 : await this.warm({ required: true });
      return { repaired: failed.length + warmed };
    }

    // ---------------------------------------------------------------- reading ahead
    //
    // A read the pack couldn't serve waits for its own request, and the guest's next read starts
    // only after it: one at a time. A large file is stored in chunks and read chunk after chunk, so
    // the chunks after the one asked for are fetched alongside (READ_AHEAD at once, at most
    // READ_AHEAD_BYTES a machine) and handed to the machine before the guest asks: a filesystem's
    // sequential read-ahead. The machine's own filesystem.json (which armless has loaded already,
    // so the browser has it) says which chunks make a file.

    /** The chunks of `filesystem.json`'s large files by blob: { chunks, at }. */
    async _fsIndex() {
      this._fsIndexing ??= (async () => {
        const url = this.config.filesystem?.json;
        if (!url) return null;
        const r = await (this.fetch ?? fetch)(url);
        if (!r.ok) return null;
        const root = await r.json();
        const byBlob = new Map();
        const walk = (nodes) => {
          for (const [, , , mode, , , target] of nodes ?? []) {
            const kind = mode & 0o170000;
            if (kind === 0o040000) walk(target);
            else if (kind === 0o100000 && Array.isArray(target)) {
              const chunks = target.map(([blob]) => blob);
              chunks.forEach((blob, at) => { if (!byBlob.has(blob)) byBlob.set(blob, { chunks, at }); });
            }
          }
        };
        walk(root?.fsroot);
        return { byBlob };
      })().catch(() => null);
      return this._fsIndexing;
    }

    /** Fetch the chunks after `name`, if it is a chunk of a large file just fetched on its own. */
    async _readAhead(name) {
      const index = await this._fsIndex();
      const f = index?.byBlob.get(name);
      if (!f) return;
      for (const blob of f.chunks.slice(f.at + 1, f.at + 1 + CHUNKS_AHEAD)) this._prefetch(blob);
    }

    /** Queue one file to fetch ahead, unless it is in, coming, or past the budget. */
    _prefetch(name) {
      const vm = this.vm;
      if (!vm || this.inflight.has(name) || this.fetchedNames.has(name) || this.prefetchQueue.includes(name) || vm.has_blob(name)) return;
      // The pack brings what it holds, or has it (a read takes it from there)
      if (this.pack?.holds(name)) return;
      if (this.fileStats.prefetchedBytes >= READ_AHEAD_BYTES) return;
      this.prefetchQueue.push(name);
      this._prefetchPump();
    }

    _prefetchPump() {
      while (this.prefetching < READ_AHEAD && this.prefetchQueue.length) {
        const name = this.prefetchQueue.shift();
        const vm = this.vm;
        if (!vm || vm.has_blob(name) || this.inflight.has(name)) continue;
        this.prefetching++;
        const bytes = this._fetchBlob(name);
        this.inflight.set(name, bytes);
        bytes.then((b) => {
          this.fileStats.prefetched++;
          this.fileStats.prefetchedBytes += b.length;
          // Into the machine, unless the guest asked meanwhile (its read hands it over itself)
          if (vm === this.vm && !vm.stopped && !this.demanded.has(name) && !vm.has_blob(name)) vm.provide_blob(name, b);
        }, () => {}).finally(() => {
          this.inflight.delete(name);
          this.prefetching--;
          this._filesChanged();
          this._prefetchPump();
        });
      }
    }

    /** How the machine's files are coming: a `files` event, at most every FILES_EVERY_MS. */
    filesStatus() {
      const p = this.pack;
      return {
        warm: p ? { loaded: p.received, total: p.total, done: p.done } : null,
        fromPack: this.fileStats.fromPack,
        fetched: this.fileStats.fetched,
        fetchedBytes: this.fileStats.fetchedBytes,
        prefetched: this.fileStats.prefetched,
        prefetchedBytes: this.fileStats.prefetchedBytes,
      };
    }

    _filesChanged() {
      if (this._filesTimer) return;
      const since = Date.now() - (this._filesAt ?? 0);
      const send = () => {
        this._filesTimer = null;
        this._filesAt = Date.now();
        this.emit("files", this.filesStatus());
      };
      if (since >= FILES_EVERY_MS) send();
      else this._filesTimer = setTimeout(send, FILES_EVERY_MS - since);
    }

    /** Run it, and fill its file cache in the background. */
    run() {
      this.vm.run();
      this.state = "ready";
      this.warm().catch(() => {});
      return true;
    }

    input(data) { this.vm?.console_input(data); }
    resize(cols, rows) { this.vm?.console_resize(cols, rows); }

    /** Stop it and capture its state, packed (gzip where the browser can): { encoding, state: Blob }.
     *  It stays stopped (a suspend: destroy() next); keepRunning runs it again (a save). */
    async capture({ keepRunning = false } = {}) {
      const vm = this.vm;
      if (!vm) throw new Error("no machine to capture");
      this.capturing = true;
      try {
        await vm.stop();
        // In pieces where the machine gives them (packState takes them as they are): never in one
        // buffer, in the machine's memory or this page's
        let bytes = vm.save_state_pieces ? await vm.save_state_pieces() : [await vm.save_state()];
        const packed = this.sessions ? await this.sessions.packState(bytes) : { encoding: "raw", state: new Blob(bytes) };
        bytes = null;
        return packed;
      } catch (e) {
        vm.run();
        throw e;
      } finally {
        this.capturing = false;
        if (keepRunning && this.vm === vm && !vm.running) vm.run();
      }
    }

    /** End the machine (its timers and any workers) and drop it, so its memory can go. */
    destroy() {
      const vm = this.vm;
      // Its connections end first, each said closed (armless's abort() says so at once), so the
      // page hears of every one before the machine goes
      for (const c of [...(this.tcp?.values() ?? [])]) {
        try { c.abort(); } catch {}
      }
      // Its link connections too: the page lets go of what each held in the machine it reached
      for (const [cid, s] of [...(this.links?.entries() ?? [])]) {
        s._drop();
        this.emit("link", { cid, kind: "close" });
      }
      this.links?.clear();
      // The warm pack's bytes go with the machine they were for
      this.pack?.release();
      this.pack = null;
      this.vm = null;
      this.state = "idle";
      this.tcp?.clear();
      try { vm?.destroy(); } catch {}
      return vm ? { wasmBytes: vm.memory?.buffer?.byteLength ?? null } : null;
    }

    /** How much memory the machine holds: its WebAssembly memory. */
    memory() {
      return { wasmBytes: this.vm?.memory?.buffer?.byteLength ?? 0 };
    }

    // The guest's files are fetched one blocking request at a time the first time each is read.
    // warm.pack bundles the files the app is most likely to need into one background download, read
    // as it arrives (WarmPack): its first files go into the machine once their bytes are in, and a
    // read of one the pack holds takes it from there (fetchBlob) instead of a request of its own.
    async warm({ required = false } = {}) {
      const vm = this.vm;
      if (!this.config.warm || !vm) {
        if (required) throw new Error("no environment file pack is configured");
        return 0;
      }
      if (required && vm.stopped) throw new Error("the machine stopped while restoring files");
      this.warmedVms ??= new WeakSet();
      if (this.warmedVms.has(vm)) return 0;
      let warming = this.warming;
      if (!warming || warming.vm !== vm) {
        warming = { vm, promise: this._warm(vm) };
        this.warming = warming;
        warming.promise.finally(() => { if (this.warming === warming) this.warming = null; }).catch(() => {});
      }
      const result = await warming.promise;
      if (required && (vm.stopped || vm !== this.vm)) throw new Error("the machine stopped while restoring files");
      if (required && result.error) throw result.error;
      if (result.complete) this.warmedVms.add(vm);
      return result.supplied;
    }

    async _warm(vm) {
      const pack = this.pack = new WarmPack(this.packOptions ?? {});
      this._filesChanged();
      let given = 0, supplied = 0;
      let givenBytes = 0;
      const gone = () => vm.stopped || vm !== this.vm;
      // Hand over what has arrived, a slice of time at a time, so the machine (and a page sharing
      // this thread) keeps running between slices: the pack's first files, up to PACK_GIVE_BYTES
      // (the machine's cache holds little more), the rest kept in the pack for the guest's reads
      const feed = async () => {
        for (;;) {
          const until = pack.now() + PACK_SLICE_MS;
          let any = false;
          for (const { name, size, bytes } of pack.arrivedFrom(given)) {
            if (gone()) return;
            given++;
            if (givenBytes >= PACK_GIVE_BYTES) continue;
            any = true;
            givenBytes += size ?? bytes.length;
            if (!vm.has_blob(name)) { vm.provide_blob(name, bytes); supplied++; } // else the guest already has it
            this.failedBlobs.delete(name);
            if (pack.now() >= until) break;
          }
          this._filesChanged();
          if (!any) return;
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      };
      let feeding = Promise.resolve();
      const kick = () => { feeding = feeding.then(feed); };
      const controller = new AbortController();
      let timer, reader, failure;
      const arm = () => {
        clearTimeout(timer);
        timer = setTimeout(() => controller.abort(new DOMException("Environment warm-pack download stalled", "TimeoutError")), 60000);
      };
      const aborted = new Promise((_, reject) => controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true }));
      try {
        arm();
        const response = await Promise.race([(this.fetch ?? fetch)(this.config.warm, { signal: controller.signal }), aborted]);
        if (!response.ok) throw new Error(`${response.status}`);
        arm();
        if (response.body?.getReader) {
          reader = response.body.getReader();
          for (;;) {
            const { done, value } = await Promise.race([reader.read(), aborted]);
            if (done || gone()) break;
            if (value.byteLength) arm();
            pack.push(value);
            kick();
          }
        } else {
          pack.push(new Uint8Array(await Promise.race([response.arrayBuffer(), aborted])));
        }
        if (!gone() && (!pack.entries || pack.received < pack.total)) throw new Error("Environment warm-pack download was incomplete");
        pack.end(!gone());
      } catch (error) {
        failure = error;
        pack.end(false); // what didn't arrive, reads fetch themselves
      } finally {
        clearTimeout(timer);
        if (controller.signal.aborted || gone()) reader?.cancel().catch(() => {});
        else reader?.releaseLock();
      }
      // What did arrive goes in, up to the budget; the pack stays (compressed, in this page) for the
      // files that didn't, and for those the machine's cache lets go, until the machine goes
      kick();
      await feeding.catch(error => { failure ??= error; });
      if (this.pack === pack) this._filesChanged();
      const complete = !failure && !gone() && pack.entries && pack.received >= pack.total;
      if (complete && this.blobsDown && !this.failedBlobs.size) {
        this.blobsDown = false;
        this.emit("blobs", { ok: true });
      }
      return { supplied, complete: !!complete, error: failure };

    }

    // ------------------------------------------------------------------ jobs and files

    _agent() {
      if (!this.controller) throw new Error("agent jobs need the agent scripts");
      return this.controller;
    }

    runCommand(input) { return this._agent().runCommand(input); }
    readJob(id) { return this._agent().readJob(id); }
    cancelJob(id) { return this._agent().cancelJob(id); }
    status() { return this._agent().status(); }

    /** A job run to its end: its view. Rejects unless it exited 0; `signal` cancels it. */
    async _job(command, { files, signal } = {}) {
      const c = this._agent();
      const { jobId } = c.runCommand({ command, files, timeoutSeconds: 600 });
      const view = await new Promise((resolve) => {
        const check = () => {
          const v = c.readJob(jobId);
          if (v.state === "running") return false;
          c.finishedListeners.splice(c.finishedListeners.indexOf(listener), 1);
          signal?.removeEventListener?.("abort", abort);
          resolve(v);
          return true;
        };
        const listener = () => check();
        const abort = () => { try { c.cancelJob(jobId); } catch {} };
        c.finishedListeners.push(listener);
        signal?.addEventListener?.("abort", abort);
        check();
      });
      if (view.state === "cancelled") {
        const e = new Error("cancelled");
        e.name = "AbortError";
        throw e;
      }
      if (view.state !== "exited" || view.exitStatus !== 0) {
        const tail = view.output.trim().split("\n").slice(-3).join(" ").slice(0, 300);
        throw new Error(`a transfer job ${view.state === "exited" ? `exited ${view.exitStatus}` : view.state}${view.error ? `: ${view.error}` : ""}${tail ? ` (${tail})` : ""}`);
      }
      return view;
    }

    _xfer(xid, fn) {
      const controller = new AbortController();
      this.xfers.set(xid, controller);
      return fn({ signal: controller.signal, onProgress: (p) => this.emit("xfer", { xid, ...p }) })
        .finally(() => this.xfers.delete(xid));
    }

    /** { blob, size, sha256 } of a file in the machine. */
    readFile(xid, path) {
      if (!this.files) this._agent();
      return this._xfer(xid, (o) => this.files.read(path, o));
    }

    /** { size, sha256 }: `blob` written to `path` in the machine, checked there before it lands. */
    writeFile(xid, path, blob, sha256) {
      if (!this.files) this._agent();
      return this._xfer(xid, (o) => this.files.write(path, blob, { ...o, sha256 }));
    }

    abort(xid) {
      this.xfers.get(xid)?.abort();
      return true;
    }

    // ------------------------------------------------------------------ TCP into the machine

    /**
     * A TCP connection from the page to `port` on the machine's network address (armless's
     * connect(): a machine with a network device). Its id comes back at once; what happens on it
     * is said as `tcp` events { sid, kind: "connect" | "data" | "end" | "close", bytes? }. A close
     * with no connect before it: nothing listens there.
     */
    tcpOpen(port) {
      const vm = this.vm;
      if (!vm || this.state !== "ready") throw new Error("the machine is not running");
      if (!this.config.network) throw new Error("the machine has no network device, so nothing in it can be connected to");
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port: 1 to 65535");
      this.tcp ??= new Map();
      const sid = (this.tcpNext = (this.tcpNext ?? 0) + 1);
      const conn = vm.connect(port);
      this.tcp.set(sid, conn);
      const say = (kind, bytes) => {
        if (vm !== this.vm) return;
        this.emit("tcp", bytes ? { sid, kind, bytes } : { sid, kind });
      };
      conn.on("connect", () => say("connect"));
      // A copy: armless's bytes may be a view into its memory
      conn.on("data", (bytes) => say("data", new Uint8Array(bytes)));
      conn.on("end", () => say("end"));
      conn.on("close", () => {
        this.tcp?.delete(sid);
        say("close");
      });
      return sid;
    }

    /** Resolves once the guest has taken most of what was written (armless's drain(): at most
     *  about 1 MiB left buffered towards it), so the page can tell how much is still on its way. */
    async tcpWrite(sid, bytes) {
      const c = this.tcp?.get(sid);
      if (!c) throw new Error(`no connection ${sid}`);
      c.write(bytes);
      if (typeof c.drain === "function") await c.drain();
      return true;
    }

    /** Close the page's side, after what was written. */
    tcpEnd(sid) {
      this.tcp?.get(sid)?.close();
      return true;
    }

    tcpAbort(sid) {
      const c = this.tcp?.get(sid);
      this.tcp?.delete(sid);
      try { c?.abort(); } catch {}
      return true;
    }

    // ------------------------------------------------------------------ TCP out over a link

    _linkAdd(socket) {
      this.links ??= new Map();
      const cid = (this.linkNext = (this.linkNext ?? 0) + 1);
      this.links.set(cid, socket);
      return cid;
    }

    _linkDelete(cid) { this.links?.delete(cid); }

    /**
     * What the page says about link connection `cid` (one the guest opened: a `link` event
     * { cid, kind: "open", runtime, port }): "connect", "data" (bytes), "end", "close" or "error".
     * Resolves once armless has it (so the page can count what is still on its way); one for a
     * connection already over is dropped.
     */
    linkIn(cid, kind, bytes) {
      const s = this.links?.get(cid);
      if (!s) return false;
      // Never inside the call that opened it (inline, the page may answer at once): armless sets
      // the socket's handlers just after making it, and a WebSocket's events come later anyway
      return new Promise((resolve) => queueMicrotask(() => {
        s._hear(kind, bytes);
        resolve(true);
      }));
    }
  }

  const SnowglobeMachineCore = { Core, WarmPack, located, errorOf, guestFetch, linked, linkUrl, parseLinkUrl, linkSockets, linkPipe, wsLinked, LINK_URL, LINK_LINGER_MS };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeMachineCore;
  else root.SnowglobeMachineCore = SnowglobeMachineCore;
})(typeof window !== "undefined" ? window : globalThis);
