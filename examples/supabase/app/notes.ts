// notes: a small app on the local Supabase stack, run by the Bun inside the Supabase CLI.
// Auth signs users up and in; the Data API (PostgREST) stores and queries the notes; row level
// security in Postgres keeps each user's notes their own; Realtime streams them as they're written.
//
//   notes signup|login EMAIL PASSWORD    notes whoami    notes logout
//   notes add TEXT...    notes ls    notes search WORD    notes rm ID    notes watch [SECONDS]
const { API_URL, ANON_KEY } = process.env;
if (!API_URL || !ANON_KEY) throw new Error("API_URL and ANON_KEY aren't set (supabase status --env has them)");

// The session from signup/login, kept between commands
const file = Bun.file(`${process.env.HOME}/.notes-session.json`);
type Session = { access_token: string; user: { id: string; email: string } };
const session = async (): Promise<Session> => {
  if (!(await file.exists())) throw new Error("not signed in: notes signup EMAIL PASSWORD");
  return file.json();
};

async function call(path: string, init: { method?: string; body?: unknown; token?: string; prefer?: string } = {}) {
  const res = await fetch(API_URL + path, {
    method: init.method ?? "GET",
    headers: {
      apikey: ANON_KEY!,
      Authorization: `Bearer ${init.token ?? ANON_KEY}`,
      "Content-Type": "application/json",
      ...(init.prefer && { Prefer: init.prefer }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(json?.msg ?? json?.message ?? json?.error_description ?? `HTTP ${res.status}`);
  return json;
}

// The Data API: notes the signed-in user may see (row level security filters the rest out)
const notes = (query: string) => session().then((s) => call(`/rest/v1/notes?select=id,body,created_at&order=id${query}`, { token: s.access_token }));
const print = (rows: { id: number; body: string; created_at: string }[]) =>
  rows.forEach((n) => console.log(`  #${n.id}  ${n.created_at.slice(11, 19)}  ${n.body}`));

const [command, ...args] = process.argv.slice(2);
try {
  switch (command) {
    case "signup":
    case "login": {
      // Auth: a session whose access token (a JWT) the Data API checks, and RLS reads the user from
      const [email, password] = args;
      const signup = () => call("/auth/v1/signup", { method: "POST", body: { email, password } });
      const login = () => call("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      // A cold stack on one CPU can time out at the gateway after the user was already created, so
      // a retried signup falls back to login
      let s;
      try {
        s = await (command === "signup" ? signup() : login());
      } catch (e) {
        if (!/timed out/.test((e as Error).message)) throw e;
        s = await login().catch(signup);
      }
      await Bun.write(file, JSON.stringify({ access_token: s.access_token, user: s.user }));
      console.log(`signed in as ${s.user.email} (${s.user.id.slice(0, 8)})`);
      break;
    }
    case "whoami": {
      const { user } = await session();
      console.log(`${user.email} (${user.id.slice(0, 8)})`);
      break;
    }
    case "add": {
      const { access_token: token } = await session();
      const [n] = await call("/rest/v1/notes", { method: "POST", body: { body: args.join(" ") }, token, prefer: "return=representation" });
      console.log(`#${n.id} added`);
      break;
    }
    case "ls": {
      const rows = await notes("");
      console.log(`${(await session()).user.email}: ${rows.length} note(s)`);
      print(rows);
      break;
    }
    case "search": {
      const rows = await notes(`&body=ilike.*${encodeURIComponent(args.join(" "))}*`);
      console.log(`${rows.length} note(s) matching "${args.join(" ")}"`);
      print(rows);
      break;
    }
    case "rm": {
      const { access_token: token } = await session();
      const gone = await call(`/rest/v1/notes?id=eq.${Number(args[0])}`, { method: "DELETE", token, prefer: "return=representation" });
      console.log(gone.length ? `#${args[0]} removed` : `no note #${args[0]} of yours`);
      break;
    }
    case "watch": {
      // Realtime: a Phoenix channel over a WebSocket on the API's port, joined with the user's
      // token, so row level security decides which inserts reach it (the user's own notes)
      const { access_token: token, user } = await session();
      const seconds = Number(args[0]) || 0;
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(`${API_URL.replace(/^http/, "ws")}/realtime/v1/websocket?apikey=${ANON_KEY}&vsn=1.0.0`);
        let ref = 0;
        const send = (topic: string, event: string, payload: unknown) =>
          ws.send(JSON.stringify({ topic, event, payload, ref: String(++ref) }));
        const heartbeat = setInterval(() => send("phoenix", "heartbeat", {}), 25_000);
        const done = () => (clearInterval(heartbeat), ws.close(), resolve());
        if (seconds) setTimeout(done, seconds * 1000);
        ws.onopen = () =>
          send("realtime:notes", "phx_join", {
            config: { postgres_changes: [{ event: "*", schema: "public", table: "notes" }] },
            access_token: token,
          });
        // Realtime may pass on changes committed just before the join; only later ones are news
        let since = Infinity;
        ws.onmessage = (m) => {
          const { event, payload } = JSON.parse(String(m.data));
          if (event === "system" && payload.extension === "postgres_changes") {
            if (payload.status !== "ok") return reject(new Error(payload.message));
            since = Date.now() - 50;
            console.log(`watching ${user.email}'s notes${seconds ? ` for ${seconds}s` : " (Ctrl-C to stop)"}`);
          } else if (event === "postgres_changes") {
            const { type, record, old_record, commit_timestamp } = payload.data;
            if (Date.parse(commit_timestamp) < since) return;
            if (type === "INSERT") console.log(`  + #${record.id}  ${record.created_at.slice(11, 19)}  ${record.body}`);
            else if (type === "DELETE") console.log(`  - #${old_record.id}`);
          } else if (event === "phx_reply" && payload.status !== "ok") {
            reject(new Error(payload.response?.reason ?? "couldn't join the channel"));
          }
        };
        ws.onerror = () => reject(new Error("Realtime's WebSocket failed"));
        ws.onclose = () => (clearInterval(heartbeat), resolve());
      });
      break;
    }
    case "logout":
      await file.unlink().catch(() => {});
      console.log("signed out");
      break;
    default:
      console.log("usage: notes signup|login EMAIL PASSWORD · whoami · add TEXT · ls · search WORD · rm ID · watch [SECONDS] · logout");
  }
} catch (e) {
  console.error("notes:", (e as Error).message);
  process.exitCode = 1;
}
