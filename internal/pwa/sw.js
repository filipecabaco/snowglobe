// snowglobe's service worker: the site keeps working offline once it has run.
//
// The shell (the page, its manifest and icons) is cached on install. Everything else (the machine,
// the terminal, the snapshot, the warm pack, the guest's file blobs) is cached the first time the
// page fetches it, so installing doesn't download it a second time. What can't change under its URL
// comes from the cache first: blobs, named by their content, and the build's own files, which the
// page asks for with its build's version (?v=), so a newer page asks for other URLs. The rest (the
// page itself, anything unversioned) comes from the network first and the cache offline.
const CACHE = "__CACHE__" + ":" + self.registration.scope;
// A build's version, as the page puts it on its files (site.Page.Assets): only that is taken for
// one, not any ?v= a request to this origin happens to have (the guest's own, say)
const versioned = (url) => url.origin === location.origin && /^[0-9a-f]{16}$/.test(url.searchParams.get("v") ?? "");
const SHELL = __SHELL__;
// Several CPUs share memory between Web Workers, which needs a cross-origin isolated page: add
// the headers for that to the page (static hosts can't send them)
const ISOLATE = __ISOLATE__;
// Where the guest's file blobs come from when that isn't this site (the live demos fetch theirs
// from GitHub): those are cached too. Nothing else from other origins is: the guest's own
// requests must reach the network.
const BLOBS = __BLOBS__;
const cacheable = (url) => new URL(url).origin === location.origin || (BLOBS && url.startsWith(BLOBS));

function isolate(response) {
  if (!ISOLATE || !response || response.type === "opaqueredirect") return response;
  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set("Cross-Origin-Embedder-Policy", "require-corp");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith("snowglobe-") && k.endsWith(":" + self.registration.scope) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// The page lists what it fetched before this worker was in control; keep those too
self.addEventListener("message", (event) => {
  const urls = event.data?.cache;
  if (!Array.isArray(urls)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(urls.map(async (url) => {
        const exact = versioned(new URL(url, location.href));
        if (!cacheable(url) || (await cache.match(url, { ignoreSearch: !exact }))) return;
        try {
          const response = await fetch(url);
          if (response.ok && response.status === 200) await cache.put(url, response);
        } catch {}
      }))),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET" || !cacheable(request.url) || request.headers.has("range")) return;

  // The page itself: the network first, so a new build shows up; the cache when offline
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return isolate(response);
        })
        .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => isolate(hit) || caches.match("./").then(isolate))),
    );
    return;
  }

  const keep = (response) => {
    if (response.ok && response.status === 200) {
      const copy = response.clone();
      caches.open(CACHE).then((cache) => cache.put(request, copy));
    }
    return response;
  };

  // A versioned file is one build's copy and never changes under its URL: the cache first,
  // matched with its version, so a newer page (other URLs) never gets an older build's copy
  if (versioned(url)) {
    event.respondWith(caches.match(request).then((hit) => hit || fetch(request).then(keep)));
    return;
  }

  // The guest's file blobs are named by their content, so they never change: the cache first
  if (blob(request.url)) {
    event.respondWith(caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request).then(keep)));
    return;
  }

  // Everything else (the page's unversioned files, and every file of a page built before ?v=)
  // may change with each build and must match the page: the network first, the cache when offline
  event.respondWith(fetch(request).then(keep).catch(() => caches.match(request, { ignoreSearch: true })));
});

function blob(url) {
  return (BLOBS && url.startsWith(BLOBS)) || /\/(system\/filesystem|blobs)\/[^/]+$/.test(new URL(url).pathname);
}
