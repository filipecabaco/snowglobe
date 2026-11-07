// A static file server and same-origin transport for Supabase. Business logic stays in
// Postgres/RLS; every application request is issued by supabase-js in the browser.
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { resolve, extname, sep } from "node:path";
import { pathToFileURL } from "node:url";
export function server({ root, apiUrl, anonKey }) {
  const base = resolve(root);
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      if (url.pathname.startsWith("/supabase/")) {
        const target = new URL(apiUrl);
        target.pathname = url.pathname.slice("/supabase".length);
        target.search = url.search;
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (
            ![
              "host",
              "connection",
              "content-length",
              "transfer-encoding",
            ].includes(k)
          )
            headers.set(k, v);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        const upstream = await fetch(target, {
          method: req.method,
          headers,
          body: ["GET", "HEAD"].includes(req.method)
            ? undefined
            : Buffer.concat(chunks),
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
        });
        const responseHeaders = {};
        upstream.headers.forEach((v, k) => {
          if (
            ![
              "transfer-encoding",
              "content-encoding",
              "content-length",
              "connection",
            ].includes(k)
          )
            responseHeaders[k] = v;
        });
        res.writeHead(upstream.status, responseHeaders);
        res.end(Buffer.from(await upstream.arrayBuffer()));
        return;
      }
      if (!["GET", "HEAD"].includes(req.method)) {
        res.writeHead(405);
        res.end();
        return;
      }
      if (url.pathname === "/config.js") {
        res.setHeader("Content-Type", "text/javascript");
        res.setHeader("Cache-Control", "no-store");
        res.end(`window.CONDUIT_CONFIG=${JSON.stringify({ anonKey })};`);
        return;
      }
      const name = decodeURIComponent(url.pathname);
      const file = resolve(base, "." + (name === "/" ? "/index.html" : name));
      if (!file.startsWith(base + sep)) {
        res.writeHead(403);
        res.end();
        return;
      }
      if (!(await stat(file)).isFile()) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.setHeader(
        "Content-Type",
        {
          ".html": "text/html; charset=utf-8",
          ".js": "text/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
        }[extname(file)] || "application/octet-stream",
      );
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch (e) {
      res.writeHead(e.code === "ENOENT" ? 404 : 502, {
        "Content-Type": "text/plain",
      });
      res.end(e.code === "ENOENT" ? "Not found" : "Request failed");
    }
  });
}
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.env.API_URL || !process.env.ANON_KEY)
    throw new Error("API_URL and ANON_KEY required");
  server({
    root: process.env.CONDUIT_DIST || "/home/supa/app/dist",
    apiUrl: process.env.API_URL,
    anonKey: process.env.ANON_KEY,
  }).listen(Number(process.env.PORT || 4173), "0.0.0.0");
}
