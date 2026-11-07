#!/usr/bin/env node
// serve [dir] [port]: a small static file server for a built page (dist/ on 4173 by default).
// It listens on 0.0.0.0, the machine's network address, which is where the agent page's preview
// connects (a server on 127.0.0.1 only can't be reached from outside the machine). A path with no
// file falls back to index.html, as single-page apps expect.
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4173);
const types = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".woff2": "font/woff2", ".woff": "font/woff", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm", ".map": "application/json",
};

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
}).listen(port, "0.0.0.0", () => console.log(`serving ${root} on http://0.0.0.0:${port}/`));
