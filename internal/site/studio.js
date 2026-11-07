// The agent page's studio (/agent/): what it shows of the app an agent builds, beside the preview.
//  - The Code view: a project's files (list_files' entries) as a tree, and a file's text with its
//    syntax coloured by a small tokenizer of our own (JavaScript, JSX and TypeScript, CSS, HTML,
//    JSON, SQL): a dozen regular expressions rather than a highlighter library, so the page stays
//    hand-written and small (this file is a few KiB; Prism or highlight.js with these grammars are
//    tens). Colours are classes; the page's CSS gives them the terminal's palette.
//  - The Database view: the tables of Supabase's public schema, from one query.
//  - The prompt a person gives an external agent to work in this tab.
(function (root) {
  "use strict";

  /** list_files' entries as a tree: [{ name, path, type, skipped?, size, children? }], directories
   *  first, then files, each by name. */
  function buildTree(entries) {
    const top = { children: new Map() };
    for (const e of entries) {
      const parts = e.path.split("/");
      let node = top;
      parts.forEach((name, i) => {
        const path = parts.slice(0, i + 1).join("/");
        let child = node.children.get(name);
        if (!child) {
          child = { name, path, type: i < parts.length - 1 ? "dir" : e.type, size: 0, children: new Map() };
          node.children.set(name, child);
        }
        if (i === parts.length - 1) Object.assign(child, { type: e.type, size: e.size ?? 0, ...(e.skipped ? { skipped: true } : {}) });
        node = child;
      });
    }
    const out = (n) => [...n.children.values()]
      .sort((a, b) => (a.type === "dir") !== (b.type === "dir") ? (a.type === "dir" ? -1 : 1) : a.name.localeCompare(b.name))
      .map((c) => {
        const { children, ...rest } = c;
        return c.type === "dir" ? { ...rest, children: out(c) } : rest;
      });
    return out(top);
  }

  /** The tokenizer's language for a file, by its name. */
  function langOf(path) {
    const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
    if (["js", "jsx", "ts", "tsx", "mjs", "cjs", "mts", "cts"].includes(ext)) return "js";
    if (["css", "scss", "pcss"].includes(ext)) return "css";
    if (["html", "htm", "svg", "xml"].includes(ext)) return "html";
    if (ext === "json" || ext === "webmanifest") return "json";
    if (ext === "sql") return "sql";
    return "text";
  }

  const JS_KEYWORDS = "as async await break case catch class const continue debugger default delete do else enum export extends false finally for from function if implements import in instanceof interface let new null of private protected public readonly return satisfies static super switch this throw true try type typeof undefined var void while with yield";
  const SQL_KEYWORDS = "add all alter and as asc authenticated begin between by cascade case check column commit constraint create default delete desc distinct do drop else enable end exists false foreign from function grant group having if in index insert into is join key left like limit not notify null on or order owner policy primary references replace returns returning revoke right role row security select set table to trigger true truncate union unique update using values view when where with";
  const words = (s) => new Set(s.split(" "));
  const KW = { js: words(JS_KEYWORDS), sql: words(SQL_KEYWORDS) };

  // Each language: one sticky alternation; the group that matched is the token's class
  // (c comment, s string, n number, k keyword, t tag or type, a attribute or property, p punctuation)
  const GRAMMARS = {
    js: [
      ["c", /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
      ["s", /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?|`(?:[^`\\]|\\[\s\S])*`?/y],
      ["t", /(?<=<\/?)[A-Za-z][\w.:-]*(?=[\s/>])/y],
      ["n", /\b(?:0[xob][\da-f_]+|\d[\d_]*(?:\.\d+)?(?:e[+-]?\d+)?n?)\b/iy],
      ["w", /[A-Za-z_$][\w$]*/y],
      ["p", /[{}()[\];,.<>/=+\-*%!&|?:~^]+/y],
    ],
    css: [
      ["c", /\/\*[\s\S]*?(?:\*\/|$)/y],
      ["s", /"(?:[^"\\\n]|\\.)*"?|'(?:[^'\\\n]|\\.)*'?/y],
      ["k", /@[\w-]+/y],
      ["a", /[\w-]+(?=\s*:(?!:)[^{};]*[;}\n])/y],
      ["n", /#[\da-f]{3,8}\b|-?\d*\.?\d+(?:%|[a-z]+)?/iy],
      ["p", /[{}()[\];,:>+~*=]+/y],
    ],
    html: [
      ["c", /<!--[\s\S]*?(?:-->|$)/y],
      ["t", /<\/?[A-Za-z][\w:-]*|\/?>/y],
      ["a", /[\w:-]+(?==)/y],
      ["s", /"[^"\n]*"?|'[^'\n]*'?/y],
    ],
    json: [
      ["a", /"(?:[^"\\\n]|\\.)*"(?=\s*:)/y],
      ["s", /"(?:[^"\\\n]|\\.)*"?/y],
      ["n", /-?\d+(?:\.\d+)?(?:e[+-]?\d+)?|\b(?:true|false|null)\b/iy],
      ["p", /[{}[\],:]+/y],
    ],
    sql: [
      ["c", /--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)/y],
      ["s", /'(?:[^']|'')*'?|"[^"\n]*"?/y],
      ["n", /\b\d+(?:\.\d+)?\b/y],
      ["w", /[A-Za-z_][\w$]*/y],
      ["p", /[(),;.=<>*+\-]+/y],
    ],
  };

  /**
   * A text's tokens, line by line: [[[class, text], ...], ...], class "" for plain text. A token
   * that spans lines (a block comment, a template string) is split at each line break, keeping its
   * class. Texts over `max` characters are left plain.
   */
  function tokenize(text, lang, { max = 200000 } = {}) {
    const g = GRAMMARS[lang];
    const tokens = [];
    if (!g || text.length > max) tokens.push(["", text]);
    else {
      let i = 0;
      let plain = "";
      outer: while (i < text.length) {
        for (const [cls, re] of g) {
          re.lastIndex = i;
          const m = re.exec(text);
          if (m && m[0].length) {
            if (plain) { tokens.push(["", plain]); plain = ""; }
            let c = cls;
            if (c === "w") {
              const kw = lang === "sql" ? KW.sql.has(m[0].toLowerCase()) : KW.js.has(m[0]);
              c = kw ? "k" : lang === "js" && /^[A-Z]/.test(m[0]) ? "t" : "";
            }
            tokens.push([c, m[0]]);
            i += m[0].length;
            continue outer;
          }
        }
        plain += text[i++];
      }
      if (plain) tokens.push(["", plain]);
    }
    const lines = [[]];
    for (const [c, t] of tokens) {
      const parts = t.split("\n");
      parts.forEach((p, k) => {
        if (k > 0) lines.push([]);
        if (p) lines.at(-1).push([c, p]);
      });
    }
    if (lines.length > 1 && lines.at(-1).length === 0 && text.endsWith("\n")) lines.pop();
    return lines;
  }

  /** A file's text drawn into `pre`: a span a line (.ln, numbered by CSS), a span a coloured
   *  token. `hot` (a set of line numbers, from 1) marks lines the last change touched. */
  function renderCode(doc, pre, text, lang, { hot } = {}) {
    const frag = [];
    tokenize(text, lang).forEach((line, n) => {
      const ln = doc.createElement("span");
      ln.className = hot?.has(n + 1) ? "ln hot" : "ln";
      for (const [c, t] of line) {
        if (!c) { ln.append(doc.createTextNode ? doc.createTextNode(t) : Object.assign(doc.createElement("span"), { textContent: t })); continue; }
        const s = doc.createElement("span");
        s.className = c;
        s.textContent = t;
        ln.append(s);
      }
      ln.append(doc.createTextNode ? doc.createTextNode("\n") : Object.assign(doc.createElement("span"), { textContent: "\n" }));
      frag.push(ln);
    });
    pre.replaceChildren(...frag);
  }

  /** The lines a unified diff added, in the new file's numbering (for renderCode's hot). */
  function addedLines(diff) {
    const hot = new Set();
    let n = 0;
    for (const line of String(diff ?? "").split("\n")) {
      const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (h) { n = Number(h[1]); continue; }
      if (!n) continue;
      if (line.startsWith("+")) hot.add(n++);
      else if (line.startsWith("-")) continue;
      else n++;
    }
    return hot;
  }

  // ---------------------------------------------------------------- the database

  /** The query the Database view runs (tab-separated, no headers): a T row a table (name, row level
   *  security on), a C row a column (table, name, type, nullable). */
  const TABLES_SQL = `select 'T', c.relname, c.relrowsecurity::text, '' from pg_class c
  where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') order by c.relname;
select 'C', table_name, column_name, data_type || case when is_nullable = 'NO' then ' not null' else '' end
  from information_schema.columns where table_schema = 'public' order by table_name, ordinal_position;`;

  /** What TABLES_SQL printed: [{ name, rls, columns: [{ name, type }] }]. */
  function parseTables(tsv) {
    const tables = new Map();
    for (const line of String(tsv).split("\n")) {
      const f = line.replace(/\r$/, "").split("\t");
      if (f[0] === "T" && f.length >= 3) tables.set(f[1], { name: f[1], rls: f[2] === "true", columns: [] });
      else if (f[0] === "C" && f.length >= 4) {
        if (!tables.has(f[1])) tables.set(f[1], { name: f[1], rls: null, columns: [] });
        tables.get(f[1]).columns.push({ name: f[2], type: f[3] });
      }
    }
    return [...tables.values()];
  }

  // ---------------------------------------------------------------- connecting an agent

  /** The prompt a person gives their agent: where the tab is, its tools, and how to work in it. */
  function agentPrompt(url) {
    return `Build a web app for me in my browser tab at ${url}
That tab runs Linux machines in WebAssembly, and offers them as WebMCP tools (call list_runtimes first).
The project: React 19, Vite, Tailwind v4 and TypeScript in /root/app on runtime "web". It starts blank (src/App.jsx is an
empty page): you build the app from nothing. Supabase (Postgres, Auth, the Data API) is on runtime "supabase", with no
tables of the app's yet; supabase-js is set up in src/supabase.js (import { supabase } from "./supabase.js").

How to work:
- open_preview {runtime: "web", port: 4173} so I can watch; the app rebuilds and reloads on every change.
- list_files and read_file before you change anything; write_files with each file's whole new text (it waits
  for the rebuild and returns the build error if there is one: fix it). revert_changes undoes a change.
- Schema: run_sql (create tables, enable row level security, grant to and add policies for the authenticated role),
  and keep each migration in /root/app/supabase/migrations/. Sign-ups are confirmed at once (local Auth). Already installed: react-router, zustand, clsx, tailwindcss;
  run_command "cd /root/app && npm install <pkg>" adds others (slowly: it runs in the tab).
- If you have no WebMCP tools, use the page's Machines section instead: "Run a command" (runtime web) does the same.

What to build: `;
  }

  const SnowglobeStudio = { buildTree, langOf, tokenize, renderCode, addedLines, TABLES_SQL, parseTables, agentPrompt };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeStudio;
  else root.SnowglobeStudio = SnowglobeStudio;
})(typeof window !== "undefined" ? window : globalThis);
