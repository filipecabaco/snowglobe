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
    const m = /^([^\s,\]}#]+)/.exec(s);
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

  /**
   * An inline table from the start of `s`, `{ key = value, ... }`: { value, rest }. Its keys are
   * plain and its values are strings, numbers or booleans (a multi-line string runs on over lines,
   * as TOML allows); not arrays or tables inside it.
   */
  function readInlineTable(s, line, more) {
    const out = Object.create(null);
    const at = () => more?.at?.() ?? line;
    let rest = s.slice(1).replace(/^[ \t]+/, "");
    if (rest[0] === "}") return { value: out, rest: rest.slice(1) };
    for (;;) {
      const k = readKey(rest, at());
      if (k.path.length !== 1) throw new TomlError("a dotted key in an inline table isn't supported", at());
      if (k.rest[0] !== "=") throw new TomlError("expected = after the key", at());
      const key = k.path[0];
      if (BLOCKED.has(key)) throw new TomlError(`the key ${key} isn't allowed`, at());
      if (key in out) throw new TomlError(`${key} is set twice in the inline table`, at());
      const v = k.rest.slice(1).replace(/^[ \t]+/, "");
      if (v[0] === "[" || v[0] === "{") throw new TomlError("arrays and tables inside an inline table aren't supported", at());
      const r = readValue(v, at(), more);
      out[key] = r.value;
      rest = r.rest.replace(/^[ \t]+/, "");
      if (rest[0] === ",") { rest = rest.slice(1).replace(/^[ \t]+/, ""); continue; }
      if (rest[0] === "}") return { value: out, rest: rest.slice(1) };
      throw new TomlError("expected , or } in the inline table", at());
    }
  }

  /** The kind of value an array holds: strings and inline tables may share one (a command, or a command with options). */
  const kindOf = (v) => (typeof v === "string" || (v && typeof v === "object" && !Array.isArray(v)) ? "string-or-table" : typeof v);

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
   * of either kind), and inline tables inside an array (a command with options); not dates, inline
   * tables as values or arrays of tables, each of which says so. Tables and
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
          if (rest[0] === "[") throw new TomlError("arrays of arrays aren't supported", i + 1);
          const r = rest[0] === "{" ? readInlineTable(rest, i + 1, more) : readValue(rest, i + 1, more);
          if (items.length && kindOf(r.value) !== kindOf(items[0])) throw new TomlError("an array of one kind of value", i + 1);
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

  /** A snapshot command's time when neither it nor its snapshot says (fleet.CommandTimeout), and how long ready is retried. */
  const COMMAND_TIMEOUT_MS = 10 * 60000;
  const READY_TIMEOUT_MS = 2 * 60000;

  /** Milliseconds as a duration is written in the file, as Go writes one: 90000 is "1m30s". */
  function spoken(ms) {
    if (ms < 1000) return `${ms}ms`;
    const s = Math.round(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    return `${h ? `${h}h` : ""}${h || m ? `${m}m` : ""}${s % 60}s`;
  }

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
    templates: { applied: ["site", "build", "snapshot", "network", "health", "start"], said: ["idle", "max_machines", "allow_private", "egress", "expose"] },
    snapshots: { applied: ["template", "run", "ready", "timeout"], said: [] },
    services: { applied: ["template", "ports", "health"], said: ["min", "max", "idle", "concurrency", "state", "labels"] },
    machines: { applied: ["template", "health"], said: ["count", "ports", "ttl", "labels"] },
    links: { applied: ["from", "to", "port", "as", "as_port"], said: [] },
    supervisors: { applied: ["strategy", "children", "max_restarts", "max_seconds", "restart"], said: ["labels"] },
  };
  const TOP = ["name", "templates", "snapshots", "services", "machines", "links", "supervisors", "network"];
  // Said one by one elsewhere in plan(); the rest of `said` is said here
  const SAID_ELSEWHERE = new Set(["services.min", "services.max", "services.idle", "services.concurrency", "machines.ttl", "templates.egress"]);

  const tables = (v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : []);
  const isTable = (v) => v && typeof v === "object" && !Array.isArray(v);

  // A health check's keys (fleet.HealthSpec, fleet.HTTPSpec): fleet.test.cjs checks them against Go
  const HEALTH_KEYS = ["http", "cmd", "interval", "timeout", "failures", "grace", "heal", "heal_cmd", "drain", "wait_ready"];
  const HTTP_KEYS = ["port", "path", "status"];
  // Heals in a row with no check passing before healing stops (daemon maxHeals), and the longest wait between two
  const MAX_HEALS = 5;
  const MAX_HEAL_BACKOFF_MS = 5 * 60000;
  const RESTART_TYPES = ["permanent", "transient", "temporary"];
  const STRATEGIES = ["one_for_one", "one_for_all", "rest_for_one"];

  /** "200-399" or "200,204": [[lo, hi], ...], or null if it isn't one (daemon parseStatus). */
  function statusRanges(spec) {
    const out = [];
    for (const part of String(spec).split(",")) {
      const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(part);
      const a = m ? Number(m[1]) : NaN, b = m?.[2] !== undefined ? Number(m[2]) : a;
      if (!m || a < 100 || b > 599 || a > b) return null;
      out.push([a, b]);
    }
    return out;
  }

  /** A start command's time when it gives none (daemon.DefaultStartTimeout). */
  const START_TIMEOUT_MS = 2 * 60 * 1000;

  /**
   * A template's start commands (fleet.TemplateSpec.Start): each a string or { cmd, timeout }.
   * { commands: [{ cmd, timeoutMs }] } or { error }.
   */
  function startCommands(list) {
    if (!Array.isArray(list)) return { error: "start: an array of commands (start = [...]), even for one" };
    const commands = [];
    for (const [i, c] of list.entries()) {
      const table = c && typeof c === "object";
      const cmd = table ? c.cmd : c;
      if (typeof cmd !== "string" || !cmd.trim()) return { error: `start[${i}]: a command, as a string or { cmd, timeout }` };
      const extra = table ? Object.keys(c).filter((k) => k !== "cmd" && k !== "timeout") : [];
      if (extra.length) return { error: `start[${i}]: unknown key ${extra[0]} (a command is cmd and timeout)` };
      let timeoutMs = START_TIMEOUT_MS;
      if (table && c.timeout !== undefined) {
        timeoutMs = duration(c.timeout);
        if (!timeoutMs) return { error: `start[${i}]: timeout: a duration like "30s", not ${JSON.stringify(c.timeout)}` };
      }
      commands.push({ cmd, timeoutMs });
    }
    return { commands };
  }

  /**
   * A health check as the daemon keeps it (daemon.NormalHealth), its defaults filled in: { health }
   * or { error }. A machine's heals by none (its default) or hook; a service's and a template's also
   * by drain or replace (the default).
   */
  function normalHealth(kind, h) {
    if (!isTable(h)) return { error: "health: a table ([...health])" };
    for (const k of Object.keys(h)) if (!HEALTH_KEYS.includes(k)) return { error: `health: unknown key ${k}` };
    if (h.http !== undefined) {
      if (!isTable(h.http)) return { error: "health: http: a table (port, path, status)" };
      for (const k of Object.keys(h.http)) if (!HTTP_KEYS.includes(k)) return { error: `health: http: unknown key ${k}` };
    }
    const hasCmd = typeof h.cmd === "string" && h.cmd !== "";
    if (h.cmd !== undefined && typeof h.cmd !== "string") return { error: "health: cmd: a command, as a string" };
    if ((h.http === undefined) === !hasCmd) return { error: "health: one of http or cmd" };
    let http = null;
    if (h.http) {
      const { port, path = "/", status = "200-399" } = h.http;
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `health: http port ${JSON.stringify(port)}: 1 to 65535` };
      if (typeof path !== "string" || !path.startsWith("/")) return { error: `health: http path ${JSON.stringify(path)}: starts with /` };
      const ranges = typeof status === "string" ? statusRanges(status) : null;
      if (!ranges) return { error: `health: http status ${JSON.stringify(status)}: codes (100 to 599) or ranges of them, like 200-399` };
      http = { port, path: path || "/", status, ranges };
    }
    const dur = (k, dflt) => {
      if (h[k] === undefined || h[k] === "") return dflt;
      const ms = duration(h[k]);
      return ms === null ? NaN : ms;
    };
    const intervalMs = dur("interval", 10000);
    if (Number.isNaN(intervalMs)) return { error: `health: interval: a duration like "10s", not ${JSON.stringify(h.interval)}` };
    if (intervalMs < 1000) return { error: `health: interval ${h.interval}: 1s or more` };
    const timeoutMs = dur("timeout", Math.min(2000, intervalMs));
    if (Number.isNaN(timeoutMs) || timeoutMs <= 0 || timeoutMs > intervalMs) return { error: `health: timeout ${JSON.stringify(h.timeout)}: more than 0 and at most the interval (${spoken(intervalMs)})` };
    if (h.failures !== undefined && (!Number.isInteger(h.failures) || h.failures < 0)) return { error: "health: failures: 1 or more" };
    const graceMs = dur("grace", 30000);
    if (Number.isNaN(graceMs)) return { error: `health: grace: a duration like "30s", not ${JSON.stringify(h.grace)}` };
    const drainMs = dur("drain", 30000);
    if (Number.isNaN(drainMs)) return { error: `health: drain: a duration like "30s", not ${JSON.stringify(h.drain)}` };
    let heal = h.heal ?? "";
    if (heal === "") heal = kind === "machine" ? "none" : "replace";
    if (kind === "machine" && (heal === "drain" || heal === "replace")) return { error: `health: heal ${heal}: a machine heals by none or hook; put it under a supervisor to have it restarted` };
    if (!["none", "drain", "hook", "replace"].includes(heal)) return { error: `health: heal ${JSON.stringify(heal)}: none, drain, hook or replace` };
    if (heal === "hook" && (typeof h.heal_cmd !== "string" || !h.heal_cmd)) return { error: "health: heal hook: needs heal_cmd, the command it runs" };
    if (h.wait_ready !== undefined && typeof h.wait_ready !== "boolean") return { error: "health: wait_ready: true or false" };
    return {
      health: {
        http, cmd: hasCmd ? h.cmd : null, intervalMs, timeoutMs, failures: h.failures || 3, graceMs, heal,
        healCmd: heal === "hook" ? h.heal_cmd : null, drainMs, waitReady: h.wait_ready === true,
      },
    };
  }

  /** What a health check is, in a few words: "GET :8000/healthz (200-399) every 10s" or "`pg_isready` every 5s". */
  function describeHealth(h) {
    return `${h.http ? `GET :${h.http.port}${h.http.path} (${h.http.status})` : `\`${h.cmd}\``} every ${spoken(h.intervalMs)}`;
  }

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
    const templateHealth = new Map(); // a template's health check, its services' and machines' when they have none
    const templateStart = new Map(); // a template's start commands, run in its machine before its service or machine step
    for (const [name, t] of tables(file.templates)) {
      if (!NAME.test(name)) { bad(`templates.${name}`, "a name is letters, digits, . _ or -"); continue; }
      if (isTable(t) && t.health !== undefined) {
        const h = normalHealth("template", t.health);
        if (h.error) { bad(`templates.${name}`, h.error); continue; }
        templateHealth.set(name, h.health);
      }
      if (isTable(t) && t.start !== undefined) {
        const st = startCommands(t.start);
        if (st.error) { bad(`templates.${name}`, st.error); continue; }
        templateStart.set(name, st.commands);
      }
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
      // A command is a string, or { cmd, timeout } with a time limit of its own
      const run = [];
      const runLimits = [];
      let runBad = null;
      for (const [i, c] of (s.run ?? []).entries()) {
        const table = c && typeof c === "object";
        const cmd = table ? c.cmd : c;
        if (typeof cmd !== "string" || !cmd.trim()) { runBad = `run: commands, each a string or { cmd, timeout }${table ? ` (run[${i}] has no cmd)` : ""}`; break; }
        const extra = table ? Object.keys(c).filter((k) => k !== "cmd" && k !== "timeout") : [];
        if (extra.length) { runBad = `run[${i}]: unknown key ${extra[0]} (a command is cmd and timeout)`; break; }
        let limit = null;
        if (table && c.timeout !== undefined) {
          limit = duration(c.timeout);
          if (!limit) { runBad = `run[${i}]: timeout: a duration like "90s", not ${JSON.stringify(c.timeout)}`; break; }
        }
        run.push(cmd);
        runLimits.push(limit);
      }
      if (runBad) { bad(where, runBad); continue; }
      if (s.ready !== undefined && (typeof s.ready !== "string" || !s.ready.trim())) { bad(where, "ready: a command, as a string"); continue; }
      let timeout = null;
      if (s.timeout !== undefined) {
        timeout = duration(s.timeout);
        if (!timeout) { bad(where, `timeout: a duration like "2m", not ${JSON.stringify(s.timeout)}`); continue; }
      }
      okSnapshots.add(name);
      steps.push({
        key: snapshotKey(name), kind: "snapshot", name, runtime: r.runtime, needs: [], run,
        // Each command's time: its own timeout, else the snapshot's, else COMMAND_TIMEOUT_MS (as `snowglobe apply`)
        runTimeoutsMs: runLimits.map((l) => l ?? timeout ?? COMMAND_TIMEOUT_MS),
        ready: s.ready ?? null, timeoutMs: timeout ?? READY_TIMEOUT_MS,
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
      let health = templateHealth.get(sv.template) ?? null;
      if (sv.health !== undefined) {
        const h = normalHealth("service", sv.health);
        if (h.error) { bad(where, h.error); continue; }
        health = h.health;
      }
      const needs = needsOf(r, where);
      if (!needs) continue;
      const start = templateStart.get(sv.template) ?? [];
      steps.push({
        key: `service/${name}`, kind: "service", name, runtime: r.runtime, needs, ports: guest, port: guest[0], health, start,
        summary: `${start.length ? `Start ${r.runtime} (${start.length} command${start.length === 1 ? "" : "s"}), then open` : "Open"} ${r.runtime}'s port ${guest[0]}${health ? `, checked by ${describeHealth(health)}` : ""}`,
      });
      if (health?.heal === "drain") notes.push(`services.${name}: heal drain only reports here: the page has one machine for it, none to take out of service`);
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
      // Its own check, else its template's, healed by hook or none (a template's replace and drain are for its services)
      let health = templateHealth.get(m.template) ?? null;
      if (health && health.heal !== "hook") health = { ...health, heal: "none", healCmd: null };
      if (m.health !== undefined) {
        const h = normalHealth("machine", m.health);
        if (h.error) { bad(where, h.error); continue; }
        health = h.health;
      }
      if (health?.http && !r.network) { bad(where, `${r.runtime} has no network device on the page, so its HTTP check can't reach it`); continue; }
      const needs = needsOf(r, where);
      if (!needs) continue;
      const start = templateStart.get(m.template) ?? [];
      steps.push({ key: `machine/${name}`, kind: "machine", name, runtime: r.runtime, needs, health, start,
        summary: `Wake ${r.runtime}${start.length ? ` and start it (${start.length} command${start.length === 1 ? "" : "s"})` : ""}${health ? `, checked by ${describeHealth(health)}` : ""}` });
      if (m.ttl !== undefined) notes.push(`machines.${name}: ttl doesn't apply: the page's machine is kept until you clear its save`);
    }

    // Supervisors: each restarts its children (the file's services, machines and supervisors, in
    // order) when one fails, by its strategy. On the page a child is restarted by starting its
    // machine from its image and running that machine's steps again
    const supSpecs = new Map(tables(file.supervisors).filter(([, s]) => isTable(s)));
    const supervisors = new Map();
    const owner = new Map();
    const stepOf = (kind, name) => steps.find((s) => s.kind === kind && s.name === name);
    const childKind = (c) => (isTable(file.services?.[c]) ? "service" : isTable(file.machines?.[c]) ? "machine" : supSpecs.has(c) ? "supervisor" : null);
    for (const [name, sv] of supSpecs) {
      const where = `supervisors.${name}`;
      if (!NAME.test(name)) { bad(where, "a name is letters, digits, . _ or -"); continue; }
      for (const k of ["templates", "services", "machines", "snapshots", "links"]) {
        if (isTable(file[k]?.[name])) bad(where, `a ${k.slice(0, -1)} has that name (a child is named by its name alone)`);
      }
      const strategy = sv.strategy ?? "one_for_one";
      if (!STRATEGIES.includes(strategy)) { bad(where, `strategy ${JSON.stringify(strategy)}: one_for_one, one_for_all or rest_for_one`); continue; }
      if (sv.max_restarts !== undefined && (!Number.isInteger(sv.max_restarts) || sv.max_restarts < 0)) { bad(where, "max_restarts 1 or more"); continue; }
      let maxMs = 60000;
      if (sv.max_seconds !== undefined) {
        maxMs = duration(sv.max_seconds);
        if (!maxMs) { bad(where, `max_seconds: a duration like "60s", not ${JSON.stringify(sv.max_seconds)}`); continue; }
      }
      if (!Array.isArray(sv.children) || !sv.children.length || sv.children.some((c) => typeof c !== "string")) { bad(where, "children: at least one, by name"); continue; }
      const restart = isTable(sv.restart) ? sv.restart : {};
      if (sv.restart !== undefined && !isTable(sv.restart)) { bad(where, "restart: a table of a child's name to permanent, transient or temporary"); continue; }
      let wrong = null;
      const seen = new Set();
      for (const c of sv.children) {
        if (seen.has(c)) wrong = `child ${c} twice`;
        else if (c === name) wrong = "its own child";
        else if (!childKind(c)) wrong = `child ${c}: no service, machine or supervisor of that name in the file`;
        else if (owner.has(c) && owner.get(c) !== name) wrong = `child ${c} is a child of supervisor ${owner.get(c)} too`;
        if (wrong) break;
        seen.add(c);
        owner.set(c, name);
      }
      for (const [c, t] of Object.entries(restart)) {
        if (wrong) break;
        if (!seen.has(c)) wrong = `restart ${c}: not one of its children`;
        else if (!RESTART_TYPES.includes(t)) wrong = `restart ${c} = ${JSON.stringify(t)}: permanent, transient or temporary`;
      }
      if (wrong) { bad(where, wrong); continue; }
      supervisors.set(name, {
        name, strategy, maxRestarts: sv.max_restarts || 3, maxMs,
        children: sv.children.map((c) => ({ kind: childKind(c), name: c, restart: restart[c] ?? "permanent" })),
      });
    }
    // A supervisor runs only if each child does: a step left out (a problem above), or a supervisor
    // that can't, leaves it out too; one that is its own descendant is refused
    const supOk = new Map();
    const supCheck = (name, via = []) => {
      if (supOk.has(name)) return supOk.get(name);
      if (via.includes(name)) { bad(`supervisors.${name}`, `supervisors ${[...via, name].join(" → ")} go round in a circle`); supOk.set(name, false); return false; }
      const s = supervisors.get(name);
      let ok = !!s;
      for (const c of s?.children ?? []) {
        if (c.kind === "supervisor" ? !supCheck(c.name, [...via, name]) : !stepOf(c.kind, c.name)) {
          if (c.kind !== "supervisor") bad(`supervisors.${name}`, `its child ${c.kind} ${c.name} can't run here`);
          ok = false;
          break;
        }
      }
      supOk.set(name, ok);
      return ok;
    };
    const supList = [];
    for (const name of supervisors.keys()) {
      if (!supCheck(name)) continue;
      const s = supervisors.get(name);
      for (const c of s.children) c.key = c.kind === "supervisor" ? `supervisor/${c.name}` : stepOf(c.kind, c.name).key;
      s.parent = owner.get(name) ?? null;
      supList.push(s);
      // Children of one site share its machine: one restarted is all of them restarted
      const sites = new Map();
      for (const c of s.children) if (c.kind !== "supervisor") { const rt = stepOf(c.kind, c.name).runtime; sites.set(rt, [...(sites.get(rt) ?? []), c.name]); }
      for (const [rt, who] of sites) if (who.length > 1) notes.push(`supervisors.${name}: ${who.join(", ")} run in ${rt}, so restarting one restarts them all`);
    }
    for (const st of steps) st.supervisor = owner.has(st.name) && supOk.get(owner.get(st.name)) && childKind(st.name) === st.kind ? owner.get(st.name) : null;

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
    return { name: typeof file.name === "string" && file.name ? file.name : "fleet", steps, links: linkList, supervisors: supList, problems, notes };
  }

  // ---------------------------------------------------------------- running it

  /**
   * Runs a plan's steps over the page's orchestrator (`api`: runCommand, readJob, openPreview,
   * wake). state(key) is { status: "pending" | "running" | "done" | "failed", detail, output,
   * error }; a step runs only once what it needs is done, one step at a time. `onchange` is told of
   * every change; `sleep` and `now` are the clock (tests give theirs).
   */
  function createRun(api, thePlan, {
    onchange, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now(), pollMs = 500,
    callMs = 30000, startMs = 180000, graceMs = 30000, timer = setTimeout, tickMs = 1000, fresh = (runtime) => api.startFresh(runtime),
  } = {}) {
    const states = new Map(thePlan.steps.map((s) => [s.key, { status: "pending", detail: null, output: "", error: null }]));
    // How each checked step's health goes (once it is done), and each supervisor's
    const healths = new Map();
    const sups = new Map((thePlan.supervisors ?? []).map((s) => [s.name, { state: "running", restarts: [], last: null }]));
    const supBy = new Map((thePlan.supervisors ?? []).map((s) => [s.name, s]));
    let watching = null; // the timer of the next tick, while health is watched
    const byKey = new Map(thePlan.steps.map((s) => [s.key, s]));
    let chain = Promise.resolve();
    let stopping = false; // stop() is waiting for what runs to end
    const changed = () => { try { onchange?.(); } catch {} };
    const set = (key, patch) => { Object.assign(states.get(key), patch); changed(); };

    /** `p`, or a TimeoutError after `callMs`: a machine whose worker stopped answering (a phone's,
     *  frozen or ended without a word) leaves its calls pending for ever. */
    function answer(p, what, ms = callMs) {
      let t = null;
      const late = new Promise((_, reject) => {
        t = timer(() => {
          const e = new Error(`the machine did not answer ${what} within ${Math.round(ms / 1000)}s`);
          e.name = "TimeoutError";
          reject(e);
        }, ms);
      });
      return Promise.race([p, late]).finally(() => clearTimeout(t));
    }

    /** A command in a machine run to its end: { exit, output }. A job still running `graceMs`
     *  past its own limit, or whose machine doesn't answer, is given up as timed out, so a ready
     *  check goes on to its next try and a step to its own deadline. */
    async function exec(runtime, command, timeoutSeconds) {
      const began = now();
      // Starting a command wakes its machine first when it is asleep: a cold Supabase on a phone takes
      // longer than callMs to boot, so this call has startMs; the reads after it have callMs
      const { jobId } = await answer(api.runCommand({ runtime, command, timeoutSeconds }, { source: "fleet" }), "the command", startMs);
      const giveUpAt = began + timeoutSeconds * 1000 + graceMs;
      let silent = null;
      for (;;) {
        if (stopping) {
          try { await answer(Promise.resolve(api.cancelJob?.(jobId)), "a cancel"); } catch {}
          throw new Error("stopped");
        }
        if (now() >= giveUpAt) {
          try { await answer(Promise.resolve(api.cancelJob?.(jobId)), "a cancel"); } catch {}
          return { exit: null, output: "", state: "timed_out", error: silent ?? "it ran past its time limit" };
        }
        let v;
        try {
          v = await answer(api.readJob(jobId), "a read of the command");
        } catch (e) {
          if (e?.name !== "TimeoutError") throw e;
          silent = e.message;
          continue;
        }
        if (v.state !== "running") return { exit: v.state === "exited" ? v.exitStatus : null, output: v.output ?? "", state: v.state, error: v.error ?? null };
        await sleep(pollMs);
      }
    }

    const tail = (s) => String(s).trim().split("\n").slice(-12).join("\n");

    // The machines whose start commands ran in this run: once each, before its first service or machine step
    const started = new Set();

    /** A step's template's start commands, in its machine, each to success in its time (as the daemon's up). */
    async function start(step) {
      if (!step.start?.length || started.has(step.runtime)) return;
      for (const [i, c] of step.start.entries()) {
        set(step.key, { detail: `start command ${i + 1} of ${step.start.length}` });
        const r = await exec(step.runtime, c.cmd, Math.ceil(c.timeoutMs / 1000));
        if (r.exit !== 0) {
          set(step.key, { output: tail(`$ ${c.cmd}\n${r.output}`) });
          const how = r.exit === null ? (r.state === "timed_out" ? `ran past its time (${spoken(c.timeoutMs)})` : `ended ${r.state}`) : `exited ${r.exit}`;
          throw new Error(`start command ${i + 1} of ${step.start.length} ${how}`);
        }
      }
      started.add(step.runtime);
    }

    async function execute(step) {
      if (step.kind === "service" || step.kind === "machine") await start(step);
      if (step.kind === "snapshot") {
        let log = "";
        for (const [i, command] of step.run.entries()) {
          set(step.key, { detail: `command ${i + 1} of ${step.run.length}` });
          const began = now();
          const limitMs = step.runTimeoutsMs?.[i] ?? step.timeoutMs;
          const r = await exec(step.runtime, command, Math.ceil(limitMs / 1000));
          const took = `${((now() - began) / 1000).toFixed(1)}s`;
          // What each command printed and how it ended, so a failure on a slow device says what happened
          log += `$ ${command}\n${r.output}${r.output && !r.output.endsWith("\n") ? "\n" : ""}${r.output.trim() ? "" : "(no output)\n"}[${r.exit === null ? r.state : `exit ${r.exit}`} after ${took}]\n`;
          if (r.exit !== 0) {
            set(step.key, { output: tail(log) });
            console.warn(`fleet ${step.key}: command ${i + 1} of ${step.run.length} in ${step.runtime} ${r.exit === null ? `ended ${r.state}` : `exited ${r.exit}`} after ${took}\n${log}`);
            if (r.state === "timed_out") throw new Error(`command ${i + 1} of ${step.run.length} timed out (its limit ${spoken(limitMs)}) after ${took}${r.error ? `: ${r.error}` : ""}`);
            throw new Error(`command ${i + 1} ${r.exit === null ? `ended ${r.state}${r.error ? ` (${r.error})` : ""}` : `exited ${r.exit}`} after ${took}`);
          }
        }
        if (step.ready) {
          // The ready check confirms what the commands did: one that waits for something slow (a
          // server starting) is best a command of its own, with its own time limit, which waits in
          // the machine. Here it is checked again until the step's limit, a little less often
          // each time, each check within what is left of it.
          const began = now();
          const until = began + step.timeoutMs;
          let last = null;
          for (let checks = 1, pause = 1000;; checks++, pause = Math.min(pause * 2, 5000)) {
            const waited = Math.round((now() - began) / 1000);
            set(step.key, {
              detail: checks === 1 ? "checking it is ready" : `waiting until it is ready: ${waited}s of ${Math.round(step.timeoutMs / 1000)}s`,
              output: tail(log + (last ? `$ ${step.ready}\n${last}` : "")),
            });
            const left = Math.max(1, Math.ceil((until - now()) / 1000));
            const r = await exec(step.runtime, step.ready, Math.min(10, left));
            if (r.exit === 0) break;
            if (stopping) throw new Error("stopped");
            last = `${r.output}${r.output && !r.output.endsWith("\n") ? "\n" : ""}[${r.exit === null ? r.state : `exit ${r.exit}`}]\n`;
            if (now() + pause >= until) {
              set(step.key, { output: tail(log + `$ ${step.ready}\n${last}`) });
              const said = r.output.trim().split("\n").at(-1);
              throw new Error(`not ready after ${Math.round(step.timeoutMs / 1000)}s: its check ${r.exit === null ? `ended ${r.state}` : `exited ${r.exit}`}${said ? ` (${said})` : ""}`);
            }
            await sleep(pause);
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
        if (r.error && !step.health?.waitReady) throw new Error(`the preview is open, but its first request failed: ${r.error}`);
        if (step.health?.waitReady) {
          // wait_ready: done once it passes a check, within its grace
          const until = now() + step.health.graceMs;
          for (let n = 1; ; n++) {
            set(step.key, { detail: `waiting for it to pass its check (${describeHealth(step.health)})` });
            const c = await checkOnce(step);
            if (c?.ok) break;
            if (stopping) throw new Error("stopped");
            if (now() + step.health.intervalMs > until) throw new Error(`it didn't pass its check within its grace (${spoken(step.health.graceMs)})${c ? `: ${c.last}` : ""}`);
            await sleep(Math.min(step.health.intervalMs, 2000 * n));
          }
          return { detail: `port ${step.port} passed its check`, url: r.url ?? null };
        }
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
      await enqueue(() => doStep(step));
      return states.get(key);
    }

    /** `fn` once what runs before it is done: steps, health checks and restarts one at a time. */
    function enqueue(fn) {
      const run = chain.then(fn);
      chain = run.catch(() => {});
      return run;
    }

    async function doStep(step) {
      const key = step.key;
      if (stopping || states.get(key).status === "running") return;
      set(key, { status: "running", detail: null, error: null, output: "", startedAt: now() });
      try {
        set(key, { status: "done", ...(await execute(step)) });
        // Its checks start over: grace from now
        if (step.health) healths.set(key, { state: "starting", failures: 0, last: null, checked: null, since: now(), doneAt: now(), nextAt: now(), heals: 0, healAt: 0, hooked: false });
      } catch (e) {
        // A step that stop() ended goes back to pending, not failed
        if (stopping) set(key, { status: "pending", detail: null, error: null, output: "" });
        else set(key, { status: "failed", error: String(e?.message ?? e) });
      }
    }

    // ------------------------------------------------ health and supervisors

    /** One check of a step's machine: { ok, last }, or null if it wasn't checked (asleep, or busy:
     *  a check never wakes a machine). */
    async function checkOnce(step) {
      const h = step.health;
      if (!api.healthCheck) return null;
      let r;
      try {
        r = await answer(Promise.resolve(api.healthCheck({ runtime: step.runtime, cmd: h.cmd ?? undefined, http: h.http ? { port: h.http.port, path: h.http.path } : undefined,
          timeoutSeconds: Math.max(1, Math.ceil(h.timeoutMs / 1000)) })), "a health check");
      } catch (e) { return { ok: false, last: String(e?.message ?? e) }; }
      if (!r) return null;
      if (h.http) return { ok: r.status != null && h.http.ranges.some(([a, b]) => r.status >= a && r.status <= b), last: r.last ?? `HTTP ${r.status}` };
      return { ok: r.exit === 0, last: r.last ?? `exit ${r.exit}` };
    }

    const setHealth = (key, patch) => { Object.assign(healths.get(key), patch); changed(); };

    /** Whether a machine stopped by itself (its state failed): a supervised child's process ended. */
    async function machineFailed(runtime) {
      try { return (await api.status?.(runtime))?.state === "failed"; } catch { return false; }
    }

    /**
     * One round of the watch: each done step whose check is due is checked; one that fails
     * `failures` in a row (past its grace) is unhealthy, and healed (a hook, then starting its
     * machine again) or handed to its supervisor. A supervised child whose machine stopped by
     * itself has ended. Runs in the queue, so never beside a step.
     */
    function tick() {
      return enqueue(async () => {
        for (const step of thePlan.steps) {
          if (stopping) return;
          if (states.get(step.key).status !== "done") continue;
          if (step.supervisor && await machineFailed(step.runtime)) {
            const h = healths.get(step.key);
            if (h?.ended) continue;
            if (h) setHealth(step.key, { state: "unhealthy", last: "its machine stopped", ended: true });
            else healths.set(step.key, { state: "unhealthy", last: "its machine stopped", ended: true });
            await childFailed(step.supervisor, step.key, "ended", "its machine stopped");
            continue;
          }
          const h = healths.get(step.key);
          if (!step.health || !h) continue;
          // Unhealthy and waiting out its backoff: heal once it is over
          if (h.state === "unhealthy" && !step.supervisor && h.healAt && now() >= h.healAt) { await heal(step); continue; }
          if (now() < h.nextAt) continue;
          setHealth(step.key, { nextAt: now() + step.health.intervalMs });
          const r = await checkOnce(step);
          if (!r) continue;
          if (r.ok) {
            setHealth(step.key, { state: "healthy", failures: 0, last: r.last, checked: now(), heals: 0, healAt: 0, why: null, hooked: h.state === "healthy" ? false : h.hooked, ended: false, ...(h.state !== "healthy" ? { since: now() } : {}) });
            continue;
          }
          // A failed check counts once its grace is over (or once it has passed one)
          if (h.state === "starting" && now() - h.doneAt < step.health.graceMs) { setHealth(step.key, { last: r.last, checked: now() }); continue; }
          const failures = h.failures + 1;
          setHealth(step.key, { failures, last: r.last, checked: now() });
          if (failures < step.health.failures || h.state === "unhealthy" || h.state === "degraded") continue;
          setHealth(step.key, { state: "unhealthy", since: now() });
          if (step.supervisor) await childFailed(step.supervisor, step.key, "unhealthy", r.last);
          else await heal(step);
        }
      });
    }

    /**
     * An unhealthy step that no supervisor watches, healed as its check says: none (and drain, on the
     * page) only report; hook runs heal_cmd, then checks again (unhealthy again, a service is
     * restarted, a machine left to report); replace starts its machine from its image again and runs
     * its steps. One heal at a time, waiting longer after each; after MAX_HEALS with no check
     * passing it is degraded and healing stops.
     */
    async function heal(step) {
      const h = healths.get(step.key);
      const hc = step.health;
      let how = hc.heal;
      if (how === "hook" && h.hooked) how = step.kind === "service" ? "replace" : "none";
      if (how === "none" || how === "drain") return;
      if (h.healAt && now() < h.healAt) return;
      const attempt = h.heals + 1;
      if (attempt > MAX_HEALS) { setHealth(step.key, { state: "degraded", healAt: 0, why: `healed ${MAX_HEALS} times in a row with no check passing: healing stopped until one does` }); return; }
      setHealth(step.key, { heals: attempt, healAt: now() + Math.min(hc.intervalMs * 2 ** (attempt - 1), MAX_HEAL_BACKOFF_MS) });
      if (how === "hook") {
        setHealth(step.key, { state: "healing", last: `running its heal command (heal ${attempt} of ${MAX_HEALS})` });
        let said;
        try {
          const r = await exec(step.runtime, hc.healCmd, 60);
          said = r.exit === 0 ? "exit 0" : r.exit === null ? r.state : `exit ${r.exit}`;
        } catch (e) { said = String(e?.message ?? e); }
        // Checked again: passing, it is healthy; failing again, it is healed past its hook
        setHealth(step.key, { state: "checking", failures: 0, hooked: true, last: `ran its heal command (${said}), checking it again`, nextAt: now() });
        return;
      }
      setHealth(step.key, { state: "healing", last: `starting ${step.runtime} again (heal ${attempt} of ${MAX_HEALS})` });
      const keep = { heals: attempt, healAt: healths.get(step.key).healAt };
      await restart([step.runtime]);
      // A restart that didn't bring it back is still counted, and still waits its backoff
      const after = healths.get(step.key);
      if (after) Object.assign(after, keep);
    }

    /** The machines `runtimes` started from their image (in reverse order) and their steps run again
     *  (in plan order): a restart, on the page. What it couldn't do is said on the step. */
    async function restart(runtimes) {
      const set1 = new Set(runtimes);
      for (const rt of [...set1].reverse()) {
        for (let tries = 0; ; tries++) {
          try { await fresh(rt); break; } catch (e) {
            if (tries >= 10 || !/busy/.test(String(e?.message))) break;
            await sleep(300);
          }
        }
      }
      for (const step of thePlan.steps) {
        if (stopping) return;
        if (!set1.has(step.runtime) || step.kind === "link") continue;
        healths.delete(step.key);
        set(step.key, { status: "pending", detail: null, error: null, output: "" });
        await doStep(step);
      }
    }

    /** The steps under a supervisor's child (itself, or a supervisor's children, all the way down). */
    function leaves(child) {
      if (child.kind !== "supervisor") return [byKey.get(child.key)];
      return supBy.get(child.name).children.filter((c) => c.restart !== "temporary").flatMap(leaves);
    }

    /**
     * A supervisor's child failed (`how`: unhealthy, ended, or escalated: a supervisor under it gave
     * up): restarted by its restart type and the supervisor's strategy, unless that is more than
     * max_restarts within max_seconds, when the supervisor fails its own parent, or (at the top)
     * is degraded until it is restarted.
     */
    async function childFailed(supName, childKey, how, detail) {
      const sup = supBy.get(supName);
      const st = sups.get(supName);
      const idx = sup.children.findIndex((c) => c.key === childKey);
      const child = sup.children[idx];
      const what = `${child.kind} ${child.name} ${how}${detail ? `: ${detail}` : ""}`;
      if (child.restart === "temporary") { st.last = `${what}: temporary, so nothing is restarted`; return changed(); }
      if (child.restart === "transient" && how === "ended") { st.last = `${what}: transient, so a normal exit: nothing is restarted`; return changed(); }
      if (st.state === "degraded") { st.last = `${what}: not restarted (the supervisor is degraded)`; return changed(); }
      st.restarts = [...st.restarts.filter((t) => now() - t < sup.maxMs), now()];
      if (st.restarts.length > sup.maxRestarts) {
        st.restarts = [];
        if (sup.parent) {
          st.last = `more than ${sup.maxRestarts} restarts in ${spoken(sup.maxMs)}: it failed ${sup.parent}`;
          changed();
          return childFailed(sup.parent, `supervisor/${supName}`, "escalated", what);
        }
        st.state = "degraded";
        st.last = `more than ${sup.maxRestarts} restarts in ${spoken(sup.maxMs)} (${what}): degraded, restarting nothing until it is restarted`;
        return changed();
      }
      const which = sup.strategy === "one_for_all" ? sup.children.map((_, i) => i)
        : sup.strategy === "rest_for_one" ? sup.children.map((_, i) => i).filter((i) => i >= idx) : [idx];
      const restarted = which.map((i) => sup.children[i]).filter((c, i) => c === child || c.restart !== "temporary");
      // A supervisor restarted starts over: its restarts forgotten, no longer degraded
      for (const c of restarted) if (c.kind === "supervisor") resetSup(c.name);
      const runtimes = [...new Set(restarted.flatMap(leaves).map((s) => s.runtime))];
      st.last = `restarted ${restarted.map((c) => c.name).join(", ")} (${sup.strategy}, restart ${st.restarts.length} of ${sup.maxRestarts} in ${spoken(sup.maxMs)}): ${what}`;
      changed();
      await restart(runtimes);
    }

    function resetSup(name) {
      Object.assign(sups.get(name), { state: "running", restarts: [] });
      for (const c of supBy.get(name).children) if (c.kind === "supervisor") resetSup(c.name);
    }

    /** A degraded supervisor (or any) started over: its children restarted, its count forgotten. */
    function restartSupervisor(name) {
      const sup = supBy.get(name);
      if (!sup) throw new Error(`no supervisor ${name}`);
      return enqueue(async () => {
        resetSup(name);
        sups.get(name).last = "restarted by hand";
        changed();
        await restart([...new Set(sup.children.filter((c) => c.restart !== "temporary").flatMap(leaves).map((s) => s.runtime))]);
      });
    }

    /** Health watched every `tickMs` until unwatch() (or stop()). */
    function watch() {
      if (watching) return;
      const next = () => {
        watching = timer(async () => {
          if (!watching) return;
          try { await tick(); } catch {}
          if (watching) next();
        }, tickMs);
      };
      next();
    }
    function unwatch() {
      if (watching) clearTimeout(watching);
      watching = null;
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
      unwatch();
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
        healths.clear();
        for (const name of sups.keys()) { resetSup(name); sups.get(name).last = null; }
      } finally {
        stopping = false;
        changed();
      }
      return { problems };
    }

    return {
      state: (key) => states.get(key), runStep, runAll, stop, steps: thePlan.steps,
      health: (key) => healths.get(key) ?? null, supervisor: (name) => sups.get(name) ?? null, supervisors: thePlan.supervisors ?? [],
      watch, unwatch, tick, restartSupervisor,
    };
  }

  const SnowglobeFleet = { parse, plan, createRun, highlight, graph, duration, siteOf, guestPort, describeHealth, TomlError, KEYS, TOP, HEALTH_KEYS, HTTP_KEYS };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeFleet;
  else root.SnowglobeFleet = SnowglobeFleet;
})(typeof window !== "undefined" ? window : globalThis);
