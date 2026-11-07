// The agent page's service worker (/agent/sw.js, its scope the page's directory). Two jobs:
//
//  - Isolation. Machines on several CPUs share memory between Web Workers (SharedArrayBuffer),
//    which browsers allow only in a cross-origin isolated page, and static hosts can't send the
//    headers for that. This worker adds them (COOP same-origin, COEP require-corp) to the page and
//    to the worker scripts it starts (a worker under such a page needs COEP of its own). Everything
//    else the page loads is either this site's or fetched with CORS (the blob store), so it passes.
//
//  - The preview. A request under preview/<runtime>/<port>/ (the panel's frame, the page in it,
//    whatever that page fetches) is handed to the agent page that runs the machines, over a
//    MessageChannel of its own; the page sends it to the machine's port and streams the answer back
//    (preview.js). Nothing is answered from the address alone: the page answers only while a preview
//    is open and the person at it has allowed its machines, and a page opened in the preview from
//    anywhere but the agent page (another site, a typed address) is refused. Each HTML page the
//    preview shows gets one <script> first in it (preview-hook.js), which tells the agent page what
//    it logs, for preview_snapshot.
"use strict";

importScripts("preview.js");
const P = self.SnowglobePreview;
const scope = new URL(self.registration.scope);
// How long the agent page gets to take a request, before the preview says it isn't there
const TAKE_MS = 5000;
// Once taken: how long until the answer's head (past the page's own bounds: a wake waiting for a
// slot, a connect, the server's answer), and then between the body's bytes. Either way the
// request always ends, even if the agent page closed meanwhile
const HEAD_MS = 240000;
const IDLE_MS = 90000;
// A preview frame (or tab), by its client id: the agent page tab it belongs to
const frameOwner = new Map();
// Navigations an agent tab said it is about to make in its preview frame: url -> [{ id, at }]
const hints = new Map();
const HINT_MS = 10000;

self.addEventListener("message", (event) => {
  const d = event.data;
  if (d?.type !== "snowglobe-preview-nav" || typeof d.url !== "string" || !event.source?.id) return;
  const list = (hints.get(d.url) ?? []).filter((h) => Date.now() - h.at < HINT_MS);
  list.push({ id: event.source.id, at: Date.now() });
  hints.set(d.url, list);
});

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

const ISOLATION = [["Cross-Origin-Opener-Policy", "same-origin"], ["Cross-Origin-Embedder-Policy", "require-corp"]];

function isolate(response) {
  if (!response || response.type === "opaqueredirect" || response.type === "error") return response;
  const headers = new Headers(response.headers);
  for (const [k, v] of ISOLATION) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/** What every preview answer carries: isolated as the page is (its frame must be), framed only by
 *  this site, and readable only by it. */
function previewHeaders(list) {
  const headers = new Headers();
  for (const [k, v] of list) {
    try { headers.append(k, v); } catch {}
  }
  for (const [k, v] of ISOLATION) headers.set(k, v);
  headers.set("Cross-Origin-Resource-Policy", "same-origin");
  headers.set("X-Frame-Options", "SAMEORIGIN");
  headers.append("Content-Security-Policy", "frame-ancestors 'self'");
  // A guest's own policy (helmet's no-referrer, say) would hide where a navigation in the preview
  // comes from, and the preview refuses navigations it can't place: same-origin keeps it
  headers.set("Referrer-Policy", "same-origin");
  return headers;
}

function page(p) {
  const status = p.status === 499 ? 504 : p.status;
  return new Response(p.body, { status, statusText: P.reasonPhrase(p.statusText), headers: previewHeaders(p.headers) });
}

const refuse = (status, title, detail) => page(P.errorPage(status, title, detail, { back: scope.href }));

/** Is this the agent page itself (not a preview in it, not another page of the scope)? */
function isAgentPage(url) {
  const u = new URL(url);
  return u.origin === scope.origin && (u.pathname === scope.pathname || u.pathname === scope.pathname + "index.html");
}

const takeHint = (url) => {
  const list = (hints.get(url) ?? []).filter((h) => Date.now() - h.at < HINT_MS);
  const h = list.shift();
  if (list.length) hints.set(url, list);
  else hints.delete(url);
  return h?.id ?? null;
};

/**
 * The agent page tab a request belongs to: { client, placed } (placed: known for sure, not
 * guessed). A request from a preview frame (or tab) goes to the tab that frame was loaded for; a
 * navigation to the tab that said it was making it, or to the tab of the preview frame it was
 * made from (its referrer, or the client it replaces). Only when none of that says: the focused
 * agent page, or the one seen last (frames loaded before this worker last started are not known).
 */
async function owner(event) {
  const request = event.request;
  const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
  const pages = all.filter((c) => isAgentPage(c.url) && c.frameType !== "nested");
  const tab = (id) => (id ? pages.find((c) => c.id === id) ?? null : null);
  const fallback = () => ({ client: pages.find((c) => c.focused) ?? pages.at(-1) ?? null, placed: false });
  let found = null;
  if (request.mode !== "navigate") {
    if (event.clientId) found = tab(event.clientId) ?? tab(frameOwner.get(event.clientId));
  } else {
    found = tab(takeHint(request.url));
    if (!found && pages.length > 1) {
      // The tab's word may be a moment behind its navigation
      await new Promise((r) => setTimeout(r, 150));
      found = tab(takeHint(request.url));
    }
    if (!found && event.replacesClientId) found = tab(frameOwner.get(event.replacesClientId));
    if (!found && request.referrer) {
      const from = new Set(all.filter((c) => c.url === request.referrer && frameOwner.has(c.id)).map((c) => frameOwner.get(c.id)));
      if (from.size === 1) found = tab([...from][0]);
    }
    if (found && event.resultingClientId) frameOwner.set(event.resultingClientId, found.id);
  }
  if (found) return { client: found, placed: true };
  const f = fallback();
  if (request.mode === "navigate" && f.client && event.resultingClientId) frameOwner.set(event.resultingClientId, f.client.id);
  return f;
}

/** May this request reach a machine? A page loaded in the preview must have been opened from the
 *  agent page or a preview in it (placed: an agent tab said so, or the frame it came from is
 *  one of its previews; else its referrer is this scope's); anything the page in the preview
 *  fetches comes from it. */
function fromHere(request, placed) {
  if (request.mode !== "navigate" || placed) return true;
  const ref = request.referrer;
  if (!ref) return false;
  try {
    const r = new URL(ref);
    return r.origin === scope.origin && r.pathname.startsWith(scope.pathname);
  } catch {
    return false;
  }
}

// Forget frames whose tab (or the frame itself) is gone
async function prune() {
  const ids = new Set((await self.clients.matchAll({ type: "window", includeUncontrolled: true })).map((c) => c.id));
  for (const [frame, tab] of frameOwner) if (!ids.has(frame) || !ids.has(tab)) frameOwner.delete(frame);
}

async function preview(event, route) {
  const request = event.request;
  if (route.error) return refuse(400, "Not a preview's address", route.error);
  if (!route.slash) {
    // The preview's root is a directory: its relative links resolve inside it
    const to = new URL(request.url);
    to.pathname += "/";
    return Response.redirect(to.href, 301);
  }
  const { client, placed } = await owner(event);
  if (!fromHere(request, placed)) {
    return refuse(403, "Open it from the agent page", "A preview is shown only to the agent page that runs its machine: open it there " +
      "(Open preview, or the open_preview tool), or from a link in the preview. An address alone runs nothing.");
  }
  if (!client) return refuse(503, "The agent page isn't open", "The machines run in the agent page: open it, and the preview there.");
  if (frameOwner.size > 64) prune().catch(() => {});
  let body;
  if (!["GET", "HEAD"].includes(request.method)) {
    body = new Uint8Array(await request.arrayBuffer());
    if (body.length > P.limits.MAX_BODY) return refuse(413, "Too large", `a preview request's body can be at most ${P.limits.MAX_BODY >> 20} MiB`);
  }
  const req = {
    runtime: route.runtime, port: route.port, path: route.path, prefix: route.prefix, origin: scope.origin,
    method: request.method, headers: [...request.headers], body, navigate: request.mode === "navigate",
  };
  const channel = new MessageChannel();
  const port = channel.port1;
  return new Promise((resolve) => {
    let stream = null;
    let taken = false;
    let over = false;
    let timer = null;
    const arm = (ms, fn) => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
    // The request is over: no more timers, nothing more heard, the page told to stop if it may
    // still be at it
    const close = (cancel) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      request.signal?.removeEventListener?.("abort", onAbort);
      if (cancel) try { port.postMessage({ type: "cancel" }); } catch {}
      port.close();
    };
    const settle = (response) => {
      try { resolve(response()); } catch (e) {
        close(true);
        resolve(refuse(502, "A malformed answer", `the server's answer can't be passed on: ${e?.message ?? e}`));
      }
    };
    const onAbort = () => {
      // The page that asked went away (a frame navigated, a fetch aborted): the machine's
      // connection ends, and the machine is let go
      try { stream?.error(new DOMException("cancelled", "AbortError")); } catch {}
      close(true);
      resolve(refuse(504, "Cancelled", "the page that asked for it went away"));
    };
    if (request.signal?.aborted) return onAbort();
    request.signal?.addEventListener?.("abort", onAbort);
    arm(TAKE_MS, () => {
      close(true);
      resolve(refuse(503, "The agent page didn't answer", "It may be an older copy of the page, or busy: reload it."));
    });
    const giveUp = (title, detail) => () => {
      if (stream) {
        try { stream.error(new Error(`${title}: ${detail}`)); } catch {}
        close(true);
        return;
      }
      close(true);
      resolve(refuse(504, title, detail));
    };
    port.onmessage = ({ data }) => {
      if (over) return;
      switch (data?.type) {
        case "taken":
          taken = true;
          arm(HEAD_MS, giveUp("No answer", `the agent page did not answer within ${HEAD_MS / 1000} s`));
          break;
        case "head": {
          taken = true;
          arm(IDLE_MS, giveUp("No answer", `the answer stopped: nothing for ${IDLE_MS / 1000} s`));
          const headers = previewHeaders(data.headers ?? []);
          const empty = request.method === "HEAD" || P.NO_BODY.has(data.status);
          let body = null;
          if (!empty) {
            body = new ReadableStream({
              start(c) { stream = c; },
              cancel() { close(true); },
            });
            // A server that compressed despite Accept-Encoding: identity: undone here (a page
            // can't be handed compressed bytes from a service worker), when the browser can
            const format = P.decoding(data.headers ?? []);
            if (format && typeof DecompressionStream === "function") {
              try {
                body = body.pipeThrough(new DecompressionStream(format));
                headers.delete("Content-Encoding");
              } catch {}
            }
            // A page the preview shows gets the hook first in its HTML: what it logs reaches the
            // agent page (preview-hook.js). Its length changes, so none is said
            if (typeof TransformStream === "function" && P.wantsHook({ navigate: request.mode === "navigate", method: request.method, status: data.status, headers: [...headers] })) {
              try {
                body = body.pipeThrough(P.hookStream(scope.pathname + P.HOOK_FILE));
                headers.delete("Content-Length");
              } catch {}
            }
          } else {
            close(true);
          }
          settle(() => new Response(body, { status: data.status, statusText: P.reasonPhrase(data.statusText), headers }));
          break;
        }
        case "data":
          arm(IDLE_MS, giveUp("No answer", `the answer stopped: nothing for ${IDLE_MS / 1000} s`));
          try { stream?.enqueue(data.bytes); } catch {}
          break;
        case "end":
          try { stream?.close(); } catch {}
          close(false);
          break;
        case "abort":
          try { stream?.error(new Error(data.message)); } catch {}
          close(false);
          break;
        case "error":
          close(false);
          settle(() => page(data));
          break;
      }
    };
    client.postMessage({ type: "snowglobe-preview", request: req }, [channel.port2, ...(body ? [body.buffer] : [])]);
  });
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== scope.origin) return;
  const route = P.route(url, scope);
  if (route) {
    event.respondWith(preview(event, route));
    return;
  }
  if (request.mode === "navigate" || request.destination === "worker") event.respondWith(fetch(request).then(isolate));
});
