import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { server } from "./server.mjs";
const listen = (s) =>
  new Promise((resolve) =>
    s.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${s.address().port}`),
    ),
  );
const close = (s) => new Promise((resolve) => s.close(resolve));
test("serves app and public configuration, preserves authenticated API requests and errors", async () => {
  const root = await mkdtemp(join(tmpdir(), "conduit-"));
  await writeFile(join(root, "index.html"), "<h1>conduit</h1>");
  const upstream = createServer(async (req, res) => {
    let body = "";
    for await (const b of req) body += b;
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        path: req.url,
        authorization: req.headers.authorization,
        apikey: req.headers.apikey,
        body,
      }),
    );
  });
  const apiUrl = await listen(upstream);
  const app = server({ root, apiUrl, anonKey: "public-demo-key" });
  const url = await listen(app);
  try {
    assert.match(await fetch(url).then((r) => r.text()), /conduit/);
    assert.equal(
      await fetch(url + "/config.js").then((r) => r.text()),
      'window.CONDUIT_CONFIG={"anonKey":"public-demo-key"};',
    );
    const r = await fetch(url + "/supabase/rest/v1/articles?select=*", {
      method: "POST",
      headers: {
        authorization: "Bearer user-token",
        apikey: "public-demo-key",
        "Content-Type": "application/json",
      },
      body: '{"title":"test"}',
    });
    assert.equal(r.status, 401);
    assert.deepEqual(await r.json(), {
      path: "/rest/v1/articles?select=*",
      authorization: "Bearer user-token",
      apikey: "public-demo-key",
      body: '{"title":"test"}',
    });
    assert.equal((await fetch(url + "/%2e%2e%2fprivate")).status, 403);
    assert.equal((await fetch(url + "/missing")).status, 404);
    assert.equal((await fetch(url + "/", { method: "POST" })).status, 405);
  } finally {
    await close(app);
    await close(upstream);
    await rm(root, { recursive: true });
  }
});
