#!/usr/bin/env node
// serve [--watch] [dir] [port]: a small static file server for a built page (dist/ on 4173 by
// default). It listens on 0.0.0.0, the machine's network address, which is where the agent page's
// preview connects (a server on 127.0.0.1 only can't be reached from outside the machine). A path
// with no file falls back to index.html, as single-page apps expect.
//
// --watch, run in a Vite project: Vite builds it into dir and builds it again on every change to its
// sources (vite build --watch, in this same process), and GET /__build says how the last build went:
// { version, state: "building" | "ok" | "error", error, ms, at }. version goes up once a build is
// written (or has failed). The agent page's preview reads it and reloads the page after each new
// build: its bridge into the machine has no WebSockets, so Vite's hot reload can't reach it.
//
// --registry PORT: npm's registry on 127.0.0.1:PORT (the machine's /root/.npmrc points npm there),
// passed on to https://registry.npmjs.org with nothing but an Accept header. In the browser every
// request the machine makes is the page's own fetch(), so CORS applies: the registry answers GETs
// with access-control-allow-origin *, but npm's own headers (npm-command, npm-session, pacote-...)
// would make each request preflighted, and the registry answers no preflight (OPTIONS is a 404).
// A GET with only Accept is a simple request: no preflight, and it works from any page.
import { Agent as HttpAgent, createServer, request as httpRequest } from "node:http";
import { Agent as HttpsAgent, request as httpsRequest } from "node:https";
import { createReadStream, statSync } from "node:fs";
import { createRequire } from "node:module";
import { extname, join, normalize, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
let watch = false;
let registry = null;
while (args[0]?.startsWith("--")) {
  const flag = args.shift();
  if (flag === "--watch") watch = true;
  else if (flag === "--registry") registry = Number(args.shift());
  else {
    console.error(`serve: no option ${flag} (serve [--watch] [--registry PORT] [dir] [port])`);
    process.exit(2);
  }
}
const root = resolve(args[0] ?? "dist");
const port = Number(args[1] ?? 4173);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json",
};

// The last build, for /__build (version 0: none has finished yet)
const build = { version: 0, state: watch ? "building" : "off", error: null, ms: null, at: null };

const file = (path) => {
  try {
    const st = statSync(path);
    if (st.isDirectory()) return file(join(path, "index.html"));
    return st.isFile() ? { path, size: st.size } : null;
  } catch {
    return null;
  }
};

createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, "http://x").pathname);
  } catch {
    res.writeHead(400).end("bad path\n");
    return;
  }
  if (path === "/__build") {
    if (!watch) return res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("not watching: serve --watch builds and reports here\n");
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(build) + "\n");
    return;
  }
  const target = normalize(join(root, path));
  if (target !== root && !target.startsWith(root + sep)) {
    res.writeHead(403).end("forbidden\n");
    return;
  }
  const found = file(target) ?? (extname(path) ? null : file(join(root, "index.html")));
  if (!found) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end(`no ${path}\n`);
    return;
  }
  res.writeHead(200, { "content-type": types[extname(found.path)] ?? "application/octet-stream", "content-length": found.size, "cache-control": "no-cache" });
  if (req.method === "HEAD") return res.end();
  createReadStream(found.path).pipe(res);
}).listen(port, "0.0.0.0", () => console.log(`serving ${root} on http://0.0.0.0:${port}/${watch ? " (rebuilding on changes; /__build says how)" : ""}`));

if (registry) {
  const upstream = process.env.NPM_UPSTREAM ?? "https://registry.npmjs.org";
  const plain = upstream.startsWith("http:"); // a local mirror, or a test
  const agent = new (plain ? HttpAgent : HttpsAgent)({ keepAlive: true, maxSockets: 6 });
  const send = plain ? httpRequest : httpsRequest;
  // A CORS-safelisted Accept: no ( ) : < > ? @ [ \ ] { } " and at most 128 bytes
  const accept = (a) => typeof a === "string" && a.length <= 128 && !/[\x00-\x08\x0a-\x1f"():<>?@[\\\]{}\x7f]/.test(a) ? a : "application/json";
  const DROP = new Set(["connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length", "set-cookie"]);
  createServer((req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { "content-type": "text/plain; charset=utf-8" }).end("this registry is read only: install and view work, publish and login don't\n");
      return;
    }
    const up = send(upstream + req.url, { method: req.method, agent, headers: { accept: accept(req.headers.accept) } }, (r) => {
      const headers = {};
      for (const [k, v] of Object.entries(r.headers)) if (!DROP.has(k)) headers[k] = v;
      res.writeHead(r.statusCode ?? 502, headers);
      r.pipe(res);
    });
    up.on("error", (e) => {
      if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `the registry could not be reached: ${e.message}` }) + "\n");
    });
    up.end();
  }).listen(registry, "127.0.0.1", () => console.log(`npm's registry on http://127.0.0.1:${registry}/ (from ${upstream}, as simple GETs)`));
}

if (watch) {
  // The project's own Vite (its node_modules), with its vite.config.js, writing to dir
  const require = createRequire(join(process.cwd(), "package.json"));
  let vite;
  try {
    vite = await import(pathToFileURL(require.resolve("vite")).href);
  } catch (e) {
    console.error(`serve --watch: no Vite in ${process.cwd()} (run it in a Vite project): ${e.message}`);
    process.exit(1);
  }
  let began = Date.now();
  const watcher = await vite.build({ build: { outDir: relative(process.cwd(), root) || ".", watch: {} }, logLevel: "warn" });
  watcher.on("event", (e) => {
    if (e.code === "BUNDLE_START" || e.code === "START") {
      if (build.state !== "building") began = Date.now();
      build.state = "building";
    } else if (e.code === "BUNDLE_END" || e.code === "ERROR") {
      const failed = e.code === "ERROR";
      Object.assign(build, { version: build.version + 1, state: failed ? "error" : "ok", ms: Date.now() - began, at: new Date().toISOString(),
        // Without the terminal's colours: the agent page shows it as text
        error: failed ? String(e.error?.message ?? e.error).replace(/\x1b\[[0-9;]*m/g, "").slice(0, 4000) : null });
      console.log(failed ? `build ${build.version} failed: ${build.error}` : `build ${build.version} written in ${build.ms} ms`);
      e.result?.close?.();
    }
  });
}
