// What an agent builds, as the agent page (/agent/) shows it: which files each command changed, and
// the previewed page rebuilt and reloaded after each change.
//  - Changes: a machine whose site has an agent-watch directory (label snowglobe.agent-watch, web's
//    /root/app) runs each command inside a wrapper: before it, a copy of the directory is taken if
//    there is none yet; after it, every file that differs from that copy is listed with a unified
//    diff (BusyBox's diff, no git needed), and the copy is brought up to date. The report goes at
//    the end of the job's output between two lines that carry a nonce of the job's own, and the page
//    takes it out of the output before anyone reads it: an agent sees what its command printed.
//    The command itself runs as a file of the job's ($EXCLAVE_WORKSPACE/in/cmd), unchanged.
//  - Rebuilds: `serve --watch` (the web machine's) says how its last build went at /__build. While a
//    preview is open the page reads it (often for a while after a change, rarely otherwise) and
//    reloads the preview once a new build is written. The preview's bridge has no WebSockets, so
//    Vite's hot reload can't be used.
//  - The feed: every command in every machine, newest first, with the files it changed (each a
//    disclosure with its diff), the builds, and the preview opening and reloading.
//  - A walkthrough that plays a few edits through the same calls an agent makes.
(function (root) {
  "use strict";

  const MARK = "SGCHANGES";
  const MAX_FILES = 40; // files listed per command
  const MAX_LINES = 300; // diff lines per file
  const MAX_DIFF_BYTES = 256 << 10; // larger files are listed without a diff
  const SNAPSHOTS = "/var/lib/snowglobe/watch";

  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

  /** A watched directory: absolute, no NUL or line breaks, no trailing slash. */
  function checkWatch(dir) {
    if (typeof dir !== "string" || !dir.startsWith("/") || /[\0\n\r]/.test(dir)) throw new Error("watch: an absolute directory");
    return dir.replace(/\/+$/, "") || "/";
  }

  /** Where the copy of `dir` the changes are measured against is kept, in the machine. */
  const snapshotDir = (dir, under = SNAPSHOTS) => under + (checkWatch(dir) === "/" ? "/root-dir" : checkWatch(dir));

  // Changes kept to undo, per watched directory: the state before each of the last HISTORY commands
  // that changed something
  const HISTORY = 20;

  /** The shell functions the wrapper and a revert share: sg_list (the project's files, without
   *  node_modules, dist and .git), sg_snap (the copy made again), sg_restore <dir> (the project made
   *  as <dir> is: files it lacks deleted, its files copied in). */
  function shellLib(w, s) {
    return `sg_w=${quote(w)}; sg_s=${quote(s)}; sg_h="$sg_s.history"; sg_b="$sg_s.base"
sg_list() { find . \\( -name node_modules -o -name dist -o -name .git \\) -prune -o -type f -print; }
sg_snap() {
  rm -rf "$sg_s.new" && mkdir -p "$sg_s.new" || return
  ( cd "$sg_w" && sg_list | while IFS= read -r f; do mkdir -p "$sg_s.new/\${f%/*}" && cp -p "$f" "$sg_s.new/$f"; done )
}
sg_restore() {
  ( cd "$sg_w" && sg_list | while IFS= read -r f; do [ -f "$1/$f" ] || rm -f "$f"; done )
  ( cd "$1" && find . -type f -print | while IFS= read -r f; do mkdir -p "$sg_w/\${f%/*}" && cp "$f" "$sg_w/$f"; done )
}
`;
  }

  /**
   * A command wrapped so its job also reports what it changed in `dir`: { command, files } for
   * runCommand. `nonce` (letters and digits) marks the report. The command runs as it would have,
   * from a file of the job's: its exit status is the job's. `snapshots`: where the copies are kept.
   * The copy from before the first command is kept (<copy>.base: what revert to "start" restores),
   * and so is the copy from before each of the last 20 commands that changed something
   * (<copy>.history/<n>: what revert to "previous" restores).
   */
  function wrapCommand(command, dir, nonce, { snapshots = SNAPSHOTS } = {}) {
    if (!/^[A-Za-z0-9]{8,64}$/.test(nonce)) throw new Error("nonce: 8 to 64 letters or digits");
    const w = checkWatch(dir);
    const s = snapshotDir(w, snapshots);
    const script = shellLib(w, s) + `if [ ! -d "$sg_s" ] && [ -d "$sg_w" ]; then
  sg_snap 2>/dev/null && mv "$sg_s.new" "$sg_s"
  [ -d "$sg_b" ] || cp -pR "$sg_s" "$sg_b" 2>/dev/null
fi
sh "$EXCLAVE_WORKSPACE/in/cmd"
sg_rc=$?
if [ -d "$sg_w" ] && [ -d "$sg_s" ]; then
  ( cd "$sg_w" && { sg_list; ( cd "$sg_s" && find . -type f -print ); } | sort -u | {
    n=0
    while IFS= read -r f; do
      a="$sg_s/$f"; b="$f"
      if [ -f "$b" ] && [ -f "$a" ]; then cmp -s "$a" "$b" && continue; st=M
      elif [ -f "$b" ]; then st=A; a=/dev/null
      else st=D; b=/dev/null; fi
      n=$((n + 1))
      if [ "$n" -gt ${MAX_FILES} ]; then echo SGC_MORE; break; fi
      echo "SGC_FILE $st \${f#./}"
      sz=$(cat "$a" "$b" | wc -c)
      if [ "$sz" -gt ${MAX_DIFF_BYTES} ]; then echo "SGC_BIG $sz"; continue; fi
      if [ "$(cat "$a" "$b" | tr -d '\\000' | wc -c)" -ne "$sz" ]; then echo SGC_BINARY; continue; fi
      diff -U 2 "$a" "$b" 2>&1 | awk -v max=${MAX_LINES} 'NR <= 2 && /^(---|\\+\\+\\+) / { next } { if (++k <= max) print; else c++ } END { if (c) print "SGC_CUT " c }'
    done
  } ) >"$sg_s.report" 2>&1
  sg_snap 2>/dev/null
  if grep -q '^SGC_FILE ' "$sg_s.report" && [ ! -e "$sg_s.nohist" ]; then
    # What it was before this command, kept to undo it
    mkdir -p "$sg_h"
    sg_n=$(( $(cat "$sg_h/.seq" 2>/dev/null || echo 0) + 1 ))
    echo "$sg_n" >"$sg_h/.seq"
    mv "$sg_s" "$sg_h/$sg_n"
    sg_k=$(ls "$sg_h" | wc -l)
    [ "$sg_k" -gt ${HISTORY} ] && ls "$sg_h" | sort -n | head -n $((sg_k - ${HISTORY})) | while IFS= read -r d; do rm -rf "$sg_h/$d"; done
  else
    rm -rf "$sg_s"
  fi
  rm -f "$sg_s.nohist"
  mv "$sg_s.new" "$sg_s" 2>/dev/null
  printf '\\n%s_%s BEGIN\\n' ${MARK} ${nonce}
  cat "$sg_s.report"
  rm -f "$sg_s.report"
  printf '%s_%s END\\n' ${MARK} ${nonce}
fi
exit $sg_rc
`;
    return { command: script, files: { cmd: new TextEncoder().encode(command.endsWith("\n") ? command : command + "\n") } };
  }

  /**
   * The command that takes a watched project back (run it wrapped, as any command, so its job
   * reports what it changed): to "previous", as it was before the last command that changed it (that
   * step is then forgotten, so the next revert goes one further back); to "start", as it was before
   * the first command run in it (the starter, in a machine started fresh), itself a step a
   * "previous" can undo. node_modules, dist and .git are never touched.
   */
  function revertCommand(dir, to, { snapshots = SNAPSHOTS } = {}) {
    if (to !== "previous" && to !== "start") throw new Error('to: "previous" (undo the last change) or "start" (back to how the project began)');
    const w = checkWatch(dir);
    const s = snapshotDir(w, snapshots);
    const pick = to === "previous"
      ? `sg_n=$(ls "$sg_h" 2>/dev/null | sort -n | tail -n 1)
[ -n "$sg_n" ] || { echo "nothing to undo: no change is kept"; exit 3; }
src="$sg_h/$sg_n"
`
      : `src="$sg_b"
[ -d "$src" ] || { echo "nothing to revert: no command has changed the project yet"; exit 3; }
`;
    const after = to === "previous" ? `rm -rf "$src"; touch "$sg_s.nohist"
echo "undid the last change (step $sg_n); $(ls "$sg_h" | wc -l) more kept"
`
      : `echo "the project is as it began; undo takes it back to before this"
`;
    return shellLib(w, s) + pick + `sg_restore "$src"
` + after;
  }

  /**
   * A wrapped job's output split in two: { output (what the command printed), changes (null until
   * the report is complete) }. A report under way, or cut off (a job stopped), is never shown.
   */
  function splitChanges(output, nonce) {
    const begin = `\n${MARK}_${nonce} BEGIN\n`;
    const at = output.indexOf(begin);
    if (at === -1) {
      // The start of the begin line, still arriving
      for (let n = Math.min(begin.length - 1, output.length); n > 1; n--) {
        if (output.endsWith(begin.slice(0, n))) return { output: output.slice(0, -n), changes: null };
      }
      return { output, changes: null };
    }
    const from = at + begin.length;
    const end = output.indexOf(`${MARK}_${nonce} END`, from);
    return { output: output.slice(0, at), changes: end === -1 ? null : parseChanges(output.slice(from, end)) };
  }

  /** The report: { files: [{ status: "added" | "modified" | "deleted", path, diff, added, removed,
   *  cut (lines left out), big (bytes, no diff) }], more (over MAX_FILES) }. */
  function parseChanges(text) {
    const files = [];
    let more = false;
    let f = null;
    const STATUS = { A: "added", M: "modified", D: "deleted" };
    for (const line of text.split("\n")) {
      let m;
      if ((m = /^SGC_FILE ([AMD]) (.+)$/.exec(line))) {
        f = { status: STATUS[m[1]], path: m[2], diff: "", added: 0, removed: 0, cut: 0, big: 0, binary: false };
        files.push(f);
      } else if (line === "SGC_MORE") {
        more = true;
      } else if (f && (m = /^SGC_BIG (\d+)$/.exec(line))) {
        f.big = Number(m[1]);
      } else if (f && line === "SGC_BINARY") {
        f.binary = true;
      } else if (f && (m = /^SGC_CUT (\d+)$/.exec(line))) {
        f.cut = Number(m[1]);
      } else if (f && line !== "") {
        f.diff += line + "\n";
        if (line.startsWith("+")) f.added++;
        else if (line.startsWith("-")) f.removed++;
      } else if (f && line === "" && f.diff) {
        f.diff += "\n";
      }
    }
    for (const x of files) x.diff = x.diff.replace(/\n+$/, "\n");
    return { files, more };
  }

  /** A diff's lines, for showing: { kind: "add" | "del" | "hunk" | "ctx" | "note", text }. */
  function diffLines(diff) {
    return diff.replace(/\n$/, "").split("\n").map((text) => ({
      kind: text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : text.startsWith("@@") ? "hunk" : text.startsWith(" ") ? "ctx" : "note",
      text,
    }));
  }

  /** "src/App.jsx (+3 −1)", "2 files: src/App.jsx (+3 −1), src/styles.css (added)". */
  function summary(changes) {
    if (!changes || !changes.files.length) return "no files changed";
    const one = (f) => f.status === "added" ? `${f.path} (added)` : f.status === "deleted" ? `${f.path} (deleted)` : `${f.path} (+${f.added} −${f.removed})`;
    const list = changes.files.slice(0, 4).map(one).join(", ") + (changes.files.length > 4 || changes.more ? ", …" : "");
    return changes.files.length === 1 ? list : `${changes.files.length}${changes.more ? "+" : ""} files: ${list}`;
  }

  // ---------------------------------------------------------------- a project's files

  const MAX_LIST = 2000; // entries list_files gives
  const MAX_READ_FILE = 256 << 10; // bytes read_file gives of one file
  const MAX_READ_TOTAL = 640 << 10; // and of all the files of one call (as base64, under a job's 1 MiB of output)
  const MAX_READ_PATHS = 20;
  const MAX_WRITE_FILES = 50;
  const MAX_WRITE_TOTAL = 1 << 20;

  /** A path in a machine, checked: no NUL or line breaks, not a directory's trailing slash. */
  function checkFilePath(p, what = "path") {
    if (typeof p !== "string" || !p.trim() || p.length > 4096 || /[\0\n\r]/.test(p)) throw new Error(`${what}: a file path in the machine (relative paths start in /root), with no line breaks`);
    return p;
  }

  /** The job that lists a directory, `depth` levels down: one line a path, "<type>|<bytes>|<path>",
   *  node_modules, dist and .git listed but not entered. */
  function listCommand(dir, depth = 4) {
    checkFilePath(dir, "path");
    if (!Number.isInteger(depth) || depth < 1 || depth > 12) throw new Error("depth: 1 to 12 levels");
    return `d=${quote(dir)}\n` +
      `[ -d "$d" ] || { echo "SGLS_ERR no such directory: $d"; exit 0; }\n` +
      `cd "$d" && echo "SGLS_DIR $(pwd)" && ` +
      `find . -mindepth 1 -maxdepth ${depth} \\( -name node_modules -o -name dist -o -name .git \\) -prune -print -o -print 2>/dev/null | ` +
      `head -n ${MAX_LIST + 1} | tr '\\n' '\\0' | xargs -0 -r stat -c 'SGLS %F|%s|%n'\n`;
  }

  /** What listCommand printed: { dir, entries: [{ path, type: "dir" | "file" | "link", size,
   *  skipped (node_modules, dist, .git: not entered) }], truncated }, sorted as a tree is. */
  function parseList(output) {
    const err = /SGLS_ERR ([^\n]*)/.exec(output);
    if (err) throw new Error(err[1].trim());
    const dir = /SGLS_DIR ([^\n]*)/.exec(output)?.[1] ?? null;
    const SKIP = new Set(["node_modules", "dist", ".git"]);
    const entries = [];
    for (const line of output.split("\n")) {
      const m = /^SGLS ([^|]*)\|(\d+)\|\.\/(.+)$/.exec(line);
      if (!m) continue;
      const type = /directory/.test(m[1]) ? "dir" : /link/.test(m[1]) ? "link" : "file";
      const path = m[3];
      entries.push({ path, type, size: type === "file" ? Number(m[2]) : 0, ...(type === "dir" && SKIP.has(path.split("/").pop()) ? { skipped: true } : {}) });
    }
    const truncated = entries.length > MAX_LIST;
    if (truncated) entries.length = MAX_LIST;
    entries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return { dir, entries, truncated };
  }

  /** The job that reads files: each as SGRF_HEAD <i> <bytes>, its first `max` bytes as base64, and
   *  SGRF_END <i>, or SGRF_ERR <i> <why>. */
  function readCommand(paths, max = MAX_READ_FILE) {
    if (!Array.isArray(paths) || !paths.length || paths.length > MAX_READ_PATHS) throw new Error(`paths: 1 to ${MAX_READ_PATHS} files`);
    const each = Math.min(max, Math.floor(MAX_READ_TOTAL / paths.length));
    return paths.map((p, i) => `f=${quote(checkFilePath(p))}\n` +
      `if [ ! -e "$f" ]; then echo "SGRF_ERR ${i} no such file"\n` +
      `elif [ ! -f "$f" ]; then echo "SGRF_ERR ${i} not a regular file"\n` +
      `elif [ ! -r "$f" ]; then echo "SGRF_ERR ${i} not readable"\n` +
      `else echo "SGRF_HEAD ${i} $(wc -c <"$f")"; head -c ${each} "$f" | base64 | tr -d '\\n'; printf '\\nSGRF_END ${i}\\n'; fi\n`).join("");
  }

  /** What readCommand printed: [{ path, size, text, truncated, binary, error }], as `paths` were asked. */
  function parseRead(output, paths) {
    const dec = new TextDecoder("utf-8", { fatal: true });
    return paths.map((path, i) => {
      const err = new RegExp(`SGRF_ERR ${i} ([^\\n]*)`).exec(output);
      if (err) return { path, error: err[1].trim() };
      const head = new RegExp(`SGRF_HEAD ${i} +(\\d+)\\n`).exec(output);
      const end = head ? output.indexOf(`\nSGRF_END ${i}\n`, head.index) : -1;
      if (!head || end === -1) return { path, error: "the machine did not send it" };
      const b64 = output.slice(head.index + head[0].length, end).replace(/\s+/g, "");
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
      const size = Number(head[1]);
      const truncated = bytes.length < size;
      let text;
      try {
        // A cut may end inside a character: decode what is whole
        text = truncated ? new TextDecoder().decode(bytes).replace(/�$/, "") : dec.decode(bytes);
        if (truncated && text.includes("�")) throw new Error("binary");
      } catch {
        return { path, size, binary: true };
      }
      if (text.includes("\0")) return { path, size, binary: true };
      return { path, size, text, truncated };
    });
  }

  /**
   * The job that changes several files at once: { command, files } for runCommand. `files`
   * ([{ path, content }]) are written to a temporary name beside each target first, then all moved
   * into place; then `move` ([{ from, to }]) and `remove` (paths: files, or directories under
   * /root) are done. One job, so one report of what changed and, in a watched project, one rebuild.
   */
  function writeFilesCommand({ files = [], move = [], remove = [] } = {}) {
    if (!Array.isArray(files) || !Array.isArray(move) || !Array.isArray(remove)) throw new Error("files, move and delete: arrays");
    if (!files.length && !move.length && !remove.length) throw new Error("nothing to do: give files, move or delete");
    if (files.length > MAX_WRITE_FILES) throw new Error(`files: at most ${MAX_WRITE_FILES} in one call`);
    const enc = new TextEncoder();
    const jobFiles = {};
    let total = 0;
    const lines = ["set -e", "sg_in=\"$EXCLAVE_WORKSPACE/in\""];
    const finals = [];
    const seen = new Set();
    files.forEach((f, i) => {
      if (!f || typeof f !== "object") throw new Error(`files[${i}]: { path, content }`);
      const p = checkFilePath(f.path, `files[${i}].path`);
      if (p.endsWith("/")) throw new Error(`files[${i}].path: a file, not a directory`);
      if (typeof f.content !== "string") throw new Error(`files[${i}].content: the file's text, a string`);
      if (seen.has(p)) throw new Error(`files: ${p} is given twice`);
      seen.add(p);
      const bytes = enc.encode(f.content);
      total += bytes.length;
      jobFiles[`f${i}`] = bytes;
      lines.push(`f=${quote(p)}; mkdir -p -- "$(dirname -- "$f")"; cat "$sg_in/f${i}" >"$f.sgnew"`);
      finals.push(`f=${quote(p)}; mv -f -- "$f.sgnew" "$f"`);
    });
    if (total > MAX_WRITE_TOTAL) throw new Error(`files: ${total} bytes in all; at most ${MAX_WRITE_TOTAL} (1 MiB) in one call`);
    lines.push(...finals);
    move.forEach((m, i) => {
      const from = checkFilePath(m?.from, `move[${i}].from`);
      const to = checkFilePath(m?.to, `move[${i}].to`);
      lines.push(`a=${quote(from)}; b=${quote(to)}; [ -e "$a" ] || { echo "no $a to move" >&2; exit 2; }; mkdir -p -- "$(dirname -- "$b")"; mv -f -- "$a" "$b"`);
    });
    remove.forEach((r, i) => {
      const p = checkFilePath(r, `delete[${i}]`);
      lines.push(`p=${quote(p)}; case "$(cd "$(dirname -- "$p")" 2>/dev/null && pwd)/$(basename -- "$p")" in /root/?*/*|/root/?*|/tmp/?*) ;; *) echo "not deleting $p: only paths under /root or /tmp" >&2; exit 2;; esac; rm -rf -- "$p"`);
    });
    lines.push(`echo "${files.length} written, ${move.length} moved, ${remove.length} deleted"`);
    return { command: lines.join("\n") + "\n", files: jobFiles, bytes: total };
  }

  // ---------------------------------------------------------------- rebuilds

  /**
   * Reads a server's /__build while a preview is open: `get()` resolves to { status, body } or
   * null (not reachable now). `onBuild(build, previous)` hears each new build (its version went
   * up, or the server started again), never the first one read; `onState(build | null)` every read.
   * Reads every `slowMs`, or every `fastMs` for `fastForMs` after kick() (a change was made) and
   * while a build is under way. `supported` is false once the server says it has no /__build.
   */
  class BuildWatch {
    constructor({ get, onBuild, onState, timers = root, now = () => Date.now(), slowMs = 5000, fastMs = 500, fastForMs = 45000, visible = () => true } = {}) {
      Object.assign(this, { get, onBuild, onState, timers, now, slowMs, fastMs, fastForMs, visible });
      this.timer = null;
      this.running = false;
      this.reading = false;
      this.reset();
    }

    reset() {
      this.version = null;
      this.build = null;
      this.supported = null;
      this.fastUntil = 0;
    }

    start() {
      this.stop();
      this.reset();
      this.running = true;
      this.kick(); // the server may still be building its first page
    }

    stop() {
      this.running = false;
      if (this.timer) this.timers.clearTimeout(this.timer);
      this.timer = null;
    }

    /** Something changed: read often for a while, starting now. */
    kick() {
      this.fastUntil = this.now() + this.fastForMs;
      if (!this.running) return;
      if (this.timer) this.timers.clearTimeout(this.timer);
      this.timer = null;
      this.tick();
    }

    _next() {
      if (!this.running || this.timer) return;
      const fast = this.now() < this.fastUntil || this.build?.state === "building";
      this.timer = this.timers.setTimeout(() => { this.timer = null; this.tick(); }, fast ? this.fastMs : this.slowMs);
    }

    async tick() {
      if (!this.running || this.reading) return;
      if (!this.visible()) return this._next();
      this.reading = true;
      try {
        const r = await this.get();
        if (!this.running) return;
        if (!r) return;
        if (r.status === 404) {
          this.supported = false;
          this.onState?.(null);
          return;
        }
        let b;
        try { b = JSON.parse(r.body); } catch { return; }
        if (!b || typeof b.version !== "number") return;
        this.supported = true;
        const prev = this.build;
        this.build = b;
        this.onState?.(b);
        if (this.version !== null && b.version !== this.version && b.version > 0) this.onBuild?.(b, prev);
        this.version = b.version;
      } catch {
        // Not reachable this time (the machine is busy waking, the server restarting): read again
      } finally {
        this.reading = false;
        this._next();
      }
    }
  }

  // ---------------------------------------------------------------- the walkthrough

  /** A file's text with `from` replaced by `to`, exactly once, or an error naming the step. */
  function replaceOnce(text, from, to, step) {
    const at = text.indexOf(from);
    if (at === -1 || text.indexOf(from, at + 1) !== -1) {
      throw new Error(`${step}: src/App.jsx isn't the one the walkthrough wrote any more (start web fresh, or revert it to the starter, to play it again)`);
    }
    return text.slice(0, at) + to + text.slice(at + from.length);
  }

  // Step 1's schema: each user's todos, under row level security. Replayable (if not exists, drop
  // policy if exists); runSql reloads the Data API's schema after it.
  const TODOS_SQL = `-- Each user's todos; row level security lets a user see and change only their own
create table if not exists public.todos (
  id bigint generated always as identity primary key,
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  title text not null check (length(title) between 1 and 200),
  done boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.todos enable row level security;
grant select, insert, update, delete on public.todos to authenticated;

drop policy if exists "read own todos" on public.todos;
create policy "read own todos" on public.todos for select to authenticated
  using ((select auth.uid()) = user_id);
drop policy if exists "add own todos" on public.todos;
create policy "add own todos" on public.todos for insert to authenticated
  with check ((select auth.uid()) = user_id);
drop policy if exists "change own todos" on public.todos;
create policy "change own todos" on public.todos for update to authenticated
  using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
drop policy if exists "delete own todos" on public.todos;
create policy "delete own todos" on public.todos for delete to authenticated
  using ((select auth.uid()) = user_id);
`;

  // Step 2's app, written whole over the blank starter: sign-in, then the list (add, tick, delete)
  const TODO_APP = `import { useEffect, useState } from "react";
import { supabase } from "./supabase.js";

// A todo list on Supabase: Auth signs you up and in, the Data API keeps the todos, and row level
// security in Postgres keeps each user's todos their own (the todos table)
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
    <main className="mx-auto grid max-w-md gap-6 px-5 py-10">
      <header className="flex items-baseline justify-between gap-4">
        <h1 className="text-3xl font-semibold tracking-tight">Todos</h1>
        {session && (
          <button type="button" className="text-sm text-neutral-500 hover:text-neutral-900" onClick={() => supabase.auth.signOut()}>
            Sign out
          </button>
        )}
      </header>
      {!ready ? <p className="text-sm text-neutral-500">Loading…</p> : session ? <Todos /> : <SignIn />}
    </main>
  );
}

const field = "rounded-md border border-neutral-300 bg-white px-3 py-2 text-neutral-900";
const primary = "rounded-full bg-neutral-900 px-4 py-2 text-white disabled:opacity-50";
const secondary = "rounded-full border border-neutral-900 px-4 py-2 disabled:opacity-50";

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
    <form className="grid gap-3" onSubmit={(e) => { e.preventDefault(); submit("login"); }}>
      <label className="grid gap-1 text-sm text-neutral-600">
        Email
        <input className={field} type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
      </label>
      <label className="grid gap-1 text-sm text-neutral-600">
        Password
        <input className={field} type="password" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={6} autoComplete="current-password" />
      </label>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      <div className="flex gap-2">
        <button type="submit" className={primary} disabled={busy}>Log in</button>
        <button type="button" className={secondary} disabled={busy} onClick={() => submit("signup")}>Sign up</button>
      </div>
    </form>
  );
}

function Todos() {
  const [todos, setTodos] = useState([]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState(null);

  async function load() {
    const { data, error } = await supabase.from("todos").select("id, title, done").order("id");
    if (error) setError(error.message);
    else setTodos(data);
  }

  useEffect(() => { load(); }, []);

  async function add(e) {
    e.preventDefault();
    if (!title.trim()) return;
    const { error } = await supabase.from("todos").insert({ title: title.trim() });
    if (error) return setError(error.message);
    setTitle("");
    load();
  }

  async function toggle(todo) {
    const { error } = await supabase.from("todos").update({ done: !todo.done }).eq("id", todo.id);
    if (error) return setError(error.message);
    load();
  }

  async function remove(id) {
    const { error } = await supabase.from("todos").delete().eq("id", id);
    if (error) return setError(error.message);
    load();
  }

  return (
    <section className="grid gap-4">
      <form className="flex gap-2" onSubmit={add}>
        <input className={field + " min-w-0 flex-1"} aria-label="New todo" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="What needs doing?" maxLength={200} />
        <button type="submit" className={primary}>Add</button>
      </form>
      {error && <p className="text-sm text-red-700" role="alert">{error}</p>}
      {todos.length === 0 ? <p className="text-sm text-neutral-500">Nothing to do yet.</p> : (
        <ul className="divide-y divide-neutral-200 border-y border-neutral-200">
          {todos.map((todo) => (
            <li key={todo.id} className="flex items-center gap-3 py-2">
              <input type="checkbox" className="size-4" checked={todo.done} onChange={() => toggle(todo)} aria-label={"Done: " + todo.title} />
              <span className={todo.done ? "flex-1 break-words text-neutral-400 line-through" : "flex-1 break-words"}>{todo.title}</span>
              <button type="button" className="text-sm text-neutral-500 hover:text-red-700" onClick={() => remove(todo.id)} aria-label={"Delete " + todo.title}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
`;

  /**
   * The walkthrough: a todo list built from the blank starter (examples/web/app), through the calls
   * an agent's tools make (runSql is run_sql, writeFiles write_files, readFiles read_file, listFiles
   * list_files). Actions: { sql } on supabase; { list } and { read: paths } on web, to look first;
   * { write: files } on web; { edit: path, apply(text, step) }, read and then written whole.
   */
  const MIGRATION = "/root/app/supabase/migrations/20261107000000_todos.sql";
  const DEMO = [
    { title: "Create the todos table", say: "On supabase, with run_sql: a todos table, row level security on, and a policy for each thing a signed-in user may do with their own rows.",
      actions: [{ sql: TODOS_SQL }] },
    { title: "Write the app", say: "On web, with write_files: sign-in, then the list (add, tick, delete), styled with Tailwind; and the migration beside it.",
      actions: [
        { list: true },
        { read: ["/root/app/src/App.jsx", "/root/app/src/supabase.js"] },
        { write: [{ path: "/root/app/src/App.jsx", content: TODO_APP }, { path: MIGRATION, content: TODOS_SQL }] },
      ] },
    { title: "Add a filter and Clear completed", say: "All, Active and Done, a count of what is left, and a button that deletes every done todo.",
      actions: [
        { edit: "/root/app/src/App.jsx", apply: (t, step) => {
          t = replaceOnce(t, `  const [title, setTitle] = useState("");\n`, `  const [title, setTitle] = useState("");\n  const [filter, setFilter] = useState("all");\n`, step);
          t = replaceOnce(t, `  return (\n    <section className="grid gap-4">`, `  async function clearCompleted() {
    const { error } = await supabase.from("todos").delete().eq("done", true);
    if (error) return setError(error.message);
    load();
  }

  const shown = todos.filter((todo) => filter === "all" || (filter === "done") === todo.done);
  const left = todos.filter((todo) => !todo.done).length;

  return (\n    <section className="grid gap-4">`, step);
          t = replaceOnce(t, `{todos.length === 0 ? <p className="text-sm text-neutral-500">Nothing to do yet.</p> : (`,
            `{shown.length === 0 ? <p className="text-sm text-neutral-500">{todos.length === 0 ? "Nothing to do yet." : "Nothing " + filter + "."}</p> : (`, step);
          t = replaceOnce(t, `{todos.map((todo) =>`, `{shown.map((todo) =>`, step);
          return replaceOnce(t, `        </ul>\n      )}\n    </section>`, `        </ul>
      )}
      {todos.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-neutral-500">{left} left</span>
          <div className="ml-auto flex gap-1" role="group" aria-label="Show">
            {["all", "active", "done"].map((f) => (
              <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)}
                className="rounded-full px-3 py-1 text-neutral-600 aria-pressed:bg-neutral-900 aria-pressed:text-white">
                {f[0].toUpperCase() + f.slice(1)}
              </button>
            ))}
          </div>
          <button type="button" className="text-neutral-500 hover:text-neutral-900 disabled:opacity-40" onClick={clearCompleted} disabled={left === todos.length}>
            Clear completed
          </button>
        </div>
      )}
    </section>`, step);
        } },
      ] },
  ];

  /**
   * Play the walkthrough on `agent` (the page's API, source "walkthrough"): open web's preview,
   * then each step's actions, waiting for each to end (and for web's rebuild after a step that
   * wrote its files) before the next. `say(text)` narrates; `waitBuild()` resolves once the preview
   * has a new build (or gives up); `pause(ms)`; `signal` stops it between actions.
   */
  async function playDemo(agent, { say, waitBuild, pause = (ms) => new Promise((r) => setTimeout(r, ms)), signal, steps = DEMO } = {}) {
    const opts = { source: "walkthrough" };
    const stopped = () => { if (signal?.aborted) throw Object.assign(new Error("the walkthrough was stopped"), { name: "AbortError" }); };
    const finish = async (jobId) => {
      for (;;) {
        const v = await agent.readJob(jobId);
        if (v.state !== "running") {
          if (v.state !== "exited" || v.exitStatus !== 0) throw new Error(`${v.runtime}: the command ${v.state === "exited" ? `exited ${v.exitStatus}` : v.state}${v.error ? `: ${v.error}` : ""}`);
          return v;
        }
        await pause(400);
      }
    };
    say("Opening web's page in the preview: the blank starter, served on port 4173 and rebuilt on every change…");
    const p = await agent.openPreview({ runtime: "web", port: 4173, path: "/" }, opts);
    if (p.error) {
      say("Starting web's server first…");
      await finish((await agent.runCommand({ runtime: "web", command: "cd /root/app && (serve --watch dist 4173 >/tmp/serve.log 2>&1 &) && sleep 5" }, opts)).jobId);
      await agent.openPreview({ runtime: "web", port: 4173, path: "/" }, opts);
    }
    for (const [i, step] of steps.entries()) {
      stopped();
      await pause(1500);
      say(`Step ${i + 1} of ${steps.length}: ${step.title}. ${step.say}`);
      let web = false;
      for (const a of step.actions) {
        stopped();
        if (a.sql) {
          const r = await agent.runSql({ runtime: "supabase", sql: a.sql }, opts);
          if (r.state !== "exited" || r.exitStatus !== 0) {
            throw new Error(`supabase: the SQL ${r.state === "exited" ? `exited ${r.exitStatus}` : r.state}${r.output?.trim() ? `: ${r.output.trim().split("\n").at(-1)}` : r.error ? `: ${r.error}` : ""}`);
          }
        } else if (a.list) {
          await agent.listFiles({ runtime: "web" }, opts);
        } else if (a.read) {
          await agent.readFiles({ runtime: "web", paths: a.read }, opts);
        } else if (a.write) {
          await agent.writeFiles({ runtime: "web", files: a.write }, opts);
          web = true;
        } else if (a.edit) {
          const [f] = await agent.readFiles({ runtime: "web", paths: [a.edit] }, opts);
          if (typeof f?.text !== "string") throw new Error(`${step.title}: ${a.edit} could not be read${f?.error ? `: ${f.error}` : ""}`);
          await agent.writeFiles({ runtime: "web", files: [{ path: a.edit, content: a.apply(f.text, step.title) }] }, opts);
          web = true;
        } else if (a.run) {
          await finish((await agent.runCommand({ runtime: a.run, command: a.command }, opts)).jobId);
          web ||= a.run === "web";
        }
      }
      if (web) await waitBuild?.();
    }
    say("Done: a todo list on Supabase, built from the blank starter. Sign up in the preview to try it; each user sees only their own todos.");
  }

  // ---------------------------------------------------------------- the feed

  const MAX_ENTRIES = 60;
  const BY = { webmcp: "WebMCP", script: "a script", form: "the form", walkthrough: "the walkthrough" };
  const by = (source) => BY[source] ?? source;
  const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const kib = (n) => n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB`;

  function verdict(e) {
    // A note is a line of narration, not a job: it has no outcome to badge
    if (e.kind === "note" || e.state == null) return null;
    switch (e.state) {
      case "running": return { text: "running", tone: "live" };
      case "exited": return { text: `exit ${e.exitStatus}`, tone: e.exitStatus === 0 ? "ok" : "bad" };
      case "timed_out": return { text: "timed out", tone: "bad" };
      case "cancelled": return { text: "cancelled", tone: "bad" };
      case "ok": return { text: "built", tone: "ok" };
      case "error": return { text: "build failed", tone: "bad" };
      case "info": return null;
      default: return { text: "failed", tone: "bad" };
    }
  }

  const secsText = (ms) => ms == null ? "" : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

  /** What a set of changes did, as a step's title: "Edited src/App.jsx", "Changed 3 files". */
  function changesTitle(c) {
    if (!c?.files.length) return null;
    if (c.files.length === 1) {
      const f = c.files[0];
      return `${f.status === "added" ? "Created" : f.status === "deleted" ? "Deleted" : "Edited"} ${f.path}`;
    }
    return `Changed ${c.files.length}${c.more ? "+" : ""} files`;
  }

  /**
   * A feed entry as a step of the agent's conversation: { step, title, code } (step: edit, run,
   * sql, undo, copy, build, build-error, read, list, preview, note; code: whether the command is
   * worth showing under the title).
   */
  function stepOf(e) {
    const cmd = e.command ?? "";
    switch (e.kind) {
      case "note": return { step: "note", title: e.text ?? "" };
      case "preview": return { step: "preview", title: e.text ?? "The preview" };
      case "build": return e.state === "error"
        ? { step: "build-error", title: `Build ${e.version ?? ""} failed`.replace("  ", " ") }
        : { step: "build", title: `Built version ${e.version ?? "?"}${e.ms != null ? ` in ${secsText(e.ms)}` : ""}` };
      case "read": {
        const n = e.paths?.length ?? 0;
        return { step: "read", title: n === 1 ? `Read ${e.paths[0]}` : `Read ${n} files` };
      }
      case "list": return { step: "list", title: `Looked at the files in ${e.path ?? "the project"}` };
      default: break;
    }
    if (cmd === "undo the last change") return { step: "undo", title: "Undid the last change" };
    if (cmd === "revert the project to how it began") return { step: "undo", title: "Reverted the app to the starter" };
    if (/^write /.test(cmd)) return { step: "edit", title: changesTitle(e.changes) ?? (e.state === "running" ? "Writing files…" : "Wrote files: nothing changed") };
    if (/^SQL: /.test(cmd)) return { step: "sql", title: `Ran SQL on ${e.runtime ?? "the database"}`, code: true };
    if (/^copy /.test(cmd)) return { step: "copy", title: "Copied a file", code: true };
    const one = cmd.split("\n")[0];
    return { step: "run", title: one.length <= 48 && !cmd.includes("\n") ? `Ran ${one}` : `Ran a command in ${e.runtime ?? "a machine"}`, code: !(one.length <= 48 && !cmd.includes("\n")) || !!e.changes?.files.length };
  }

  /**
   * The feed, drawn in `list` (an <ol>): entries newest first, each drawn again only when it
   * changes, so an open diff stays open. An entry: { kind: "run" | "build" | "preview" | "note",
   * runtime, source, command, state, exitStatus, error, changes, text, at }.
   */
  class Feed {
    constructor(list, { doc = root.document, empty, onchange } = {}) {
      this.list = list;
      this.doc = doc;
      this.empty = empty;
      this.onchange = onchange;
      this.entries = [];
      this.els = new Map();
      this.filter = "";
    }

    add(entry) {
      entry.at ??= Date.now();
      this.entries.unshift(entry);
      const li = this.doc.createElement("li");
      this.els.set(entry, li);
      this.list.prepend(li);
      while (this.entries.length > MAX_ENTRIES) {
        const old = this.entries.pop();
        this.els.get(old)?.remove();
        this.els.delete(old);
      }
      this.draw(entry);
      return entry;
    }

    update(entry, patch = {}) {
      Object.assign(entry, patch);
      if (this.els.has(entry)) this.draw(entry);
      return entry;
    }

    setFilter(runtime) {
      this.filter = runtime ?? "";
      for (const e of this.entries) this.els.get(e).hidden = !this.shows(e);
      this._empty();
    }

    shows(e) { return !this.filter || !e.runtime || e.runtime === this.filter; }

    clear() {
      this.entries = [];
      this.els.clear();
      this.list.replaceChildren();
      this._empty();
    }

    _empty() {
      if (this.empty) this.empty.hidden = this.entries.some((e) => this.shows(e));
    }

    draw(e) {
      const d = this.doc;
      const li = this.els.get(e);
      const el = (tag, cls, text) => {
        const x = d.createElement(tag);
        if (cls) x.className = cls;
        if (text !== undefined) x.textContent = text;
        return x;
      };
      li.className = "ev";
      li.dataset.kind = e.kind;
      const st = stepOf(e);
      li.dataset.step = st.step;
      li.dataset.state = e.state ?? "";
      if (e.runtime) li.dataset.runtime = e.runtime;
      li.hidden = !this.shows(e);
      const title = el("p", "ev-title", st.title);
      const head = el("div", "ev-head");
      const who = [e.runtime, e.source ? `by ${by(e.source)}` : null].filter(Boolean).join(", ");
      if (who) head.append(el("span", "tag", who));
      const v = verdict(e);
      if (v) {
        const b = el("span", "badge", v.text);
        b.dataset.tone = v.tone;
        head.append(b);
      }
      const t = el("time", "run-time", clock(e.at));
      t.dateTime = new Date(e.at).toISOString();
      head.append(t);
      const parts = [title, head];
      if (e.command && st.code) parts.push(el("code", "ev-cmd", e.command.length > 600 ? e.command.slice(0, 600) + "…" : e.command));
      if (e.text && e.kind !== "note" && e.kind !== "preview") parts.push(el("p", "ev-text", e.text));
      if (e.error && e.kind === "build") {
        const pre = el("pre", "diff ev-error", e.error);
        pre.tabIndex = 0;
        pre.setAttribute("aria-label", `Build error in ${e.runtime}`);
        parts.push(pre);
      } else if (e.error && e.state !== "exited") {
        parts.push(el("p", "ev-text", e.error));
      }
      if (e.changes) parts.push(this._changes(e, el));
      li.replaceChildren(...parts);
      this._empty();
      this.onchange?.(e);
    }

    _changes(e, el) {
      const c = e.changes;
      if (!c.files.length) return el("p", "ev-text ev-none", "No files changed in " + (e.watch ?? "its project") + ".");
      const box = el("div", "ev-files");
      box.append(el("p", "ev-text", c.files.length === 1 ? "Changed 1 file" : `Changed ${c.files.length}${c.more ? "+" : ""} files`));
      const ul = el("ul", "files");
      e.open ??= new Set(e === this.entries[0] ? [c.files[0].path] : []);
      for (const f of c.files) {
        const li = el("li");
        const det = el("details");
        det.open = e.open.has(f.path);
        det.addEventListener("toggle", () => { if (det.open) e.open.add(f.path); else e.open.delete(f.path); });
        const sum = el("summary");
        const st = el("span", "st", f.status);
        st.dataset.status = f.status;
        sum.append(st, el("span", "path", f.path));
        if (f.status === "modified" || f.added || f.removed) sum.append(el("span", "counts", `+${f.added} −${f.removed}`));
        det.append(sum);
        if (f.big) det.append(el("p", "ev-text", `${kib(f.big)}: too large to show a diff.`));
        else if (f.binary) det.append(el("p", "ev-text", "A binary file."));
        else {
          const pre = el("pre", "diff");
          pre.tabIndex = 0;
          pre.setAttribute("aria-label", `Changes to ${f.path}`);
          for (const line of diffLines(f.diff)) {
            const span = el("span", "dl", line.text + "\n");
            span.dataset.kind = line.kind;
            pre.append(span);
          }
          if (f.cut) pre.append(el("span", "dl", `… ${f.cut} more lines\n`));
          det.append(pre);
        }
        li.append(det);
        ul.append(li);
      }
      box.append(ul);
      if (c.more) box.append(el("p", "ev-text", `More than ${MAX_FILES} files changed; the first ${MAX_FILES} are listed.`));
      return box;
    }
  }

  const SnowglobeBuilder = { stepOf, changesTitle, wrapCommand, revertCommand, listCommand, parseList, readCommand, parseRead, writeFilesCommand, checkFilePath, splitChanges, parseChanges, diffLines, summary, snapshotDir, checkWatch, BuildWatch, Feed,
    DEMO, TODOS_SQL, TODO_APP, playDemo, replaceOnce, limits: { MAX_FILES, MAX_LINES, MAX_DIFF_BYTES, HISTORY, MAX_LIST, MAX_READ_FILE, MAX_READ_TOTAL, MAX_READ_PATHS, MAX_WRITE_FILES, MAX_WRITE_TOTAL } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeBuilder;
  else root.SnowglobeBuilder = SnowglobeBuilder;
})(typeof window !== "undefined" ? window : globalThis);
