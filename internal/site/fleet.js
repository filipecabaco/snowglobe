// The fleet page (/fleet/): a snowglobe.toml, run in the browser. Three parts, none of which touch
// the DOM (fleet-page.js does):
//  - parse(text): the TOML a fleet file uses (tables, strings, numbers, booleans, arrays), with the
//    line of whatever it refuses;
//  - plan(file, runtimes): what the page can do with the file, as steps (a snapshot's setup, a
//    service opened, a machine woken), the problems that stop it, and notes on what the file asks
//    for that a page doesn't do;
//  - createRun(api, plan): runs the steps over the page's orchestrator (orchestrator.js), each at
//    its own request, one at a time, remembering how each ended.
// The page has one machine per site (runtimes.json), woken by use and never more than one of them,
// so a template names a site that is on the page (site = "python", or build = "../python": the
// directory's name), and what it says about scale, links and networks is read, not applied.
(function (root) {
  "use strict";

  // ---------------------------------------------------------------- TOML

  class TomlError extends Error {
    constructor(message, line) {
      super(line ? `line ${line}: ${message}` : message);
      this.name = "TomlError";
      this.line = line ?? null;
    }
  }

  const ESCAPES = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };

  /** The character an escape stands for, `i` being where the backslash after it ends: { ch, next }. */
  function escapeAt(s, i, line) {
    const e = s[i];
    if (e === "u" || e === "U") {
      const n = e === "u" ? 4 : 8;
      const hex = s.slice(i + 1, i + 1 + n);
      if (!new RegExp(`^[0-9a-fA-F]{${n}}$`).test(hex)) throw new TomlError("a bad \\u escape", line);
      return { ch: String.fromCodePoint(parseInt(hex, 16)), next: i + n + 1 };
    }
    if (e === "x") {
      const hex = s.slice(i + 1, i + 3);
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new TomlError("a bad \\x escape", line);
      return { ch: String.fromCodePoint(parseInt(hex, 16)), next: i + 3 };
    }
    if (e === "e") return { ch: "\x1b", next: i + 1 };
    if (e in ESCAPES) return { ch: ESCAPES[e], next: i + 1 };
    throw new TomlError(`a bad escape \\${e ?? ""}`, line);
  }

  /**
   * A string of three quotes ("""...""" with escapes, '''...''' as written), from just after its opening
   * quotes: it goes on over lines (`more()` gives the next one, or null at the end of the file). A
   * newline right after the opening quotes is dropped, and so is a backslash at the end of a line in
   * a basic string, with the white space that follows it.
   */
  function readMulti(s, quote, line, more) {
    const basic = quote === '"';
    const here = () => more.at?.() ?? line;
    const open = () => { throw new TomlError("a string that doesn't end", line); };
    let out = "";
    let text = s;
    if (text === "" && (text = more()) === null) open();
    for (let i = 0; ;) {
      if (i >= text.length) {
        out += "\n";
        if ((text = more()) === null) open();
        i = 0;
        continue;
      }
      const c = text[i];
      if (c === quote) {
        let run = 1;
        while (text[i + run] === quote) run++;
        if (run >= 3) {
          if (run > 5) throw new TomlError("too many quotes together in a string", here());
          return { value: out + quote.repeat(run - 3), rest: text.slice(i + run) };
        }
        out += quote.repeat(run);
        i += run;
      } else if (basic && c === "\\") {
        if (/^\\[ \t]*$/.test(text.slice(i))) {
          // A line-ending backslash: skip the white space and the blank lines after it
          do { if ((text = more()) === null) open(); } while (text.trim() === "");
          i = text.length - text.replace(/^[ \t]+/, "").length;
        } else {
          const e = escapeAt(text, i + 1, here());
          out += e.ch;
          i = e.next;
        }
      } else {
        out += c;
        i++;
      }
    }
  }

  /**
   * One value from the start of `s` (after its key): { value, rest }. `more()`, where a value may
   * run over lines (a multi-line string), gives the next line, or null at the end of the file.
   */
  function readValue(s, line, more) {
    s = s.replace(/^[ \t]+/, "");
    const c = s[0];
    if (c === '"') {
      if (s.startsWith('"""')) {
        if (!more) throw new TomlError("a multi-line string can't be a key", line);
        return readMulti(s.slice(3), '"', line, more);
      }
      let out = "";
      for (let i = 1; i < s.length; i++) {
        if (s[i] === '"') return { value: out, rest: s.slice(i + 1) };
        if (s[i] === "\\") {
          const e = escapeAt(s, i + 1, line);
          out += e.ch;
          i = e.next - 1;
        } else out += s[i];
      }
      throw new TomlError("a string that doesn't end", line);
    }
    if (c === "'") {
      if (s.startsWith("'''")) {
        if (!more) throw new TomlError("a multi-line string can't be a key", line);
        return readMulti(s.slice(3), "'", line, more);
      }
      const end = s.indexOf("'", 1);
      if (end < 0) throw new TomlError("a string that doesn't end", line);
      return { value: s.slice(1, end), rest: s.slice(end + 1) };
    }
    const m = /^([^\s,\]#]+)/.exec(s);
    if (!m) throw new TomlError("a value is missing", line);
    const word = m[1];
    const rest = s.slice(word.length);
    if (word === "true") return { value: true, rest };
    if (word === "false") return { value: false, rest };
    if (/^[+-]?(0|[1-9][0-9_]*)$/.test(word)) return { value: Number(word.replace(/_/g, "")), rest };
    if (/^[+-]?(0|[1-9][0-9_]*)\.[0-9_]+([eE][+-]?[0-9]+)?$/.test(word)) return { value: Number(word.replace(/_/g, "")), rest };
    throw new TomlError(`can't read the value ${word}`, line);
  }

  /** A key: bare or quoted, dotted: ["a", "b"]. Returns { path, rest }. */
  function readKey(s, line) {
    const path = [];
    let rest = s.replace(/^[ \t]+/, "");
    for (;;) {
      let part;
      if (rest[0] === '"' || rest[0] === "'") {
        const r = readValue(rest, line);
        part = r.value;
        rest = r.rest;
      } else {
        const m = /^[A-Za-z0-9_-]+/.exec(rest);
        if (!m) throw new TomlError("a key is missing", line);
        part = m[0];
        rest = rest.slice(part.length);
      }
      path.push(part);
      rest = rest.replace(/^[ \t]+/, "");
      if (rest[0] === ".") rest = rest.slice(1).replace(/^[ \t]+/, "");
      else return { path, rest };
    }
  }

  const BLOCKED = new Set(["__proto__", "constructor", "prototype"]);

  function into(obj, path, line) {
    let at = obj;
    for (const k of path) {
      if (BLOCKED.has(k)) throw new TomlError(`the key ${k} isn't allowed`, line);
      if (at[k] === undefined) at[k] = Object.create(null);
      else if (typeof at[k] !== "object" || Array.isArray(at[k])) throw new TomlError(`${path.join(".")}: ${k} is not a table`, line);
      at = at[k];
    }
    return at;
  }

  /** Strip a comment (a # outside a string) and trailing space from the end of a value's text. */
  function endOfValue(rest, line) {
    rest = rest.replace(/^[ \t]+/, "");
    if (rest && rest[0] !== "#") throw new TomlError(`unexpected ${rest.slice(0, 12)}`, line);
  }

  /**
   * The fleet file's TOML. Tables ([a.b]), key = value with strings (basic and literal), integers,
   * floats, booleans and arrays (across lines, with comments), and multi-line strings (three quotes
   * of either kind); not dates, inline tables or arrays of tables, each of which says so. Tables and
   * values have no prototype.
   */
  function parse(text) {
    const lines = String(text).replace(/^﻿/, "").split(/\r?\n/);
    const out = Object.create(null);
    let table = out;
    const seen = new Set();
    let i = 0;
    const more = () => (i + 1 < lines.length ? lines[++i] : null);
    more.at = () => i + 1; // the line it has got to, for errors inside a multi-line string
    for (; i < lines.length; i++) {
      const n = i + 1;
      let s = lines[i].replace(/^[ \t]+/, "");
      if (!s || s[0] === "#") continue;
      if (s[0] === "[") {
        if (s.startsWith("[[")) throw new TomlError("arrays of tables aren't supported", n);
        const end = /^\[([^\]]*)\]/.exec(s);
        if (!end) throw new TomlError("a table header that doesn't close", n);
        const k = readKey(end[1], n);
        endOfValue(k.rest, n);
        endOfValue(s.slice(end[0].length), n);
        const id = k.path.join("\0");
        if (seen.has(id)) throw new TomlError(`the table [${k.path.join(".")}] is there twice`, n);
        seen.add(id);
        table = into(out, k.path, n);
        continue;
      }
      const k = readKey(s, n);
      if (k.rest[0] !== "=") throw new TomlError("expected = after the key", n);
      s = k.rest.slice(1);
      let value;
      const first = s.replace(/^[ \t]+/, "");
      if (first[0] === "[") {
        // An array, across lines
        const items = [];
        let rest = first.slice(1);
        let sep = false; // a value was read and its comma has not been
        for (;;) {
          rest = rest.replace(/^[ \t]+/, "");
          if (sep && rest[0] === ",") { rest = rest.slice(1); sep = false; continue; }
          if (!rest || rest[0] === "#") {
            if ((rest = more()) === null) throw new TomlError("an array that doesn't end", n);
            continue;
          }
          if (rest[0] === "]") { rest = rest.slice(1); break; }
          if (rest[0] === "[" || rest[0] === "{") throw new TomlError("arrays of arrays and inline tables aren't supported", i + 1);
          const r = readValue(rest, i + 1, more);
          if (items.length && typeof r.value !== typeof items[0]) throw new TomlError("an array of one kind of value", i + 1);
          items.push(r.value);
          sep = true;
          rest = r.rest.replace(/^[ \t]+/, "");
          if (rest[0] === ",") { rest = rest.slice(1); sep = false; }
          else if (rest[0] !== "]" && rest[0] !== "#" && rest) throw new TomlError("expected , or ] in the array", i + 1);
        }
        endOfValue(rest, i + 1);
        value = items;
      } else if (first[0] === "{") {
        throw new TomlError("inline tables aren't supported: use a [table]", n);
      } else {
        const r = readValue(first, n, more);
        endOfValue(r.rest, i + 1);
        value = r.value;
      }
      const parent = into(table, k.path.slice(0, -1), n);
      const last = k.path[k.path.length - 1];
      if (BLOCKED.has(last)) throw new TomlError(`the key ${last} isn't allowed`, n);
      if (last in parent) throw new TomlError(`${k.path.join(".")} is set twice`, n);
      parent[last] = value;
    }
    return out;
  }

  // ---------------------------------------------------------------- highlight

  /** The parts of a string's text that mean something to a shell: [class|null, text] pairs. */
  function shellBits(t) {
    const out = [];
    const re = /(^[ \t]*#.*$)|(\$\{[^}\n]*\}|\$[A-Za-z_][A-Za-z0-9_]*|\$[?$!@#*0-9]|\$\()/g;
    let at = 0;
    for (let m; (m = re.exec(t));) {
      if (m.index > at) out.push(["str", t.slice(at, m.index)]);
      out.push([m[1] ? "cmt" : "var", m[0]]);
      at = m.index + m[0].length;
    }
    if (at < t.length) out.push(["str", t.slice(at)]);
    return out;
  }

  /**
   * A fleet file coloured, as [class, text] pairs that put end to end give the text back exactly:
   * cmt (a comment), tbl (a table header), key, str (a string, with the shell's $variables and #
   * comment lines inside a multi-line one picked out as var and cmt), num, bool, pun. A class of
   * null is plain. It colours what it sees and refuses nothing (the parser says what is wrong).
   */
  function highlight(text) {
    const out = [];
    const push = (cls, t) => { if (t) out.push([cls, t]); };
    let multi = null; // the quote of a multi-line string that is open
    const TRIPLE = ['"""', "'''"];
    /** The rest of a line of a multi-line string, from `i`: where it ends. */
    const inMulti = (line, i) => {
      let j = i;
      for (; j < line.length; j++) {
        if (multi === '"' && line[j] === "\\") { j++; continue; }
        if (line[j] === multi && line[j + 1] === multi && line[j + 2] === multi) break;
      }
      j = Math.min(j, line.length);
      for (const [c, t] of shellBits(line.slice(i, j))) push(c, t);
      if (j >= line.length) return line.length;
      let run = 3;
      while (run < 5 && line[j + run] === multi) run++;
      push("str", line.slice(j, j + run));
      multi = null;
      return j + run;
    };
    String(text).split("\n").forEach((line, n) => {
      if (n) push(null, "\n");
      let i = 0;
      if (multi) i = inMulti(line, 0);
      while (i < line.length) {
        const rest = line.slice(i);
        const atStart = /^\s*$/.test(line.slice(0, i));
        let m;
        if ((m = /^[ \t]+/.exec(rest))) { push(null, m[0]); i += m[0].length; continue; }
        if (rest[0] === "#") { push("cmt", rest); break; }
        if (atStart && (m = /^\[\[?[^\]\n]*\]\]?/.exec(rest))) { push("tbl", m[0]); i += m[0].length; continue; }
        if (atStart && (m = /^(?:[A-Za-z0-9_-]+|"[^"\n]*"|'[^'\n]*')(?:[ \t]*\.[ \t]*(?:[A-Za-z0-9_-]+|"[^"\n]*"|'[^'\n]*'))*(?=[ \t]*=)/.exec(rest))) {
          push("key", m[0]); i += m[0].length; continue;
        }
        if (TRIPLE.some((q) => rest.startsWith(q))) {
          multi = rest[0];
          push("str", rest.slice(0, 3));
          i = inMulti(line, i + 3);
          continue;
        }
        if (rest[0] === '"') {
          let j = 1;
          while (j < rest.length && rest[j] !== '"') j += rest[j] === "\\" ? 2 : 1;
          const e = Math.min(j + 1, rest.length);
          push("str", rest.slice(0, e));
          i += e;
          continue;
        }
        if (rest[0] === "'") {
          const j = rest.indexOf("'", 1);
          const e = j < 0 ? rest.length : j + 1;
          push("str", rest.slice(0, e));
          i += e;
          continue;
        }
        if ((m = /^(?:true|false)(?![A-Za-z0-9_])/.exec(rest))) { push("bool", m[0]); i += m[0].length; continue; }
        if ((m = /^[+-]?[0-9][0-9_]*(?:\.[0-9_]+)?(?:[eE][+-]?[0-9]+)?/.exec(rest))) { push("num", m[0]); i += m[0].length; continue; }
        if ("[],=".includes(rest[0])) { push("pun", rest[0]); i++; continue; }
        push(null, rest[0]);
        i++;
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- the graph

  /**
   * What a plan joins, as a graph: a node for each machine of the page the fleet uses (`names`: what
   * the file calls the machines on it, `services`: the ports it opens in the frame), an edge for each
   * link (from the machine that reaches to the one reached, labelled by the name and port it reaches it as).
   * `rank` is a node's column (the longest chain of links that leads to it) and `row` its place in it.
   */
  function graph(thePlan) {
    const nodes = new Map();
    const node = (runtime) => {
      if (!nodes.has(runtime)) nodes.set(runtime, { id: runtime, runtime, names: [], services: [], rank: 0, row: 0 });
      return nodes.get(runtime);
    };
    for (const s of thePlan.steps) {
      if (!s.runtime) continue;
      const n = node(s.runtime);
      if (s.kind === "link") node(s.to);
      else if (s.kind === "machine") n.names.push(s.name);
      else if (s.kind === "service") n.services.push({ name: s.name, port: s.port });
    }
    const edges = thePlan.links.map((l) => ({ from: l.from, to: l.to, port: l.port, label: l.asPort && l.asPort !== l.port ? `${l.as}:${l.asPort} → :${l.port}` : `${l.as}:${l.port}` }));
    for (const e of edges) { node(e.from); node(e.to); }
    // Longest chain first, capped so a cycle can't run away
    for (let pass = 0; pass < nodes.size; pass++) {
      let moved = false;
      for (const e of edges) {
        const to = nodes.get(e.to);
        const rank = Math.min(nodes.get(e.from).rank + 1, nodes.size - 1);
        if (e.from !== e.to && to.rank < rank) { to.rank = rank; moved = true; }
      }
      if (!moved) break;
    }
    const rows = new Map();
    for (const n of nodes.values()) {
      n.row = rows.get(n.rank) ?? 0;
      rows.set(n.rank, n.row + 1);
    }
    return { nodes: [...nodes.values()], edges };
  }

  // ---------------------------------------------------------------- the plan

  const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

  /** "30m", "2m30s", "90s", "1h", "250ms": milliseconds, or null if it isn't one. */
  function duration(s) {
    if (typeof s !== "string") return null;
    const re = /(\d+(?:\.\d+)?)(ms|s|m|h)/g;
    const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 };
    let total = 0;
    let used = 0;
    for (let m; (m = re.exec(s));) {
      total += Number(m[1]) * unit[m[2]];
      used += m[0].length;
    }
    return used && used === s.length ? total : null;
  }

  /** The site a template's `site` or `build` path names: its last directory ("../python/" is python). */
  function siteOf(path) {
    const parts = String(path).split(/[\\/]+/).filter((p) => p && p !== "." && p !== "..");
    return parts.length ? parts[parts.length - 1] : null;
  }

  /** The guest port of "8080:8000", "8000", or "127.0.0.1:8080:8000"; null if it isn't one. */
  function guestPort(spec) {
    const m = /^(?:[^:]+:)?(?:\d+:)?(\d+)(?:\/tcp)?$/.exec(String(spec).trim());
    const p = m ? Number(m[1]) : NaN;
    return p >= 1 && p <= 65535 ? p : null;
  }

  // Every key the native fleet format takes (internal/fleet/fleet.go), by what this page does with it:
  // `applied` is acted on (or decided by the site, as a template's network), `said` is read and listed
  // as not applied here. fleet.test.cjs checks both lists against the Go structs, so a key added to the
  // format has to be decided here too, and a file the CLI refuses is refused here.
  const KEYS = {
    templates: { applied: ["site", "build", "snapshot", "network"], said: ["idle", "max_machines", "allow_private", "egress", "expose"] },
    snapshots: { applied: ["template", "run", "ready", "timeout"], said: [] },
    services: { applied: ["template", "ports"], said: ["min", "max", "idle", "concurrency", "state", "labels"] },
    machines: { applied: ["template"], said: ["count", "ports", "ttl", "labels"] },
    links: { applied: ["from", "to", "port", "as", "as_port"], said: [] },
  };
  const TOP = ["name", "templates", "snapshots", "services", "machines", "links", "network"];
  // Said one by one elsewhere in plan(); the rest of `said` is said here
  const SAID_ELSEWHERE = new Set(["services.min", "services.max", "services.idle", "services.concurrency", "machines.ttl", "templates.egress"]);

  const tables = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : []);
  const isTable = (v) => v && typeof v === "object" && !Array.isArray(v);

  /**
   * What the page does with a fleet file, against the machines it has (runtimes: runtimes.json's
   * list). { name, steps, problems, notes }: each step { key, kind: "snapshot" | "service" |
   * "machine", name, runtime, needs: [step keys], summary, ... what it runs }. A problem is
   * something the file says that can't be done here (a template of a site the page doesn't have):
   * the steps that need it are left out, the rest remain. A note is something the file asks for
   * that a page doesn't do (links, scale to zero): said, not applied.
   */
  function plan(file, runtimes) {
    const problems = [];
    const notes = [];
    const steps = [];
    const have = new Map((runtimes ?? []).map((r) => [r.name, r]));
    const bad = (where, msg) => problems.push({ where, message: msg });

    // The CLI refuses a file with a key it doesn't know: so does this page, whatever else it does with it
    for (const k of Object.keys(file)) if (!TOP.includes(k)) bad(k, "unknown key");
    if (isTable(file.network)) for (const k of Object.keys(file.network)) if (k !== "mode") bad(`network.${k}`, "unknown key");
    for (const [kind, { applied, said }] of Object.entries(KEYS)) {
      for (const [name, spec] of tables(file[kind])) {
        if (!isTable(spec)) continue;
        for (const k of Object.keys(spec)) if (!applied.includes(k) && !said.includes(k)) bad(`${kind}.${name}`, `unknown key ${k}`);
      }
    }

    const templates = new Map();
    for (const [name, t] of tables(file.templates)) {
      if (!NAME.test(name)) { bad(`templates.${name}`, "a name is letters, digits, . _ or -"); continue; }
      templates.set(name, t);
    }
    const snapshots = new Map();
    for (const [name, s] of tables(file.snapshots)) {
      if (!NAME.test(name)) { bad(`snapshots.${name}`, "a name is letters, digits, . _ or -"); continue; }
      snapshots.set(name, s);
    }

    // A template's site on the page, and the snapshot that readies it (if its own, or a template's it is of)
    const resolved = new Map();
    function resolve(name, via = []) {
      if (resolved.has(name)) return resolved.get(name);
      const t = templates.get(name);
      if (!t) return { error: `no template ${name}` };
      if (via.includes(name)) return { error: `templates ${[...via, name].join(" → ")} go round in a circle` };
      let r;
      if (typeof t.snapshot === "string" && t.snapshot) {
        const s = snapshots.get(t.snapshot);
        if (!s) r = { error: `no snapshot ${t.snapshot}` };
        else if (typeof s.template !== "string" || !s.template) r = { error: `snapshot ${t.snapshot} names no template` };
        else {
          const base = resolve(s.template, [...via, name]);
          r = base.error ? base : { runtime: base.runtime, snapshot: t.snapshot, network: base.network };
        }
      } else if (typeof t.site === "string" && t.site || typeof t.build === "string" && t.build) {
        const runtime = siteOf(t.site || t.build);
        const rt = runtime && have.get(runtime);
        r = rt ? { runtime, snapshot: null, network: rt.network === "fetch" }
          : { error: `the page has no machine ${runtime ? `"${runtime}"` : "for " + JSON.stringify(t.site || t.build)} (it has ${[...have.keys()].join(", ") || "none"})` };
      } else r = { error: "it has no site, build or snapshot" };
      resolved.set(name, r);
      return r;
    }

    const snapshotKey = (n) => `snapshot/${n}`;
    const okSnapshots = new Set();
    for (const [name, s] of snapshots) {
      const where = `snapshots.${name}`;
      const r = typeof s.template === "string" ? resolve(s.template) : { error: "it names no template" };
      if (r.error) { bad(where, r.error); continue; }
      if (r.snapshot) { bad(where, `its template ${s.template} is itself a snapshot's; the page can't stack them`); continue; }
      if (s.run !== undefined && !Array.isArray(s.run)) { bad(where, "run: an array of commands (run = [...]), even for one"); continue; }
      const run = s.run ?? [];
      if (run.some((c) => typeof c !== "string" || !c.trim())) { bad(where, "run: commands, each a string"); continue; }
      if (s.ready !== undefined && (typeof s.ready !== "string" || !s.ready.trim())) { bad(where, "ready: a command, as a string"); continue; }
      let timeout = 120000;
      if (s.timeout !== undefined) {
        timeout = duration(s.timeout);
        if (!timeout) { bad(where, `timeout: a duration like "2m", not ${JSON.stringify(s.timeout)}`); continue; }
      }
      okSnapshots.add(name);
      steps.push({
        key: snapshotKey(name), kind: "snapshot", name, runtime: r.runtime, needs: [], run, ready: s.ready ?? null, timeoutMs: timeout,
        summary: `Set up ${r.runtime}: ${run.length} command${run.length === 1 ? "" : "s"}${s.ready ? ", then wait until it is ready" : ""}`,
      });
    }

    // What a template's snapshot step is, as a dependency: none if it has none, or the step that makes it
    const snapshotNeed = (r, where) => {
      if (!r.snapshot) return [];
      if (!okSnapshots.has(r.snapshot)) { bad(where, `its snapshot ${r.snapshot} can't be set up here`); return null; }
      return [snapshotKey(r.snapshot)];
    };

    // Links: the machine of `from` reaches `as` (db.internal) as the server of `to`'s machine, through
    // the page. One step sets them all: a machine that connects waits for the links it is `from` of
    const linkKeys = new Map(); // runtime: the link steps its machine connects through
    const linkList = [];
    for (const [name, l] of tables(file.links)) {
      const where = `links.${name}`;
      if (!NAME.test(name)) { bad(where, "a name is letters, digits, . _ or -"); continue; }
      const from = typeof l.from === "string" ? resolve(l.from) : { error: "from: a template" };
      const to = typeof l.to === "string" ? resolve(l.to) : { error: "to: a template" };
      if (from.error || to.error) { bad(where, from.error ?? to.error); continue; }
      if (from.runtime === to.runtime) { bad(where, `both ends are the ${from.runtime} machine: a machine can't link to itself, and a site is one machine on the page`); continue; }
      if (!Number.isInteger(l.port) || l.port < 1 || l.port > 65535) { bad(where, "port: the target's port, 1 to 65535"); continue; }
      if (l.as_port !== undefined && (!Number.isInteger(l.as_port) || l.as_port < 1 || l.as_port > 65535)) { bad(where, "as_port: the port the guest connects to, 1 to 65535"); continue; }
      const as = l.as === undefined ? `${l.to}.internal`.toLowerCase() : l.as;
      if (typeof as !== "string" || !/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/.test(as) || /^[0-9.]+$/.test(as)) { bad(where, `as: a host name like db.internal, not ${JSON.stringify(as)}`); continue; }
      if (!from.network || !to.network) { bad(where, `${!from.network ? from.runtime : to.runtime} has no network device on the page, so it can't take part in a link`); continue; }
      const needs = [...snapshotNeed(from, where) ?? [null], ...snapshotNeed(to, where) ?? [null]];
      if (needs.includes(null)) continue;
      const key = `link/${name}`;
      linkList.push({ from: from.runtime, to: to.runtime, port: l.port, as, ...(l.as_port !== undefined ? { as_port: l.as_port } : {}) });
      linkKeys.set(from.runtime, [...(linkKeys.get(from.runtime) ?? []), key]);
      steps.push({
        key, kind: "link", name, runtime: from.runtime, to: to.runtime, port: l.port, as, asPort: l.as_port ?? null, needs: [...new Set(needs)],
        summary: `${from.runtime} reaches ${to.runtime}'s port ${l.port} as ${as}${l.as_port !== undefined ? `:${l.as_port}` : ""}`,
      });
      // The guest's port 80 and 443 are HTTP and HTTPS in the machine itself: those reach the target as HTTP
      // requests, never as a raw TCP stream; any other port is raw TCP
      const guestPort = l.as_port ?? l.port;
      if (guestPort === 80 || guestPort === 443) notes.push(`links.${name}: ${as}:${guestPort} is carried as HTTP${guestPort === 443 ? "S" : ""} requests, not raw TCP: use as_port for another port to connect raw`);
    }
    // What a machine's step waits for: its snapshot's setup, and the links it connects through
    const needsOf = (r, where) => {
      const snap = snapshotNeed(r, where);
      return snap && [...snap, ...(linkKeys.get(r.runtime) ?? [])];
    };

    for (const [name, sv] of tables(file.services)) {
      const where = `services.${name}`;
      if (!NAME.test(name)) { bad(where, "a name is letters, digits, . _ or -"); continue; }
      const r = typeof sv.template === "string" ? resolve(sv.template) : { error: "it names no template" };
      if (r.error) { bad(where, r.error); continue; }
      const ports = sv.ports === undefined ? [] : Array.isArray(sv.ports) ? sv.ports : [sv.ports];
      const guest = ports.map(guestPort);
      if (guest.some((p) => p === null)) { bad(where, `ports: "host:guest" like "8080:8000", not ${JSON.stringify(ports[guest.indexOf(null)])}`); continue; }
      if (!guest.length) { bad(where, "it has no ports to open"); continue; }
      if (!r.network) { bad(where, `${r.runtime} has no network device on the page, so its servers can't be reached`); continue; }
      const needs = needsOf(r, where);
      if (!needs) continue;
      steps.push({
        key: `service/${name}`, kind: "service", name, runtime: r.runtime, needs, ports: guest, port: guest[0],
        summary: `Open ${r.runtime}'s port ${guest[0]}`,
      });
      const scale = ["min", "max", "idle", "concurrency"].filter((k) => sv[k] !== undefined);
      if (scale.length) notes.push(`services.${name}: ${scale.join(", ")} don't apply: the page keeps one machine per site, woken by use and put to sleep when others need the room`);
      if (guest.length > 1) notes.push(`services.${name}: only its first port (${guest[0]}) is opened`);
      if (ports.some((p) => /^(?:[^:]+:)?\d+:\d+/.test(String(p)))) notes.push(`services.${name}: the host port is not opened: the page shows it in a frame instead`);
    }

    for (const [name, m] of tables(file.machines)) {
      const where = `machines.${name}`;
      if (!NAME.test(name)) { bad(where, "a name is letters, digits, . _ or -"); continue; }
      const r = typeof m.template === "string" ? resolve(m.template) : { error: "it names no template" };
      if (r.error) { bad(where, r.error); continue; }
      const needs = needsOf(r, where);
      if (!needs) continue;
      steps.push({ key: `machine/${name}`, kind: "machine", name, runtime: r.runtime, needs, summary: `Wake ${r.runtime}` });
      if (m.ttl !== undefined) notes.push(`machines.${name}: ttl doesn't apply: the page's machine is kept until you clear its save`);
    }

    if (isTable(file.network) && file.network.mode && file.network.mode !== "exclusive") notes.push(`network.mode ${file.network.mode}: not applied: the page runs one instance`);
    for (const [name, t] of templates) {
      if (t.egress && t.egress !== "none") notes.push(`templates.${name}: egress ${t.egress}: a machine's network is what its site was built with`);
    }

    // Machines the steps share: one site is one machine on the page
    const byRuntime = new Map();
    for (const s of steps) byRuntime.set(s.runtime, [...(byRuntime.get(s.runtime) ?? []), `${s.kind} ${s.name}`]);
    for (const [rt, who] of byRuntime) {
      if (who.length > 1) notes.push(`${who.join(", ")} all run in ${rt}: one site is one machine on the page, so they share its files and processes`);
    }

    // Keys of the format this page reads and does nothing with (the ones above are said where they matter)
    for (const [kind, { said }] of Object.entries(KEYS)) {
      for (const [name, spec] of tables(file[kind])) {
        if (!isTable(spec)) continue;
        const rest = said.filter((k) => spec[k] !== undefined && !SAID_ELSEWHERE.has(`${kind}.${k}`));
        if (rest.length) notes.push(`${kind}.${name}: ${rest.join(", ")} ${rest.length === 1 ? "isn't" : "aren't"} applied`);
      }
    }

    const order = { snapshot: 0, link: 1, machine: 2, service: 3 };
    steps.sort((a, b) => order[a.kind] - order[b.kind]);
    return { name: typeof file.name === "string" && file.name ? file.name : "fleet", steps, links: linkList, problems, notes };
  }

  // ---------------------------------------------------------------- running it

  /**
   * Runs a plan's steps over the page's orchestrator (`api`: runCommand, readJob, openPreview,
   * wake). state(key) is { status: "pending" | "running" | "done" | "failed", detail, output,
   * error }; a step runs only once what it needs is done, one step at a time. `onchange` is told of
   * every change; `sleep` and `now` are the clock (tests give theirs).
   */
  function createRun(api, thePlan, { onchange, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollMs = 500 } = {}) {
    const states = new Map(thePlan.steps.map((s) => [s.key, { status: "pending", detail: null, output: "", error: null }]));
    const byKey = new Map(thePlan.steps.map((s) => [s.key, s]));
    let chain = Promise.resolve();
    let stopping = false; // stop() is waiting for what runs to end
    const changed = () => { try { onchange?.(); } catch {} };
    const set = (key, patch) => { Object.assign(states.get(key), patch); changed(); };

    /** A command in a machine run to its end: { exit, output }. */
    async function exec(runtime, command, timeoutSeconds) {
      const { jobId } = await api.runCommand({ runtime, command, timeoutSeconds }, { source: "fleet" });
      for (;;) {
        if (stopping) {
          try { await api.cancelJob?.(jobId); } catch {}
          throw new Error("stopped");
        }
        const v = await api.readJob(jobId);
        if (v.state !== "running") return { exit: v.state === "exited" ? v.exitStatus : null, output: v.output ?? "", state: v.state, error: v.error ?? null };
        await sleep(pollMs);
      }
    }

    const tail = (s) => String(s).trim().split("\n").slice(-12).join("\n");

    async function execute(step) {
      if (step.kind === "snapshot") {
        let log = "";
        for (const [i, command] of step.run.entries()) {
          set(step.key, { detail: `command ${i + 1} of ${step.run.length}` });
          const r = await exec(step.runtime, command, Math.ceil(step.timeoutMs / 1000));
          log += `$ ${command}\n${r.output}`;
          if (r.exit !== 0) {
            set(step.key, { output: tail(log) });
            throw new Error(`command ${i + 1} ${r.exit === null ? `ended ${r.state}${r.error ? ` (${r.error})` : ""}` : `exited ${r.exit}`}`);
          }
        }
        if (step.ready) {
          const until = now() + step.timeoutMs;
          for (let tries = 1;; tries++) {
            set(step.key, { detail: `waiting until it is ready (try ${tries})`, output: tail(log) });
            const r = await exec(step.runtime, step.ready, 10);
            if (r.exit === 0) break;
            if (stopping) throw new Error("stopped");
            if (now() >= until) throw new Error(`not ready after ${Math.round(step.timeoutMs / 1000)}s`);
            await sleep(1000);
          }
        }
        return { detail: step.run.length || step.ready ? "set up" : "nothing to run", output: tail(log) };
      }
      if (step.kind === "link") {
        // All the plan's links at once; a machine that was awake with other names is woken again
        // by its next use, so it reads these
        const suspended = await api.setLinks(thePlan.links);
        return { detail: `${step.as}${step.asPort ? `:${step.asPort}` : ""} → ${step.to}:${step.port}${suspended.length ? ` (${suspended.join(", ")} suspended, to read it)` : ""}` };
      }
      if (step.kind === "service") {
        const r = await api.openPreview({ runtime: step.runtime, port: step.port, path: "/" }, { source: "fleet" });
        if (r.error) throw new Error(`the preview is open, but its first request failed: ${r.error}`);
        return { detail: `port ${step.port} answered ${r.status}`, url: r.url ?? null };
      }
      await api.wake(step.runtime);
      return { detail: "awake" };
    }

    async function runStep(key) {
      const step = byKey.get(key);
      if (!step) throw new Error(`no step ${key}`);
      for (const need of step.needs) {
        if (states.get(need).status !== "done") throw new Error(`${key} needs ${need} first`);
      }
      const run = chain.then(async () => {
        if (stopping || states.get(key).status === "running") return;
        set(key, { status: "running", detail: null, error: null, output: "", startedAt: now() });
        try {
          set(key, { status: "done", ...(await execute(step)) });
        } catch (e) {
          // A step that stop() ended goes back to pending, not failed
          if (stopping) set(key, { status: "pending", detail: null, error: null, output: "" });
          else set(key, { status: "failed", error: String(e?.message ?? e) });
        }
      });
      chain = run.catch(() => {});
      await run;
      return states.get(key);
    }

    /** Every step, in order, each once what it needs is done; stops at the first that fails. */
    async function runAll() {
      for (const step of thePlan.steps) {
        if (states.get(step.key).status === "done") continue;
        if (stopping) return false;
        const r = await runStep(step.key);
        if (r.status !== "done") return false;
      }
      return !stopping;
    }

    /**
     * Ends what the fleet is doing and undoes it: the step that runs is cancelled, the service's
     * preview is closed, the links are cleared, and each machine the fleet uses goes back to its
     * image (what it did is forgotten), so every step is pending again. A machine that can't go back
     * (it is busy) is named in `problems`; the rest are done.
     */
    async function stop({ also = [] } = {}) {
      stopping = true;
      const problems = [];
      try {
        await chain;
        try { await api.closePreview?.({ source: "fleet" }); } catch (e) { problems.push(String(e?.message ?? e)); }
        try { await api.setLinks?.([]); } catch (e) { problems.push(String(e?.message ?? e)); }
        for (const runtime of new Set([...thePlan.steps.map((st) => st.runtime).filter(Boolean), ...also])) {
          try {
            // A machine still closing its connections is busy for a moment
            for (let tries = 0; ; tries++) {
              try {
                if (await api.startFresh(runtime) === false) problems.push(`${runtime}: not reset (it was not confirmed)`);
                break;
              } catch (e) {
                if (tries >= 10 || !/busy/.test(String(e?.message))) throw e;
                await sleep(300);
              }
            }
          } catch (e) { problems.push(`${runtime}: ${String(e?.message ?? e)}`); }
        }
        for (const st of states.values()) Object.assign(st, { status: "pending", detail: null, output: "", error: null, url: undefined });
      } finally {
        stopping = false;
        changed();
      }
      return { problems };
    }

    return { state: (key) => states.get(key), runStep, runAll, stop, steps: thePlan.steps };
  }

  const SnowglobeFleet = { parse, plan, createRun, highlight, graph, duration, siteOf, guestPort, TomlError, KEYS, TOP };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeFleet;
  else root.SnowglobeFleet = SnowglobeFleet;
})(typeof window !== "undefined" ? window : globalThis);
