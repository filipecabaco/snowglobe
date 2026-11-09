// Put first in every page the agent page's preview shows (its service worker adds it to the HTML,
// before the page's own scripts): what the page logs goes to the agent page that frames it, for
// preview_snapshot. Console errors and warnings (and logs), uncaught errors, rejected promises,
// resources that failed to load, and requests (fetch, XMLHttpRequest) that failed or answered
// 4xx/5xx. It changes nothing the page does: each hook calls through to the original.
//
// Only to a parent of this same origin (the agent page), and nothing at all when the page is not
// framed (the preview opened in a tab of its own). A page that logs a lot is capped per load.
//
// And WebSockets: a service worker can't take a WebSocket, so `new WebSocket(url)` for an address
// under the page directory's preview/<runtime>/<port>/ (this preview's machine, or another's; ws:,
// wss:, http: or https:, on this origin) is carried by the page that frames this one instead
// (orchestrator.js's previewSocket, over a MessageChannel; that page speaks the WebSocket to the
// machine and passes on what it says, decoded). Any other address gets the browser's own WebSocket,
// untouched. With no such page (a tab of its own), such a WebSocket fails at once, cleanly.
(function () {
  "use strict";
  var w = window;
  if (w.__snowglobeHook) return;
  w.__snowglobeHook = true;
  var parent = null;
  try {
    // Same origin only: reading its location throws for another site's frame
    if (w.parent !== w && w.parent.location.origin === w.location.origin) parent = w.parent;
  } catch (e) {}
  var script = w.document && w.document.currentScript;
  try { sockets(w, parent, script && script.src); } catch (e) {}
  if (!parent) return;
  var MAX = 300;
  var CHARS = 1000;
  var sent = 0;
  var post = function (level, text) {
    if (sent > MAX) return;
    sent++;
    if (sent > MAX) { level = "warn"; text = "[the preview stopped passing on this page's console: over " + MAX + " entries]"; }
    try {
      parent.postMessage({ type: "snowglobe-preview-log", level: level, text: String(text).slice(0, CHARS), url: w.location.href, at: Date.now() }, w.location.origin);
    } catch (e) {}
  };
  var show = function (v) {
    if (typeof v === "string") return v;
    if (v instanceof Error) return (v.stack && v.stack.indexOf(v.message) >= 0 ? v.stack : v.name + ": " + v.message + (v.stack ? "\n" + v.stack : "")).slice(0, CHARS);
    try {
      var s = JSON.stringify(v);
      return s === undefined ? String(v) : s;
    } catch (e) {
      return String(v);
    }
  };
  var line = function (args) {
    var out = [];
    for (var i = 0; i < args.length; i++) out.push(show(args[i]));
    return out.join(" ");
  };

  post("load", "page loaded: " + w.location.pathname + w.location.search);

  var c = w.console;
  if (c) {
    ["error", "warn", "log", "info", "debug"].forEach(function (k) {
      var orig = c[k];
      if (typeof orig !== "function") return;
      c[k] = function () {
        try { post(k === "info" || k === "debug" ? "log" : k, line(arguments)); } catch (e) {}
        return orig.apply(this, arguments);
      };
    });
  }

  w.addEventListener("error", function (e) {
    var t = e && e.target;
    if (t && t !== w && t.tagName) {
      // A script, stylesheet or image that failed to load
      post("network", "failed to load <" + String(t.tagName).toLowerCase() + "> " + (t.src || t.href || ""));
      return;
    }
    var where = e && e.filename ? " (" + e.filename + ":" + e.lineno + ":" + e.colno + ")" : "";
    post("error", "Uncaught " + (e && e.error ? show(e.error) : (e && e.message) || "error") + where);
  }, true);
  w.addEventListener("unhandledrejection", function (e) {
    post("error", "Unhandled promise rejection: " + show(e && e.reason));
  });

  var f = w.fetch;
  if (typeof f === "function") {
    w.fetch = function (input, init) {
      var method = (init && init.method) || (input && input.method) || "GET";
      var url = typeof input === "string" ? input : (input && input.url) || String(input);
      return f.apply(this, arguments).then(function (r) {
        if (r && r.status >= 400) post("network", method.toUpperCase() + " " + url + " -> " + r.status + (r.statusText ? " " + r.statusText : ""));
        return r;
      }, function (err) {
        if (!(err && err.name === "AbortError")) post("network", method.toUpperCase() + " " + url + " failed: " + show(err && err.message ? err.message : err));
        throw err;
      });
    };
  }
  var X = w.XMLHttpRequest;
  if (X && X.prototype) {
    var open = X.prototype.open;
    var send = X.prototype.send;
    X.prototype.open = function (method, url) {
      this.__sg = String(method || "GET").toUpperCase() + " " + url;
      return open.apply(this, arguments);
    };
    X.prototype.send = function () {
      var x = this;
      try {
        var aborted = false;
        x.addEventListener("abort", function () { aborted = true; });
        x.addEventListener("loadend", function () {
          if (x.status >= 400) post("network", x.__sg + " -> " + x.status);
          else if (x.status === 0 && !aborted) post("network", x.__sg + " failed (no answer)");
        });
      } catch (e) {}
      return send.apply(this, arguments);
    };
  }

  /**
   * window.WebSocket, made one that sends a preview address's WebSockets through `parent` (the
   * framing page, or null). `hookSrc` is this script's own address: the page directory is its
   * directory, and the preview's addresses are under its preview/.
   */
  function sockets(w, parent, hookSrc) {
    var Real = w.WebSocket;
    var Base = w.EventTarget;
    if (typeof Real !== "function" || typeof Base !== "function" || typeof w.MessageChannel !== "function" || !hookSrc) return;
    var dir = new w.URL("./", hookSrc);
    if (dir.origin !== w.location.origin) return;
    var prefix = dir.pathname + "preview/";
    var TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
    // How long the framing page gets to take a socket (an older page, or none listening, never does)
    var TAKE_MS = 5000;
    var open = new Set();
    var enc = new w.TextEncoder();
    var fail = function (name, message) { return typeof w.DOMException === "function" ? new w.DOMException(message, name) : new Error(message); };
    var warn = function (text) { try { w.console.warn(text); } catch (e) {} };

    /** The address a WebSocket url names under the preview (as this origin's http(s)), or null. */
    var target = function (url) {
      var u;
      try { u = new w.URL(String(url), w.location.href); } catch (e) { return null; }
      if (!/^(wss?|https?):$/.test(u.protocol) || u.host !== w.location.host) return null;
      if (u.pathname.indexOf(prefix) !== 0 || !/^[a-z0-9][a-z0-9._-]{0,63}\/\d{1,5}(\/|$)/.test(u.pathname.slice(prefix.length))) return null;
      return w.location.origin + u.pathname + u.search;
    };
    var event = function (type, init) {
      if (type === "message" && typeof w.MessageEvent === "function") return new w.MessageEvent("message", init);
      if (type === "close" && typeof w.CloseEvent === "function") return new w.CloseEvent("close", init);
      var e = new w.Event(type);
      for (var k in init) Object.defineProperty(e, k, { value: init[k], enumerable: true });
      return e;
    };

    class WebSocket extends Base {
      constructor(url, protocols) {
        var to = target(url);
        if (!to) return arguments.length > 1 ? new Real(url, protocols) : new Real(url);
        var list = protocols === undefined ? [] : typeof protocols === "string" ? [protocols] : Array.from(protocols, String);
        for (var i = 0; i < list.length; i++) {
          if (!TOKEN.test(list[i]) || list.indexOf(list[i]) !== i) throw fail("SyntaxError", "not a subprotocol, or given twice: " + JSON.stringify(list[i]));
        }
        super();
        var u = new w.URL(String(url), w.location.href);
        if (u.protocol === "http:") u.protocol = "ws:";
        else if (u.protocol === "https:") u.protocol = "wss:";
        if (u.hash) throw fail("SyntaxError", "a WebSocket URL has no fragment: " + u.href);
        this.url = u.href;
        this.protocol = "";
        this.extensions = "";
        this._binaryType = "blob";
        this._state = 0;
        this._buffered = 0;
        this._chain = null; // sends waiting on a Blob being read, in order
        this._error = false;
        var self = this;
        if (!parent) {
          this._state = 3;
          warn("WebSocket " + this.url + " failed: a preview's WebSockets work only inside the page that shows it");
          w.setTimeout(function () { self._closed({ code: 1006, reason: "", wasClean: false }, true); }, 0);
          return;
        }
        var ch = new w.MessageChannel();
        this._port = ch.port1;
        this._taken = w.setTimeout(function () { self._hear({ type: "error", message: "the page showing the preview didn't take it" }); self._hear({ type: "close", code: 1006, reason: "", wasClean: false }); }, TAKE_MS);
        ch.port1.onmessage = function (e) { self._hear(e.data); };
        open.add(this);
        parent.postMessage({ type: "snowglobe-preview-socket", url: to, protocols: list }, w.location.origin, [ch.port2]);
      }

      get readyState() { return this._state; }
      get bufferedAmount() { return this._buffered; }
      get binaryType() { return this._binaryType; }
      set binaryType(v) { if (v === "blob" || v === "arraybuffer") this._binaryType = v; }

      _hear(d) {
        if (!d || this._state === 3) return;
        if (this._taken !== null) { w.clearTimeout(this._taken); this._taken = null; }
        if (d.type === "open") {
          if (this._state !== 0) return;
          this._state = 1;
          this.protocol = String(d.protocol || "");
          this.extensions = String(d.extensions || "");
          this.dispatchEvent(event("open", {}));
        } else if (d.type === "message") {
          if (this._state !== 1) return;
          var data = d.data;
          if (typeof data !== "string") data = this._binaryType === "blob" && typeof w.Blob === "function" ? new w.Blob([data]) : data;
          this.dispatchEvent(event("message", { data: data, origin: new w.URL(this.url).origin }));
        } else if (d.type === "sent") {
          this._buffered = Math.max(0, this._buffered - (d.n || 0));
        } else if (d.type === "error") {
          this._error = true;
          if (d.message) warn("WebSocket " + this.url + " failed: " + d.message);
        } else if (d.type === "close") {
          this._closed({ code: d.code || 1006, reason: String(d.reason || ""), wasClean: !!d.wasClean }, this._error);
        }
      }

      _closed(init, error) {
        this._state = 3;
        open.delete(this);
        if (this._port) { try { this._port.onmessage = null; this._port.close(); } catch (e) {} }
        if (error) this.dispatchEvent(event("error", {}));
        this.dispatchEvent(event("close", init));
      }

      _post(msg, transfer) {
        try { this._port.postMessage(msg, transfer || []); } catch (e) {}
      }

      send(data) {
        if (this._state === 0) throw fail("InvalidStateError", "the WebSocket is still connecting");
        var self = this;
        var n;
        var make;
        if (typeof data === "string") { n = enc.encode(data).length; make = function () { return [data]; }; }
        else if (data instanceof ArrayBuffer) { var a = data.slice(0); n = a.byteLength; make = function () { return [a, [a]]; }; }
        else if (ArrayBuffer.isView(data)) { var v = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer; n = v.byteLength; make = function () { return [v, [v]]; }; }
        else if (typeof w.Blob === "function" && data instanceof w.Blob) { n = data.size; make = function () { return data.arrayBuffer().then(function (b) { return [b, [b]]; }); }; }
        else { var s = String(data); n = enc.encode(s).length; make = function () { return [s]; }; }
        this._buffered += n;
        if (this._state !== 1) return;
        var go = function (m) { if (self._state !== 3) self._post({ type: "send", data: m[0], n: n }, m[1]); };
        var blob = typeof w.Blob === "function" && data instanceof w.Blob;
        if (!this._chain && !blob) return go(make());
        this._after(function () { return Promise.resolve(make()).then(go, function () {}); });
      }

      /** `fn` once the sends before it went (a Blob is read first, and order is kept). */
      _after(fn) {
        var self = this;
        var done = this._chain = (this._chain || Promise.resolve()).then(fn).then(function () { if (self._chain === done) self._chain = null; });
      }

      close(code, reason) {
        if (code !== undefined) {
          code = Number(code);
          if (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999))) throw fail("InvalidAccessError", "a close code must be 1000 or 3000 to 4999, not " + code);
        }
        if (reason !== undefined && enc.encode(String(reason)).length > 123) throw fail("SyntaxError", "a close reason is at most 123 bytes");
        if (this._state >= 2) return;
        var self = this;
        var msg = { type: "close", code: code, reason: reason === undefined ? undefined : String(reason) };
        var queued = !!this._chain;
        this._state = 2;
        if (queued) this._after(function () { self._post(msg); });
        else this._post(msg);
      }

      static [Symbol.hasInstance](x) { return x instanceof Real || Object.prototype.isPrototypeOf.call(WebSocket.prototype, x); }
    }
    ["open", "message", "error", "close"].forEach(function (type) {
      Object.defineProperty(WebSocket.prototype, "on" + type, {
        configurable: true,
        get: function () { return (this._on && this._on[type] && this._on[type].fn) || null; },
        set: function (fn) {
          this._on = this._on || {};
          var h = this._on[type];
          if (h) { this.removeEventListener(type, h.wrap); delete this._on[type]; }
          if (typeof fn !== "function") return;
          var self = this;
          var entry = { fn: fn, wrap: function (e) { return entry.fn.call(self, e); } };
          this._on[type] = entry;
          this.addEventListener(type, entry.wrap);
        },
      });
    });
    [["CONNECTING", 0], ["OPEN", 1], ["CLOSING", 2], ["CLOSED", 3]].forEach(function (c) {
      Object.defineProperty(WebSocket, c[0], { value: c[1], enumerable: true });
      Object.defineProperty(WebSocket.prototype, c[0], { value: c[1], enumerable: true });
    });
    // The page going (a navigation in the frame, the frame closed): its sockets end at the other side
    w.addEventListener("pagehide", function () {
      open.forEach(function (s) { s._post({ type: "gone" }); s._closed({ code: 1001, reason: "", wasClean: false }, false); });
    });
    w.WebSocket = WebSocket;
  }
})();
