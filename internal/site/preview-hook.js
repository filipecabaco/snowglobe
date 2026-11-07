// Put first in every page the agent page's preview shows (its service worker adds it to the HTML,
// before the page's own scripts): what the page logs goes to the agent page that frames it, for
// preview_snapshot. Console errors and warnings (and logs), uncaught errors, rejected promises,
// resources that failed to load, and requests (fetch, XMLHttpRequest) that failed or answered
// 4xx/5xx. It changes nothing the page does: each hook calls through to the original.
//
// Only to a parent of this same origin (the agent page), and nothing at all when the page is not
// framed (the preview opened in a tab of its own). A page that logs a lot is capped per load.
(function () {
  "use strict";
  var w = window;
  if (w.__snowglobeHook) return;
  w.__snowglobeHook = true;
  var parent;
  try {
    if (w.parent === w) return;
    parent = w.parent;
    // Same origin only: reading its location throws for another site's frame
    if (parent.location.origin !== w.location.origin) return;
  } catch (e) {
    return;
  }
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
})();
