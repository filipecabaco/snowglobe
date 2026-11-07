import React, { useState, useEffect, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { supabase as db, result, profile, article, articleSelect } from "./api";
import "./styles.css";
const go = (path) => {
  location.hash = path;
};
const href = (path) => "#" + path;
const date = (value) =>
  new Date(value).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
const Context = createContext(null);
function App() {
  const [route, setRoute] = useState(location.hash.slice(1) || "/");
  const [user, setUser] = useState(null),
    [me, setMe] = useState(null),
    [ready, setReady] = useState(false);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    const change = () => {
      setRoute(location.hash.slice(1) || "/");
      setError("");
    };
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  useEffect(() => {
    const {
      data: { subscription },
    } = db.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      setReady(true);
    });
    return () => subscription.unsubscribe();
  }, []);
  useEffect(() => {
    let live = true;
    setMe(null);
    if (user)
      profile(user.id)
        .then((p) => live && setMe(p))
        .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [user, revision]);
  async function act(fn) {
    setError("");
    setBusy(true);
    try {
      await fn();
      setRevision((n) => n + 1);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function needUser() {
    if (!user) {
      go("/login");
      return false;
    }
    return true;
  }
  async function favorite(a) {
    if (!needUser()) return;
    await act(async () => {
      result(
        await (a.favorites.some((f) => f.user_id === user.id)
          ? db
              .from("favorites")
              .delete()
              .eq("article_id", a.id)
              .eq("user_id", user.id)
          : db
              .from("favorites")
              .insert({ article_id: a.id, user_id: user.id })),
      );
    });
  }
  let page;
  const parts = route.split("/");
  if (parts[1] === "login" || parts[1] === "register")
    page = <Auth signup={parts[1] === "register"} />;
  else if (parts[1] === "article") page = <Article slug={parts[2]} />;
  else if (parts[1] === "editor") page = <Editor slug={parts[2]} />;
  else if (parts[1] === "settings") page = <Settings />;
  else
    page = (
      <Feed
        username={
          parts[1] === "profile" ? decodeURIComponent(parts[2]) : undefined
        }
      />
    );
  return (
    <Context.Provider
      value={{ user, me, busy, revision, act, needUser, favorite, setError }}
    >
      <nav>
        <a className="brand" href="#/">
          conduit
        </a>
        <div>
          <a href="#/">Home</a>
          {user ? (
            <>
              <a href="#/editor">New Article</a>
              <a href="#/settings">Settings</a>
              <a
                href={href(
                  "/profile/" + encodeURIComponent(me?.username || ""),
                )}
              >
                {me?.username || "Profile"}
              </a>
            </>
          ) : (
            <>
              <a href="#/login">Sign in</a>
              <a href="#/register">Sign up</a>
            </>
          )}
        </div>
      </nav>
      {error && (
        <div role="alert" className="error">
          {error}
          <button onClick={() => setError("")}>Dismiss</button>
        </div>
      )}
      {ready ? (
        <React.Fragment key={route}>{page}</React.Fragment>
      ) : (
        <main>Connecting to Supabase…</main>
      )}
      <footer>
        <span className="brand">conduit</span> A RealWorld demo · Powered by
        Supabase and Snowglobe
      </footer>
    </Context.Provider>
  );
}
function Favorite({ a }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  return (
    <button
      disabled={busy}
      className={
        "small " +
        (a.favorites.some((f) => f.user_id === user?.id) ? "selected" : "")
      }
      onClick={() => favorite(a)}
    >
      ♥ {a.favorites.length}
    </button>
  );
}
function Author({ p, created }) {
  return (
    <div className="author">
      {/^https?:\/\//i.test(p.image) ? (
        <img
          className="avatar"
          src={p.image}
          alt=""
          referrerPolicy="no-referrer"
        />
      ) : (
        <span className="avatar">{p.username[0].toUpperCase()}</span>
      )}
      <div>
        <a href={href("/profile/" + encodeURIComponent(p.username))}>
          {p.username}
        </a>
        {created && <small>{date(created)}</small>}
      </div>
    </div>
  );
}
function Follow({ p }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  const [following, setFollowing] = useState(false);
  useEffect(() => {
    let live = true;
    if (user)
      db.from("follows")
        .select("*")
        .eq("follower_id", user.id)
        .eq("followed_id", p.id)
        .then((r) => {
          const rows = result(r);
          if (live) setFollowing(rows.length > 0);
        })
        .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [p.id, user, revision]);
  if (p.id === user?.id)
    return (
      <a className="button" href="#/settings">
        Edit profile
      </a>
    );
  return (
    <button
      disabled={busy}
      onClick={() =>
        needUser() &&
        act(async () =>
          result(
            await (following
              ? db
                  .from("follows")
                  .delete()
                  .eq("follower_id", user.id)
                  .eq("followed_id", p.id)
              : db
                  .from("follows")
                  .insert({ follower_id: user.id, followed_id: p.id })),
          ),
        )
      }
    >
      {following ? "Unfollow" : "Follow"} {p.username}
    </button>
  );
}
function Feed({ username }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  const [items, setItems] = useState(null),
    [tags, setTags] = useState([]),
    [tag, setTag] = useState(""),
    [tab, setTab] = useState("global"),
    [page, setPage] = useState(0),
    [count, setCount] = useState(0),
    [person, setPerson] = useState(null);
  useEffect(() => {
    let live = true;
    setItems(null);
    (async () => {
      let q = db
        .from("articles")
        .select(articleSelect, { count: "exact" })
        .order("created_at", { ascending: false });
      if (username) {
        const p = result(
          await db
            .from("profiles")
            .select("*")
            .eq("username", username)
            .single(),
        );
        if (live) setPerson(p);
        if (tab === "favorites") {
          const ids = result(
            await db.from("favorites").select("article_id").eq("user_id", p.id),
          );
          q = q.in(
            "id",
            ids.map((f) => f.article_id),
          );
        } else q = q.eq("author_id", p.id);
      } else if (tab === "feed") {
        if (!user) {
          if (live) {
            setItems([]);
            setCount(0);
          }
          return;
        }
        const ids = result(
          await db
            .from("follows")
            .select("followed_id")
            .eq("follower_id", user.id),
        );
        q = q.in(
          "author_id",
          ids.map((f) => f.followed_id),
        );
      }
      if (tag) q = q.contains("tags", [tag]);
      const r = await q.range(page * 10, page * 10 + 9);
      const rows = result(r);
      if (live) {
        setItems(rows);
        setCount(r.count);
      }
      const ts = result(await db.rpc("tags"));
      if (live) setTags(ts.map((t) => t.tag));
    })().catch((e) => {
      if (live) setError(e.message);
    });
    return () => {
      live = false;
    };
  }, [username, tab, tag, page, revision, user]);
  const choose = (t) => {
    setTab(t);
    setTag("");
    setPage(0);
  };
  return (
    <>
      {username ? (
        person && (
          <section className="profile-banner">
            <h1>{person.username}</h1>
            <p>{person.bio}</p>
            <Follow p={person} />
          </section>
        )
      ) : (
        <section className="banner">
          <h1>conduit</h1>
          <p>A place to share your knowledge.</p>
        </section>
      )}
      <main className="layout">
        <section>
          <div className="tabs">
            {username ? (
              <>
                <button
                  className={tab === "global" ? "active" : ""}
                  onClick={() => choose("global")}
                >
                  My Articles
                </button>
                <button
                  className={tab === "favorites" ? "active" : ""}
                  onClick={() => choose("favorites")}
                >
                  Favorited Articles
                </button>
              </>
            ) : (
              <>
                {user && (
                  <button
                    className={tab === "feed" ? "active" : ""}
                    onClick={() => choose("feed")}
                  >
                    Your Feed
                  </button>
                )}
                <button
                  className={tab === "global" && !tag ? "active" : ""}
                  onClick={() => choose("global")}
                >
                  Global Feed
                </button>
              </>
            )}
            {tag && <button className="active">#{tag}</button>}
          </div>
          {items === null ? (
            <p>Loading articles…</p>
          ) : items.length === 0 ? (
            <p>No articles here yet.</p>
          ) : (
            items.map((a) => (
              <article className="preview" key={a.id}>
                <div className="meta">
                  <Author p={a.author} created={a.created_at} />
                  <Favorite a={a} />
                </div>
                <a className="article-link" href={href("/article/" + a.slug)}>
                  <h2>{a.title}</h2>
                  <p>{a.description}</p>
                </a>
                <div className="meta">
                  <a className="muted" href={href("/article/" + a.slug)}>
                    Read more…
                  </a>
                  <div>
                    {a.tags.map((t) => (
                      <button
                        className="tag"
                        key={t}
                        onClick={() => {
                          setTag(t);
                          setPage(0);
                        }}
                      >
                        {t}
                      </button>
                    ))}
                  </div>
                </div>
              </article>
            ))
          )}
          <div className="pages">
            {Array.from({ length: Math.ceil(count / 10) }, (_, i) => (
              <button
                className={page === i ? "selected" : ""}
                key={i}
                onClick={() => setPage(i)}
              >
                {i + 1}
              </button>
            ))}
          </div>
        </section>
        {!username && (
          <aside>
            <h3>Popular Tags</h3>
            {tags.map((t) => (
              <button
                className="tag"
                key={t}
                onClick={() => {
                  setTag(t);
                  setTab("global");
                  setPage(0);
                }}
              >
                {t}
              </button>
            ))}
            <hr />
            <p>
              Conduit + Supabase
              <br />
              One Linux VM. Your own copy.
            </p>
            <a href="#/login">Try the demo account</a>
          </aside>
        )}
      </main>
    </>
  );
}
function Article({ slug }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  const [a, setA] = useState(null),
    [comments, setComments] = useState([]);
  useEffect(() => {
    let live = true;
    article(slug)
      .then(async (a) => {
        const c = result(
          await db
            .from("comments")
            .select("*,author:profiles!author_id(*)")
            .eq("article_id", a.id)
            .order("created_at"),
        );
        if (live) {
          setA(a);
          setComments(c);
        }
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [slug, revision]);
  if (!a) return <main>Loading article…</main>;
  return (
    <>
      <section className="article-banner">
        <div>
          <h1>{a.title}</h1>
          <div className="meta">
            <Author p={a.author} created={a.created_at} />
            <div className="actions">
              <Follow p={a.author} />
              <Favorite a={a} />
              {user?.id === a.author_id && (
                <>
                  <a className="button" href={href("/editor/" + a.slug)}>
                    Edit article
                  </a>
                  <button
                    disabled={busy}
                    onClick={() =>
                      confirm("Delete this article?") &&
                      act(async () => {
                        result(
                          await db.from("articles").delete().eq("id", a.id),
                        );
                        go("/");
                      })
                    }
                  >
                    Delete article
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </section>
      <main>
        <div
          className="markdown"
          dangerouslySetInnerHTML={{
            __html: DOMPurify.sanitize(marked.parse(a.body)),
          }}
        />
        {a.tags.map((t) => (
          <span className="tag" key={t}>
            {t}
          </span>
        ))}
        <hr />
        <section className="comments">
          {user ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const form = e.currentTarget;
                act(async () => {
                  result(
                    await db.from("comments").insert({
                      article_id: a.id,
                      author_id: user.id,
                      body: new FormData(form).get("body"),
                    }),
                  );
                  form.reset();
                });
              }}
            >
              <textarea
                aria-label="Comment"
                name="body"
                required
                placeholder="Write a comment…"
              />
              <button disabled={busy}>Post Comment</button>
            </form>
          ) : (
            <p>
              <a href="#/login">Sign in</a> or <a href="#/register">sign up</a>{" "}
              to add comments.
            </p>
          )}
          {comments.map((c) => (
            <article className="comment" key={c.id}>
              <p>{c.body}</p>
              <div className="meta">
                <Author p={c.author} created={c.created_at} />
                {user?.id === c.author_id && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(async () =>
                        result(
                          await db.from("comments").delete().eq("id", c.id),
                        ),
                      )
                    }
                  >
                    Delete comment
                  </button>
                )}
              </div>
            </article>
          ))}
        </section>
      </main>
    </>
  );
}
function Auth({ signup }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  return (
    <main className="narrow">
      <h1>{signup ? "Sign up" : "Sign in"}</h1>
      <p>
        <a href={signup ? "#/login" : "#/register"}>
          {signup ? "Have an account?" : "Need an account?"}
        </a>
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          act(async () => {
            const args = { email: f.get("email"), password: f.get("password") };
            const r = signup
              ? await db.auth.signUp({
                  ...args,
                  options: { data: { username: f.get("username") } },
                })
              : await db.auth.signInWithPassword(args);
            result(r);
            if (!r.data.session)
              throw new Error("Check your email to confirm your account.");
            go("/");
          });
        }}
      >
        {signup && (
          <input
            name="username"
            aria-label="Username"
            placeholder="Username"
            required
            maxLength={40}
          />
        )}
        <input
          name="email"
          type="email"
          aria-label="Email"
          placeholder="Email"
          required
        />
        <input
          name="password"
          type="password"
          aria-label="Password"
          placeholder="Password"
          minLength={6}
          required
        />
        <button disabled={busy}>{signup ? "Sign up" : "Sign in"}</button>
      </form>
      {!signup && (
        <p className="hint">
          Demo: <strong>demo@conduit.local</strong>
          <br />
          Password: <strong>conduit-demo-2026</strong>
        </p>
      )}
    </main>
  );
}
function Editor({ slug }) {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  const [a, setA] = useState(slug ? null : {});
  useEffect(() => {
    let live = true;
    if (slug)
      article(slug)
        .then((a) => live && setA(a))
        .catch((e) => setError(e.message));
    return () => {
      live = false;
    };
  }, [slug]);
  if (!user)
    return (
      <main>
        <a href="#/login">Sign in to write an article.</a>
      </main>
    );
  if (!a) return <main>Loading…</main>;
  if (a.author_id && a.author_id !== user.id)
    return <main>You can only edit your own articles.</main>;
  return (
    <main className="editor">
      <h1>{slug ? "Edit article" : "New article"}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          act(async () => {
            const values = {
              title: f.get("title"),
              description: f.get("description"),
              body: f.get("body"),
              tags: [
                ...new Set(
                  f
                    .get("tags")
                    .split(",")
                    .map((t) => t.trim())
                    .filter(Boolean),
                ),
              ],
            };
            const nextSlug =
              slug ||
              values.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-|-$/g, "") +
                "-" +
                crypto.randomUUID().slice(0, 8);
            result(
              await (slug
                ? db.from("articles").update(values).eq("id", a.id)
                : db
                    .from("articles")
                    .insert({ ...values, slug: nextSlug, author_id: user.id })),
            );
            go("/article/" + nextSlug);
          });
        }}
      >
        <input
          aria-label="Article Title"
          name="title"
          defaultValue={a.title}
          placeholder="Article Title"
          required
        />
        <input
          aria-label="Description"
          name="description"
          defaultValue={a.description}
          placeholder="What's this article about?"
          required
        />
        <textarea
          aria-label="Article body"
          name="body"
          defaultValue={a.body}
          placeholder="Write your article (in markdown)"
          required
          rows={10}
        />
        <input
          aria-label="Tags"
          name="tags"
          defaultValue={a.tags?.join(", ")}
          placeholder="Enter tags, separated by commas"
        />
        <button disabled={busy}>Publish Article</button>
      </form>
    </main>
  );
}
function Settings() {
  const { user, me, busy, revision, act, needUser, favorite, setError } =
    useContext(Context);
  if (!user)
    return (
      <main>
        <a href="#/login">Sign in to edit your settings.</a>
      </main>
    );
  if (!me) return <main>Loading…</main>;
  return (
    <main className="narrow">
      <h1>Your Settings</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          act(async () => {
            result(
              await db
                .from("profiles")
                .update({
                  username: f.get("username"),
                  bio: f.get("bio"),
                  image: f.get("image"),
                })
                .eq("id", user.id),
            );
            const changes = {};
            if (f.get("email") !== user.email) changes.email = f.get("email");
            if (f.get("password")) changes.password = f.get("password");
            if (Object.keys(changes).length)
              result(await db.auth.updateUser(changes));
            go("/profile/" + encodeURIComponent(f.get("username")));
          });
        }}
      >
        <input
          aria-label="Profile image URL"
          type="url"
          name="image"
          placeholder="Profile image URL"
          defaultValue={me.image}
        />
        <input
          aria-label="Username"
          name="username"
          defaultValue={me.username}
          required
          maxLength={40}
        />
        <textarea
          aria-label="Bio"
          name="bio"
          defaultValue={me.bio}
          placeholder="Short bio"
        />
        <input
          aria-label="Email"
          type="email"
          name="email"
          defaultValue={user.email}
          required
        />
        <input
          aria-label="New password"
          type="password"
          name="password"
          placeholder="New password (optional)"
          minLength={6}
        />
        <button disabled={busy}>Update Settings</button>
      </form>
      <hr />
      <button
        disabled={busy}
        onClick={() =>
          act(async () => {
            result(await db.auth.signOut());
            go("/");
          })
        }
      >
        Log out
      </button>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
