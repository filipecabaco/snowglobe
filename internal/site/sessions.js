// Whole-machine checkpoints. Storage commits never replace a valid checkpoint with a partial one.
// No guest filesystem is mapped onto the user's filesystem: folders contain session backups only.
(function (root) {
  "use strict";
  const utf8 = new TextEncoder();
  const text = new TextDecoder("utf-8", { fatal: true });
  const MAGIC = "SNOWGLOBE1\n";
  const identifier = id => {
    if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid session identifier");
    return id;
  };
  const metadata = c => ({ version: c.version, id: c.id, name: c.name, config: c.config,
    savedAt: c.savedAt, encoding: c.encoding });
  function validate(c) {
    identifier(c.id);
    if (c.version !== 1 || typeof c.name !== "string" || !c.name.trim() || c.name.length > 100 ||
        !Number.isSafeInteger(c.savedAt) || c.savedAt < 0 ||
        typeof c.config?.build !== "string" || !c.config.build ||
        !Number.isInteger(c.config.memory) || c.config.memory < 16 || c.config.memory > 3584 ||
        !Number.isInteger(c.config.cpus) || c.config.cpus < 1 || c.config.cpus > 8 ||
        !["none", "fetch"].includes(c.config.network) || !["raw", "gzip"].includes(c.encoding)) {
      throw new Error("Invalid session backup metadata");
    }
  }
  function compatible(c, config) {
    return c.version === 1 && ["build", "memory", "cpus", "network"].every(k => c.config[k] === config[k]);
  }
  async function digest(blob) {
    const hash = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
    return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("");
  }
  // A checkpoint's bytes after its header: the machine's state, the process's (a site with no
  // kernel: armless's user mode, whose program is a process the machine's state doesn't hold), then
  // the console. processBytes is in the header only when there is a process, so a backup of a
  // machine with a kernel is what it always was.
  const sizes = c => ({ stateBytes: c.state.size, ...(c.process ? { processBytes: c.process.size } : {}), consoleBytes: c.console.size });
  async function encodeBackup(c) {
    validate(c);
    const payload = new Blob(c.process ? [c.state, c.process, c.console] : [c.state, c.console]);
    const info = { ...metadata(c), ...sizes(c) };
    const header = utf8.encode(JSON.stringify({ ...info,
      checksum: await digest(new Blob([JSON.stringify(info), payload])) }));
    const length = new Uint8Array(4);
    new DataView(length.buffer).setUint32(0, header.length, true);
    return new Blob([MAGIC, length, header, payload], { type: "application/octet-stream" });
  }
  async function decodeBackup(blob) {
    const prefixSize = MAGIC.length + 4;
    if (blob.size < prefixSize) throw new Error("Truncated session backup");
    const prefix = new Uint8Array(await blob.slice(0, prefixSize).arrayBuffer());
    if (utf8.encode(MAGIC).some((b, i) => prefix[i] !== b)) throw new Error("Not a Snowglobe session backup");
    const size = new DataView(prefix.buffer).getUint32(MAGIC.length, true);
    if (size > 65536 || size < 2 || blob.size < prefixSize + size) throw new Error("Invalid session backup header");
    let h;
    try { h = JSON.parse(text.decode(await blob.slice(prefixSize, prefixSize + size).arrayBuffer())); }
    catch { throw new Error("Invalid session backup metadata"); }
    validate(h);
    const processBytes = h.processBytes ?? 0;
    if (!Number.isSafeInteger(h.stateBytes) || h.stateBytes < 1 ||
        !Number.isSafeInteger(processBytes) || processBytes < 0 || (h.processBytes !== undefined && processBytes < 1) ||
        !Number.isSafeInteger(h.consoleBytes) || h.consoleBytes < 0 ||
        prefixSize + size + h.stateBytes + processBytes + h.consoleBytes !== blob.size) throw new Error("Truncated or invalid session backup");
    const payload = blob.slice(prefixSize + size);
    const info = { ...metadata(h), stateBytes: h.stateBytes, ...(processBytes ? { processBytes } : {}), consoleBytes: h.consoleBytes };
    if (await digest(new Blob([JSON.stringify(info), payload])) !== h.checksum) throw new Error("Session backup checksum mismatch");
    const c = { ...metadata(h), state: payload.slice(0, h.stateBytes), console: payload.slice(h.stateBytes + processBytes) };
    if (processBytes) c.process = payload.slice(h.stateBytes, h.stateBytes + processBytes);
    consoleEvents(await c.console.arrayBuffer());
    return c;
  }
  /** The snapshot as bytes, or as the pieces a machine hands it out in (snapshot()). */
  async function packState(state) {
    const raw = new Blob(Array.isArray(state) ? state : [state]);
    if (typeof CompressionStream === "undefined") return { encoding: "raw", state: raw };
    return { encoding: "gzip", state: await new Response(raw.stream().pipeThrough(new CompressionStream("gzip"))).blob() };
  }
  async function stateBlob(c) {
    if (c.encoding === "raw") return c.state;
    if (typeof DecompressionStream === "undefined") throw new Error("This browser cannot decompress this session");
    return new Response(c.state.stream().pipeThrough(new DecompressionStream("gzip"))).blob();
  }
  async function unpackState(c) { return new Uint8Array(await (await stateBlob(c)).arrayBuffer()); }
  /**
   * A stopped machine's snapshot: its pieces where the machine hands it out so (armless 0.9.6 and
   * on), which packState() takes as they are, so the page never holds it in one buffer as well;
   * else its bytes.
   */
  function snapshot(vm) { return vm.save_state_pieces ? vm.save_state_pieces() : vm.save_state(); }
  /**
   * { state, process }: the stopped machine's snapshot (snapshot()), and with no kernel (armless's
   * user mode, vm.user) its program's process (save_process(): a small buffer), taken in the same
   * stop so the two go together; null with a kernel, whose processes are in the machine's state.
   */
  async function capture(vm, onPaused = () => {}) {
    const running = vm.running;
    try {
      await vm.stop(); // including all SMP workers; host input is gated by the UI during capture
      const state = await snapshot(vm);
      const process = vm.user ? await vm.save_process() : null;
      onPaused();
      return { state, process };
    } finally { if (running) vm.run(); }
  }

  // Raw console bytes and resize events are replayed in order. No lossy text/color conversion.
  function consoleRecord(bytes) {
    const header = new Uint8Array(5);
    new DataView(header.buffer).setUint32(1, bytes.length, true);
    return new Blob([header, bytes]);
  }
  function resizeRecord(cols, rows) {
    if (![cols, rows].every(n => Number.isInteger(n) && n > 0 && n <= 65535)) throw new Error("Invalid terminal size");
    const record = new Uint8Array(5);
    const view = new DataView(record.buffer);
    record[0] = 1;
    view.setUint16(1, cols, true);
    view.setUint16(3, rows, true);
    return new Blob([record]);
  }
  function consoleEvents(buffer) {
    const view = new DataView(buffer);
    const events = [];
    for (let p = 0; p < buffer.byteLength;) {
      if (p + 5 > buffer.byteLength) throw new Error("Truncated console recording");
      const type = view.getUint8(p);
      if (type === 0) {
        const n = view.getUint32(p + 1, true);
        if (n > buffer.byteLength - p - 5) throw new Error("Truncated console recording");
        events.push({ bytes: new Uint8Array(buffer, p + 5, n) });
        p += 5 + n;
      } else if (type === 1) {
        const cols = view.getUint16(p + 1, true), rows = view.getUint16(p + 3, true);
        if (!cols || !rows) throw new Error("Invalid console recording size");
        events.push({ cols, rows });
        p += 5;
      } else throw new Error("Invalid console recording event");
    }
    return events;
  }

  const request = r => new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const committed = tx => new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted"));
    tx.onerror = () => {}; // abort is the definitive failure; never report success on request completion
  });
  class BrowserStore {
    constructor(db, scope) { this.db = db; this.scope = scope; }
    static async open(scope) {
      const r = indexedDB.open("snowglobe-sessions-v1", 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore("checkpoints", { keyPath: ["scope", "id"] }).createIndex("scope", "scope");
        r.result.createObjectStore("settings");
      };
      const db = await request(r);
      db.onversionchange = () => db.close();
      return new BrowserStore(db, scope);
    }
    async get(id) {
      identifier(id);
      const tx = this.db.transaction("checkpoints");
      return (await request(tx.objectStore("checkpoints").get([this.scope, id])))?.checkpoint ?? null;
    }
    async list() {
      const tx = this.db.transaction("checkpoints");
      const entries = await request(tx.objectStore("checkpoints").index("scope").getAll(this.scope));
      return entries.map(e => metadata(e.checkpoint));
    }
    async put(c) {
      validate(c);
      const tx = this.db.transaction("checkpoints", "readwrite");
      const done = committed(tx);
      tx.objectStore("checkpoints").put({ scope: this.scope, id: c.id, checkpoint: c });
      await done;
    }
    async remove(id) {
      identifier(id);
      const tx = this.db.transaction("checkpoints", "readwrite");
      const done = committed(tx);
      tx.objectStore("checkpoints").delete([this.scope, id]);
      await done;
    }
    async settings(value) {
      const tx = this.db.transaction("settings", value === undefined ? "readonly" : "readwrite");
      if (value === undefined) return await request(tx.objectStore("settings").get(this.scope)) ?? {};
      const done = committed(tx);
      tx.objectStore("settings").put(value, this.scope);
      await done;
    }
  }

  class FolderStore {
    constructor(directory) { this.directory = directory; }
    async generations(id) {
      identifier(id);
      const valid = [];
      let corrupt = false;
      for (const slot of ["a", "b"]) {
        let file;
        try { file = await (await this.directory.getFileHandle(`${id}.${slot}.snowglobe`)).getFile(); }
        catch (e) { if (e.name === "NotFoundError") continue; throw e; }
        try {
          const checkpoint = await decodeBackup(file);
          if (checkpoint.id !== id) throw new Error("Session identifier mismatch");
          valid.push({ slot, checkpoint });
        } catch { corrupt = true; }
      }
      if (!valid.length && corrupt) {
        const error = new Error("No valid checkpoint in folder; keep the files for recovery or import a backup");
        error.name = "CorruptCheckpointError";
        throw error;
      }
      return valid.sort((a, b) => b.checkpoint.savedAt - a.checkpoint.savedAt);
    }
    async get(id) { return (await this.generations(id))[0]?.checkpoint ?? null; }
    async list() {
      const ids = new Set();
      for await (const [name] of this.directory.entries()) {
        const match = /^([a-zA-Z0-9_-]{1,100})\.[ab]\.snowglobe$/.exec(name);
        if (match) ids.add(match[1]);
      }
      const entries = [];
      // Hashing a checkpoint needs a full binary buffer; bound peak memory to one session.
      for (const id of ids) {
        try { entries.push(metadata(await this.get(id))); }
        catch (e) {
          if (e.name !== "CorruptCheckpointError") throw e;
          entries.push({ version: 1, id, name: `Unreadable session ${id.slice(0, 8)}`, unreadable: true,
            config: { build: "unknown", memory: 16, cpus: 1, network: "none" }, savedAt: 0, encoding: "raw" });
        }
      }
      return entries;
    }
    async put(c) {
      validate(c);
      const latest = (await this.generations(c.id))[0];
      const slot = latest?.slot === "a" ? "b" : "a";
      const blob = await encodeBackup(c);
      const file = await this.directory.getFileHandle(`${c.id}.${slot}.snowglobe`, { create: true });
      let writable;
      try {
        writable = await file.createWritable();
        await writable.write(blob); await writable.close();
      } catch (e) {
        try { await writable?.abort(); } catch {}
        // create:true may have created an empty file before its first successful commit.
        // Only remove our new file when there was no pre-existing generation to preserve.
        if (!latest) { try { await this.directory.removeEntry(`${c.id}.${slot}.snowglobe`); } catch {} }
        throw e;
      }
    }
    async remove(id) {
      identifier(id);
      for (const slot of ["a", "b"]) {
        try { await this.directory.removeEntry(`${id}.${slot}.snowglobe`); }
        catch (e) { if (e.name !== "NotFoundError") throw e; }
      }
    }
  }

  // One writer per demo path, including folder storage. Never silently fall back to unsafe locking.
  async function acquireLock(scope) {
    if (!navigator.locks) throw new Error("Session saving needs a browser with Web Locks; this run is temporary");
    return new Promise((resolve, reject) => {
      const finished = navigator.locks.request(`snowglobe-session:${scope}`, { ifAvailable: true }, lock => {
        if (!lock) { reject(new Error("Another tab owns these sessions. Close that tab and reload to save here.")); return; }
        return new Promise(release => resolve(() => { release(); return finished; }));
      });
      finished.catch(reject);
    });
  }

  const api = { BrowserStore, FolderStore, acquireLock, compatible, capture, snapshot, packState, unpackState,
    encodeBackup, decodeBackup, stateBlob, consoleRecord, resizeRecord, consoleEvents, metadata, digest };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.SnowglobeSessions = api;
})(globalThis);
