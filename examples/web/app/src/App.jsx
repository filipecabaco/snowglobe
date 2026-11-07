import { useEffect, useState } from "react";
import { supabase, supabaseUrl } from "./supabase.js";

// Notes on Supabase: Auth signs you up and in, the Data API stores the notes, and row level
// security in Postgres keeps each user's notes their own (the supabase machine's notes table)
export default function App() {
  const [session, setSession] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  return (
    <main className="app">
      <header>
        <h1>Notes</h1>
        {session && (
          <p className="who">
            {session.user.email} <button type="button" onClick={() => supabase.auth.signOut()}>Sign out</button>
          </p>
        )}
      </header>
      {!ready ? <p className="quiet">Loading…</p> : session ? <Notes /> : <SignIn />}
      <footer className="quiet">Supabase at {supabaseUrl}</footer>
    </main>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(mode) {
    setBusy(true);
    setError(null);
    const { error } = mode === "signup"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    if (error) setError(error.message);
    setBusy(false);
  }

  return (
    <form className="card" onSubmit={(e) => { e.preventDefault(); submit("login"); }}>
      <label>Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" /></label>
      <label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="current-password" /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>Log in</button>
        <button type="button" disabled={busy} onClick={() => submit("signup")}>Sign up</button>
      </div>
    </form>
  );
}

function Notes() {
  const [notes, setNotes] = useState([]);
  const [body, setBody] = useState("");
  const [error, setError] = useState(null);

  async function load() {
    const { data, error } = await supabase.from("notes").select("id, body, created_at").order("id");
    if (error) setError(error.message);
    else setNotes(data);
  }

  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!body.trim()) return;
    const { error } = await supabase.from("notes").insert({ body: body.trim() });
    if (error) return setError(error.message);
    setBody("");
    load();
  }

  async function remove(id) {
    const { error } = await supabase.from("notes").delete().eq("id", id);
    if (error) return setError(error.message);
    load();
  }

  return (
    <section>
      <form className="row" onSubmit={add}>
        <input aria-label="New note" value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a note" maxLength={500} />
        <button type="submit">Add</button>
      </form>
      {error && <p className="error" role="alert">{error}</p>}
      {notes.length === 0 ? <p className="quiet">No notes yet.</p> : (
        <ul className="notes">
          {notes.map((n) => (
            <li key={n.id}>
              <span>{n.body}</span>
              <time className="quiet">{new Date(n.created_at).toLocaleTimeString()}</time>
              <button type="button" aria-label={`Delete note ${n.id}`} onClick={() => remove(n.id)}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
