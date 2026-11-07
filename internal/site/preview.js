// The agent page's preview: a machine's web server, seen in the page. HTTP only, no WebSockets.
//
// The page's service worker (agent-sw.js) takes every request under <agent page>/preview/
// <runtime>/<port>/<path> and hands it to the agent page (a MessageChannel per request); the page
// opens a TCP connection to <port> on the machine (armless's connect(), in the machine's worker),
// writes the request as HTTP/1.1 with Connection: close, reads the response as it comes, and sends
// its status, headers and body back to the service worker, which answers with a Response.
//
// This file is both halves' shared part, with nothing that touches a machine or the DOM: the
// address's route, the request written as bytes, the response parsed as it arrives (a length,
// chunked, or up to the close), a redirect's Location kept inside the preview, the error pages,
// and serve(): one request over one connection.
(function (root) {
  "use strict";

  const PREFIX = "preview/";
  const RUNTIME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
  // A request's body, in bytes: a form, a JSON call (a page's files go in some other way)
  const MAX_BODY = 8 << 20;
  // A response's head (status line and headers), in bytes
  const MAX_HEAD = 64 << 10;
  // How long the machine gets to accept the connection, and to start answering
  const CONNECT_MS = 10000;
  const ANSWER_MS = 180000;
  // How long a body may go without a byte, once the answer started, before it is given up
  const IDLE_MS = 60000;
  // Statuses whose answer has no body (a Response with one can't be made)
  const NO_BODY = new Set([204, 205, 304]);

  // Headers that are about one connection, not the request (and Host, written for the guest)
  const HOP = new Set(["connection", "keep-alive", "proxy-connection", "proxy-authenticate", "proxy-authorization", "te", "trailer",
    "transfer-encoding", "upgrade", "host", "content-length", "accept-encoding"]);
  // What a page can't be given back from a service worker (cookies), or that describes the bytes
  // as they came over the connection rather than as they are handed on
  const DROP = new Set(["connection", "keep-alive", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade", "content-length",
    "set-cookie", "set-cookie2"]);
  const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

  /** Bytes of a header block: each character one byte (header values are byte strings; the
   *  page's are already, and a character beyond U+00FF can't be sent). */
  function latin1Bytes(text) {
    const out = new Uint8Array(text.length);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (c > 0xff) throw new Error(`a character that is not a byte in a request's head: ${JSON.stringify(text[i])}`);
      out[i] = c;
    }
    return out;
  }

  /** Bytes as a byte string: each byte one character, U+0000 to U+00FF (TextDecoder's "latin1"
   *  is windows-1252, which changes 0x80 to 0x9F). */
  function latin1Text(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return s;
  }

  /** A reason phrase a Response accepts: tab, space, visible ASCII and obs-text only. */
  function reasonPhrase(text) {
    return String(text ?? "").replace(/[^\t\x20-\x7e\x80-\xff]/g, "").slice(0, 256);
  }

  /** The DecompressionStream format for a response's Content-Encoding the page can undo (gzip,
   *  deflate), or null (none, or one it can't: passed on as it is). */
  function decoding(headers) {
    const v = headers.filter(([k]) => k.toLowerCase() === "content-encoding").map(([, x]) => x.trim().toLowerCase()).filter((x) => x && x !== "identity");
    if (v.length !== 1) return null;
    if (v[0] === "gzip" || v[0] === "x-gzip") return "gzip";
    if (v[0] === "deflate") return "deflate";
    return null;
  }

  /**
   * The preview a URL is for: { runtime, port, path (with its query), prefix (the preview's
   * root, an absolute path ending in the port) }, or null when it isn't under `scope`'s preview/.
   * `slash: false` when the address ends at the port: the preview's root is <port>/, with a slash,
   * so a page's relative links resolve inside it.
   */
  function route(url, scope) {
    const u = typeof url === "string" ? new URL(url) : url;
    const s = typeof scope === "string" ? new URL(scope) : scope;
    if (u.origin !== s.origin) return null;
    const base = s.pathname.endsWith("/") ? s.pathname : s.pathname.replace(/[^/]*$/, "");
    if (!u.pathname.startsWith(base + PREFIX)) return null;
    const rest = u.pathname.slice(base.length + PREFIX.length);
    const m = /^([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
    if (!m) return { error: "an address of the form preview/<runtime>/<port>/<path>" };
    const [, runtime, portText, path] = m;
    if (!RUNTIME.test(runtime)) return { error: `${JSON.stringify(runtime)} is not a runtime's name` };
    if (!/^\d{1,5}$/.test(portText) || +portText < 1 || +portText > 65535) return { error: `${JSON.stringify(portText)} is not a port (1 to 65535)` };
    const prefix = `${base}${PREFIX}${runtime}/${+portText}`;
    return { runtime, port: +portText, path: (path ?? "/") + u.search, prefix, slash: path !== undefined };
  }

  /** The address of a preview: `page` the agent page's address, `path` inside the preview. */
  function previewUrl(page, runtime, port, path = "/") {
    if (!RUNTIME.test(String(runtime))) throw new Error("runtime: a runtime's name, as list_runtimes gives it");
    const p = checkPort(port);
    const inside = checkPath(path);
    return new URL(`${PREFIX}${runtime}/${p}${inside}`, new URL("./", page)).href;
  }

  function checkPort(port) {
    const p = typeof port === "string" && /^\d+$/.test(port) ? Number(port) : port;
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error("port: the port a server in the machine listens on, 1 to 65535");
    return p;
  }

  function checkPath(path) {
    if (path === undefined || path === null || path === "") return "/";
    if (typeof path !== "string" || !path.startsWith("/") || /[\s\x00-\x1f]/.test(path) || path.startsWith("//")) {
      throw new Error("path: a path in the preview, starting with /, e.g. /index.html");
    }
    return path;
  }

  /**
   * The request as HTTP/1.1, to a server in the machine on `port`: its head (Uint8Array), which
   * the body (if any) follows. Connection: close, and identity encoding (the page hands the bytes
   * on as they come). Header names and values with line breaks are refused (no request smuggling).
   */
  function requestHead({ method = "GET", path = "/", headers = [], port, bodyLength = 0 }) {
    if (!TOKEN.test(method)) throw new Error(`not a method: ${JSON.stringify(method)}`);
    if (typeof path !== "string" || !path.startsWith("/") || /[\s\x00-\x1f\x7f]/.test(path)) throw new Error(`not a path: ${JSON.stringify(path)}`);
    let head = `${method} ${path} HTTP/1.1\r\nHost: localhost:${port}\r\n`;
    for (const [name, value] of headers) {
      if (!TOKEN.test(name)) throw new Error(`not a header name: ${JSON.stringify(name)}`);
      if (/[\r\n\0]/.test(value)) throw new Error(`header ${name}: a line break in its value`);
      if (HOP.has(name.toLowerCase())) continue;
      head += `${name}: ${value}\r\n`;
    }
    head += "Accept-Encoding: identity\r\nConnection: close\r\n";
    if (bodyLength > 0 || !["GET", "HEAD", "OPTIONS", "DELETE"].includes(method)) head += `Content-Length: ${bodyLength}\r\n`;
    return latin1Bytes(head + "\r\n");
  }

  function concat(a, b) {
    if (!a.length) return b;
    const out = new Uint8Array(a.length + b.length);
    out.set(a);
    out.set(b, a.length);
    return out;
  }

  function indexOfCrlfCrlf(bytes, from) {
    for (let i = Math.max(0, from); i + 3 < bytes.length; i++) {
      if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) return i;
    }
    return -1;
  }

  function indexOfCrlf(bytes, from) {
    for (let i = from; i + 1 < bytes.length; i++) if (bytes[i] === 13 && bytes[i + 1] === 10) return i;
    return -1;
  }

  /**
   * An HTTP/1.1 response, parsed as its bytes arrive. push(bytes) and close() (the connection
   * ended) return what is now known, in order: { type: "head", status, statusText, headers: [[name,
   * value]] }, { type: "data", bytes }, { type: "end" }. Informational answers (100 Continue) are
   * skipped. The body is as long as Content-Length says, or chunked, or (neither) up to the close.
   * A malformed or cut-short response throws.
   */
  class ResponseParser {
    constructor({ method = "GET" } = {}) {
      this.method = method;
      this.buf = new Uint8Array(0);
      this.state = "head"; // head, length, chunk-size, chunk-data, chunk-end, trailers, close, done
      this.left = 0;
      this.ended = false;
    }

    push(bytes) {
      if (this.state === "done") return [];
      this.buf = concat(this.buf, bytes);
      return this._run();
    }

    close() {
      const out = this.state === "done" ? [] : this._run();
      if (this.state === "close") {
        this.state = "done";
        out.push({ type: "end" });
        return out;
      }
      if (this.state === "done") return out;
      if (this.state === "head") throw new Error(this.buf.length ? "the server's answer was cut short in its headers" : "the server closed the connection without answering");
      throw new Error("the server's answer was cut short in its body");
    }

    _run() {
      const out = [];
      for (;;) {
        switch (this.state) {
          case "head": {
            const end = indexOfCrlfCrlf(this.buf, 0);
            if (end < 0) {
              if (this.buf.length > MAX_HEAD) throw new Error("the server's headers are too long");
              return out;
            }
            const text = latin1Text(this.buf.subarray(0, end));
            this.buf = this.buf.slice(end + 4);
            const lines = text.split("\r\n");
            const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0]);
            if (!m) throw new Error(`not an HTTP response: ${JSON.stringify(lines[0].slice(0, 80))}`);
            const status = +m[1];
            if (status < 100 || status > 599) throw new Error(`a status out of range: ${status}`);
            const headers = [];
            for (const line of lines.slice(1)) {
              const at = line.indexOf(":");
              if (at <= 0) throw new Error(`a malformed header: ${JSON.stringify(line.slice(0, 80))}`);
              headers.push([line.slice(0, at).trim(), line.slice(at + 1).trim()]);
            }
            if (status >= 100 && status < 200) continue; // 100 Continue, 103 Early Hints: the real answer follows
            out.push({ type: "head", status, statusText: reasonPhrase(m[2]), headers });
            const get = (n) => headers.filter(([k]) => k.toLowerCase() === n).map(([, v]) => v);
            const te = get("transfer-encoding").join(",").toLowerCase();
            const cl = get("content-length");
            if (this.method === "HEAD" || NO_BODY.has(status)) {
              this.state = "done";
            } else if (/\bchunked\b/.test(te)) {
              this.state = "chunk-size";
            } else if (cl.length) {
              const n = Number(cl[0]);
              if (!Number.isSafeInteger(n) || n < 0 || cl.some((v) => v !== cl[0])) throw new Error(`a malformed Content-Length: ${cl.join(", ")}`);
              this.left = n;
              this.state = n > 0 ? "length" : "done";
            } else {
              this.state = "close";
            }
            if (this.state === "done") {
              out.push({ type: "end" });
              return out;
            }
            continue;
          }
          case "length": {
            if (!this.buf.length) return out;
            const take = this.buf.subarray(0, this.left);
            this.buf = this.buf.slice(take.length);
            this.left -= take.length;
            out.push({ type: "data", bytes: take.slice() });
            if (this.left === 0) {
              this.state = "done";
              out.push({ type: "end" });
              return out;
            }
            continue;
          }
          case "close": {
            if (this.buf.length) {
              out.push({ type: "data", bytes: this.buf });
              this.buf = new Uint8Array(0);
            }
            return out;
          }
          case "chunk-size": {
            const end = indexOfCrlf(this.buf, 0);
            if (end < 0) {
              if (this.buf.length > 1024) throw new Error("a malformed chunk size");
              return out;
            }
            const line = latin1Text(this.buf.subarray(0, end)).split(";")[0].trim();
            if (!/^[0-9a-fA-F]{1,12}$/.test(line)) throw new Error(`a malformed chunk size: ${JSON.stringify(line.slice(0, 20))}`);
            this.buf = this.buf.slice(end + 2);
            this.left = parseInt(line, 16);
            this.state = this.left === 0 ? "trailers" : "chunk-data";
            continue;
          }
          case "chunk-data": {
            if (!this.buf.length) return out;
            const take = this.buf.subarray(0, this.left);
            this.buf = this.buf.slice(take.length);
            this.left -= take.length;
            out.push({ type: "data", bytes: take.slice() });
            if (this.left === 0) this.state = "chunk-end";
            continue;
          }
          case "chunk-end": {
            if (this.buf.length < 2) return out;
            if (this.buf[0] !== 13 || this.buf[1] !== 10) throw new Error("a chunk not followed by a line break");
            this.buf = this.buf.slice(2);
            this.state = "chunk-size";
            continue;
          }
          case "trailers": {
            // Trailers (ignored), up to an empty line
            const end = indexOfCrlf(this.buf, 0);
            if (end < 0) return out;
            this.buf = this.buf.slice(end + 2);
            if (end === 0) {
              this.state = "done";
              out.push({ type: "end" });
              return out;
            }
            continue;
          }
          default:
            return out;
        }
      }
    }
  }

  /**
   * A redirect's Location, kept inside the preview: a path on the server (/login) and an absolute
   * address on the machine itself (http://localhost:<port>/login, 127.0.0.1, 0.0.0.0) become the
   * same place under `prefix` (/snowglobe/agent/preview/<runtime>/<port>) on `origin`. Anything
   * else (another site, a relative path) is left as it is.
   */
  function rewriteLocation(value, { prefix, port, origin }) {
    if (typeof value !== "string" || !value) return value;
    if (value.startsWith("/") && !value.startsWith("//")) return prefix + value;
    const m = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::(\d+))?(\/[^]*)?$/i.exec(value);
    if (m) {
      const p = m[2] ? +m[2] : value.toLowerCase().startsWith("https") ? 443 : 80;
      if (p === port) return (origin ?? "") + prefix + (m[3] ?? "/");
    }
    return value;
  }

  /** A response's headers as the page gets them: per connection ones dropped, Location kept inside. */
  function responseHeaders(headers, ctx) {
    const out = [];
    for (const [k, v] of headers) {
      const name = k.toLowerCase();
      if (DROP.has(name)) continue;
      out.push([k, name === "location" || name === "content-location" ? rewriteLocation(v, ctx) : v]);
    }
    return out;
  }

  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** A small HTML page that says what went wrong: { status, statusText, headers, body (string) }. */
  function errorPage(status, title, detail, { back } = {}) {
    const body = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n` +
      `<title>${status} ${escapeHtml(title)} · snowglobe preview</title>\n` +
      `<style>body{font:16px/1.5 system-ui,sans-serif;max-width:38rem;margin:12vh auto;padding:0 20px;color:#151513;background:#fafaf7}` +
      `h1{font-size:22px;margin:0 0 10px}p{margin:0 0 12px;color:#4a4a46}code{font:14px ui-monospace,Menlo,monospace}b{color:#151513}` +
      `@media (prefers-color-scheme:dark){body{background:#0d0d0c;color:#ecece8}p{color:#a2a29c}b{color:#ecece8}}</style>\n</head>\n<body>\n` +
      `<p><b>${status}</b> · snowglobe preview</p>\n<h1>${escapeHtml(title)}</h1>\n<p>${escapeHtml(detail)}</p>\n` +
      (back ? `<p><a href="${escapeHtml(back)}" target="_top">Back to the agent page</a></p>\n` : "") + `</body>\n</html>\n`;
    const statusText = { 400: "Bad Request", 403: "Forbidden", 404: "Not Found", 413: "Payload Too Large", 502: "Bad Gateway", 503: "Service Unavailable", 504: "Gateway Timeout" }[status] ?? "";
    return { status, statusText, headers: [["Content-Type", "text/html; charset=utf-8"], ["Cache-Control", "no-store"]], body };
  }

  /**
   * One request to a server in a machine, over one connection, its answer sent as it comes:
   * `send(message, transfer)` gets { type: "head", status, statusText, headers }, then { type:
   * "data", bytes } (as many as there are), then { type: "end" }; or, if no answer started,
   * { type: "error", status, statusText, headers, body } (an error page), or once one has,
   * { type: "abort", message }.
   *
   * `open(port)` is a machine's connection (machine-host.js's tcpOpen): { onconnect, ondata, onend,
   * onclose, onerror, write(bytes), end(), abort() }. `req` is { port, method, path, headers: [[k, v]], body
   * (Uint8Array, optional), prefix (the preview's root), origin, runtime }. Resolves once it is over;
   * `signal` aborts it (the page that asked went away).
   */
  function serve(open, req, send, { connectMs = CONNECT_MS, answerMs = ANSWER_MS, idleMs = IDLE_MS, timers = root, signal } = {}) {
    const ctx = { prefix: req.prefix, port: req.port, origin: req.origin };
    const what = `${req.runtime ?? "the machine"}'s port ${req.port}`;
    return new Promise((resolve) => {
      let started = false;
      let done = false;
      let connected = false;
      let conn = null;
      let timer = null;
      // One timer at a time: to connect, to start answering, then between a body's bytes. Not
      // unref'd: the request is waiting on it, and it is cleared when the request ends
      const arm = (ms, fn) => {
        if (timer !== null) timers.clearTimeout(timer);
        timer = timers.setTimeout(fn, ms);
      };
      const idle = () => arm(idleMs, () => fail(504, "No answer", `${what} stopped sending its answer: nothing for ${idleMs / 1000} s`));
      const parser = new ResponseParser({ method: req.method });
      const finish = () => {
        done = true;
        if (timer !== null) timers.clearTimeout(timer);
        signal?.removeEventListener?.("abort", onAbort);
        resolve();
      };
      const fail = (status, title, detail) => {
        if (done) return;
        try { conn?.abort(); } catch {}
        if (started) send({ type: "abort", message: `${title}: ${detail}` });
        else send({ type: "error", ...errorPage(status, title, detail) });
        finish();
      };
      const onAbort = () => fail(499, "Cancelled", "the page that asked for it went away");
      if (signal?.aborted) {
        send({ type: "error", ...errorPage(499, "Cancelled", "the page that asked for it went away") });
        done = true;
        resolve();
        return;
      }
      signal?.addEventListener?.("abort", onAbort);
      const deliver = (events) => {
        for (const e of events) {
          if (done) return; // the one who asked stopped it (a probe, once it has the head)
          if (e.type === "head") {
            started = true;
            idle();
            send({ type: "head", status: e.status, statusText: e.statusText, headers: responseHeaders(e.headers, ctx) });
          } else if (e.type === "data") {
            idle();
            send({ type: "data", bytes: e.bytes }, [e.bytes.buffer]);
          } else if (e.type === "end") {
            send({ type: "end" });
            try { conn?.abort(); } catch {}
            finish();
            return;
          }
        }
      };
      let head;
      try {
        head = requestHead({ method: req.method, path: req.path, headers: req.headers ?? [], port: req.port, bodyLength: req.body?.length ?? 0 });
      } catch (e) {
        fail(400, "A request the preview can't send", String(e?.message ?? e));
        return;
      }
      if ((req.body?.length ?? 0) > MAX_BODY) {
        fail(413, "Too large", `a preview request's body can be at most ${MAX_BODY >> 20} MiB`);
        return;
      }
      arm(connectMs, () => {
        if (!connected) fail(504, "No answer", `${what} did not accept a connection within ${connectMs / 1000} s`);
        else fail(504, "No answer", `${what} accepted the connection but did not answer within ${answerMs / 1000} s`);
      });
      try {
        conn = open(req.port);
      } catch (e) {
        fail(502, "The machine can't be reached", String(e?.message ?? e));
        return;
      }
      conn.onconnect = () => {
        if (done) return;
        connected = true;
        arm(answerMs, () => fail(504, "No answer", `${what} accepted the connection but did not answer within ${answerMs / 1000} s`));
        conn.write(head);
        if (req.body?.length) conn.write(req.body);
      };
      conn.ondata = (bytes) => {
        if (done) return;
        try { deliver(parser.push(bytes)); } catch (e) { fail(502, "A malformed answer", `${what}: ${e.message}`); }
      };
      const closed = () => {
        if (done) return;
        if (!connected) {
          fail(502, "Nothing is listening", `nothing in ${req.runtime ?? "the machine"} accepted a connection on port ${req.port}. ` +
            "Start a server there, listening on 0.0.0.0 (the machine's network address): a server on 127.0.0.1 or localhost only can't be reached from the page.");
          return;
        }
        try { deliver(parser.close()); } catch (e) { fail(502, "A broken answer", `${what}: ${e.message}`); }
      };
      conn.onend = closed;
      conn.onclose = closed;
      conn.onerror = (e) => fail(502, "The machine can't be reached", String(e?.message ?? e));
    });
  }

  const SnowglobePreview = { route, previewUrl, checkPort, checkPath, requestHead, ResponseParser, rewriteLocation, responseHeaders, errorPage, serve,
    reasonPhrase, decoding, latin1Text, NO_BODY, limits: { MAX_BODY, MAX_HEAD, CONNECT_MS, ANSWER_MS, IDLE_MS }, PREFIX };
  if (typeof module === "object" && module.exports) module.exports = SnowglobePreview;
  else root.SnowglobePreview = SnowglobePreview;
})(typeof window !== "undefined" ? window : globalThis);
