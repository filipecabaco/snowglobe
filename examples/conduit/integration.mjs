// Run against a disposable Conduit guest: CONDUIT_URL=http://127.0.0.1:14173 node integration.mjs
import assert from "node:assert/strict";
import { createClient } from "./app/node_modules/@supabase/supabase-js/dist/index.mjs";
const base = process.env.CONDUIT_URL || "http://127.0.0.1:14173";
const config = await fetch(base + "/config.js").then((r) => r.text());
const { anonKey } = JSON.parse(config.slice(config.indexOf("=") + 1, -1));
const client = () =>
  createClient(base + "/supabase", anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
const anon = client(),
  alice = client(),
  bob = client();
function ok(r) {
  if (r.error) throw r.error;
  return r.data;
}
const suffix = Date.now();
const a = ok(
  await alice.auth.signUp({
    email: `alice-${suffix}@example.com`,
    password: "test-password-2026",
    options: { data: { username: `alice-${suffix}` } },
  }),
).user;
const b = ok(
  await bob.auth.signUp({
    email: `bob-${suffix}@example.com`,
    password: "test-password-2026",
    options: { data: { username: `bob-${suffix}` } },
  }),
).user;
assert(a && b);
assert.equal(
  ok(await alice.from("profiles").select("*").eq("id", a.id).single()).username,
  `alice-${suffix}`,
);
const row = ok(
  await alice
    .from("articles")
    .insert({
      slug: `test-${suffix}`,
      title: "Integration article",
      body: "**Markdown**",
      description: "test",
      tags: ["integration"],
      author_id: a.id,
    })
    .select()
    .single(),
);
assert(
  ok(await anon.from("articles").select("*").eq("id", row.id)).length === 1,
);
assert(
  (
    await anon
      .from("articles")
      .insert({ slug: "anon", title: "Denied", body: "x", author_id: a.id })
  ).error,
);
assert.deepEqual(
  ok(
    await bob
      .from("articles")
      .update({ title: "stolen" })
      .eq("id", row.id)
      .select(),
  ),
  [],
);
assert(
  (
    await bob
      .from("articles")
      .insert({
        slug: "spoof-" + suffix,
        title: "Denied",
        body: "x",
        author_id: a.id,
      })
  ).error,
);
assert.deepEqual(
  ok(
    await bob
      .from("profiles")
      .update({ bio: "stolen" })
      .eq("id", a.id)
      .select(),
  ),
  [],
);
ok(await alice.from("articles").update({ title: "Updated" }).eq("id", row.id));
ok(await bob.from("favorites").insert({ article_id: row.id, user_id: b.id }));
ok(await bob.from("follows").insert({ follower_id: b.id, followed_id: a.id }));
const comment = ok(
  await bob
    .from("comments")
    .insert({ article_id: row.id, author_id: b.id, body: "A comment" })
    .select()
    .single(),
);
assert.deepEqual(
  ok(await alice.from("comments").delete().eq("id", comment.id).select()),
  [],
);
assert(
  (await alice.from("favorites").insert({ article_id: row.id, user_id: b.id }))
    .error,
);
const feed = ok(
  await bob
    .from("articles")
    .select("*,author:profiles!author_id(*),favorites(user_id)")
    .eq("author_id", a.id)
    .contains("tags", ["integration"]),
);
assert.equal(feed[0].favorites.length, 1);
assert.equal(feed[0].author.id, a.id);
assert(ok(await anon.rpc("tags")).some((x) => x.tag === "integration"));
ok(await bob.from("comments").delete().eq("id", comment.id));
ok(
  await bob
    .from("favorites")
    .delete()
    .eq("article_id", row.id)
    .eq("user_id", b.id),
);
ok(
  await bob
    .from("follows")
    .delete()
    .eq("follower_id", b.id)
    .eq("followed_id", a.id),
);
assert.deepEqual(
  ok(await bob.from("articles").delete().eq("id", row.id).select()),
  [],
);
ok(await alice.from("articles").delete().eq("id", row.id));
assert.equal(
  ok(await anon.from("articles").select("*").eq("id", row.id)).length,
  0,
);
await Promise.all([alice.auth.signOut(), bob.auth.signOut()]);
console.log(
  "PASS: signup, profiles, article CRUD, tags, comments, favorites, follows, feed and cross-user RLS",
);
