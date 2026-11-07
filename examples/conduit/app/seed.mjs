import { createClient } from "@supabase/supabase-js";
const db = createClient(process.env.API_URL, process.env.ANON_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
function ok(r) {
  if (r.error) throw r.error;
  return r.data;
}
const email = "demo@conduit.local",
  password = "conduit-demo-2026";
let login = await db.auth.signInWithPassword({ email, password });
if (login.error)
  login = await db.auth.signUp({
    email,
    password,
    options: { data: { username: "demo" } },
  });
const { user } = ok(login);
ok(
  await db
    .from("profiles")
    .update({ bio: "Welcome to Conduit. Write something worth sharing." })
    .eq("id", user.id),
);
for (const [slug, title, description, body, tags] of [
  [
    "welcome-to-conduit",
    "Welcome to Conduit",
    "A place to share your knowledge, now running in a single browser VM.",
    "# Welcome to Conduit\n\nThis is a working blogging app backed by **Supabase**. Browse articles, make an account, follow writers, and share your ideas.\n\nSign in with the demo account, or create your own. Every visitor gets an independent machine.",
    ["conduit", "welcome"],
  ],
  [
    "supabase-in-one-vm",
    "A whole backend in one VM",
    "Postgres, Auth, and the Data API, alongside the app.",
    "## Small stack, real database\n\nAll application data goes through `@supabase/supabase-js`. Supabase Auth handles sessions, PostgREST exposes the database, and row level security controls writes.\n\nTry writing a Markdown article, adding a comment, or favoriting this post.",
    ["supabase", "snowglobe"],
  ],
  [
    "make-it-your-own",
    "Make it your own",
    "Read, write, follow, and explore.",
    "## Try a few things\n\n1. Create an account.\n2. Follow demo from the profile page.\n3. Open Your Feed.\n4. Publish your first article with a few tags.\n\nYour data lives in the VM with the app.",
    ["conduit", "getting-started"],
  ],
])
  ok(
    await db
      .from("articles")
      .upsert(
        { slug, title, description, body, tags, author_id: user.id },
        { onConflict: "slug", ignoreDuplicates: true },
      ),
  );
await db.auth.signOut();
console.log(
  "Conduit seeded: 3 articles; demo@conduit.local / conduit-demo-2026",
);
