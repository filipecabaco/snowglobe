// Files in and out of a machine, over the only channel a page has into its guest today: the serial
// job runner (agent.js). It is text, line by line, so files go as base64:
//  - read: one job prints the file's size and sha256; then one job per slice prints that slice as
//    base64 between two frame lines; the page decodes each slice into bytes as it arrives, keeps
//    them as a Blob, and checks the sha256 of the whole against the header;
//  - write: one job per slice takes the slice as a job file (its workspace's in/, typed in as
//    base64 and decoded by the guest) and appends it to a temporary file; a last job checks the
//    temporary file's sha256 against the page's, and only then moves it into place.
// Binary-safe, checked on both ends, cancellable between and during jobs, and at most MAX_BYTES a
// file. The interface is read(path) and write(path, blob) on a machine: a faster host-to-guest
// channel can replace the job runner under it without changing the callers.
(function (root) {
  "use strict";

  const MAX_BYTES = 8 << 20;
  // Raw bytes per job: a read slice as base64 stays under the job's 1 MiB of output; a write slice
  // stays well under a job's 4 MiB of files
  const READ_SLICE = 512 << 10;
  const WRITE_SLICE = 128 << 10; // also how often a write says how far it got

  const quote = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

  function checkPath(path, what = "path") {
    if (typeof path !== "string" || !path.trim()) throw new Error(`${what}: a file path in the machine`);
    if (path.length > 4096) throw new Error(`${what}: at most 4096 characters`);
    if (/[\0\n\r]/.test(path)) throw new Error(`${what}: no NUL or line breaks`);
    if (path.endsWith("/")) throw new Error(`${what}: a file, not a directory`);
    return path;
  }

  /** The job that says what a file is: SGXFER_HEAD <size> <sha256>, SGXFER_BIG <size> (over
   *  `maxBytes`: its size is checked before anything reads it whole), or SGXFER_ERR <why>. */
  function headerCommand(path, maxBytes = MAX_BYTES) {
    return `f=${quote(path)}\n` +
      `if [ ! -e "$f" ]; then echo "SGXFER_ERR no such file"; exit 0; fi\n` +
      `if [ ! -f "$f" ]; then echo "SGXFER_ERR not a regular file"; exit 0; fi\n` +
      `if [ ! -r "$f" ]; then echo "SGXFER_ERR not readable"; exit 0; fi\n` +
      `s=$(wc -c <"$f") || { echo "SGXFER_ERR could not read it"; exit 0; }\n` +
      `s=$((s + 0))\n` +
      `if [ "$s" -gt ${Math.floor(maxBytes)} ]; then echo "SGXFER_BIG $s"; exit 0; fi\n` +
      `h=$(sha256sum <"$f") || { echo "SGXFER_ERR could not read it"; exit 0; }\n` +
      `echo "SGXFER_HEAD $s \${h%% *}"\n`;
  }

  function parseHeader(output, maxBytes = MAX_BYTES) {
    const err = /SGXFER_ERR ([^\n]*)/.exec(output);
    if (err) throw new Error(err[1].trim());
    const big = /SGXFER_BIG\s+(\d+)/.exec(output);
    if (big) throw new Error(`the file is ${big[1]} bytes; files of at most ${maxBytes} bytes (${maxBytes >> 20} MiB) are copied`);
    const m = /SGXFER_HEAD\s+(\d+)\s+([0-9a-f]{64})/.exec(output);
    if (!m) throw new Error("the machine did not say what the file is");
    return { size: Number(m[1]), sha256: m[2] };
  }

  /** The job that prints slice `index` (of `slice` bytes) of a file, base64 between two frame lines. */
  function sliceCommand(path, index, slice = READ_SLICE) {
    return `f=${quote(path)}\n` +
      `printf 'SGXFER_CHUNK %s\\n' ${index}\n` +
      `dd if="$f" bs=${slice} skip=${index} count=1 2>/dev/null | base64 | tr -d '\\n'\n` +
      `printf '\\nSGXFER_END %s\\n' ${index}\n`;
  }

  function fromBase64(text) {
    const s = atob(text);
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
    return bytes;
  }

  /** Slice `index`'s bytes, out of what its job printed: only between its own two frame lines. */
  function parseSlice(output, index) {
    const begin = `SGXFER_CHUNK ${index}\n`;
    const at = output.indexOf(begin);
    if (at === -1) throw new Error(`slice ${index}: no start frame`);
    const from = at + begin.length;
    const end = output.indexOf(`\nSGXFER_END ${index}`, from);
    if (end === -1) throw new Error(`slice ${index}: no end frame`);
    const b64 = output.slice(from, end).replace(/\r/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw new Error(`slice ${index}: not base64`);
    return fromBase64(b64);
  }

  /** The job that appends its in/c to the temporary file (the first one starts it). */
  function writeSliceCommand(tmp, index) {
    return `cat "$EXCLAVE_WORKSPACE/in/c" >${index === 0 ? "" : ">"}${quote(tmp)} && echo SGXFER_OK ${index}\n`;
  }

  /** The last job of a write: the temporary file's sha256 checked, then moved into place. */
  function finishCommand(tmp, path, sha256) {
    return `t=${quote(tmp)}; f=${quote(path)}\n` +
      `[ -e "$t" ] || : >"$t"\n` +
      `h=$(sha256sum <"$t"); h=\${h%% *}\n` +
      `if [ "$h" != ${quote(sha256)} ]; then rm -f -- "$t"; echo "SGXFER_BAD $h"; exit 0; fi\n` +
      `d=$(dirname -- "$f"); mkdir -p -- "$d" && mv -f -- "$t" "$f" || { rm -f -- "$t"; echo "SGXFER_ERR could not move it into place"; exit 0; }\n` +
      `s=$(wc -c <"$f"); echo "SGXFER_DONE $s $h"\n`;
  }

  function parseFinish(output) {
    const bad = /SGXFER_BAD ([0-9a-f]*)/.exec(output);
    if (bad) throw new Error(`the copy in the machine has sha256 ${bad[1] || "(none)"}, not the file's: nothing was written`);
    const err = /SGXFER_ERR ([^\n]*)/.exec(output);
    if (err) throw new Error(err[1].trim());
    const m = /SGXFER_DONE\s+(\d+)\s+([0-9a-f]{64})/.exec(output);
    if (!m) throw new Error("the machine did not confirm the file");
    return { size: Number(m[1]), sha256: m[2] };
  }

  async function sha256(blob) {
    const data = blob instanceof Uint8Array ? blob : await blob.arrayBuffer();
    const hash = await (root.crypto ?? globalThis.crypto).subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
  }

  function aborted() {
    const e = new Error("cancelled");
    e.name = "AbortError";
    return e;
  }

  /**
   * Read and write files of one machine through `run(command, { files, signal })`, which runs a
   * job to its end and resolves to its view (agent.js), rejecting if it did not exit 0.
   */
  function overJobs(run, { maxBytes = MAX_BYTES, readSlice = READ_SLICE, writeSlice = WRITE_SLICE, token } = {}) {
    const tmpName = () => `/tmp/.sgxfer.${token ? token() : Math.random().toString(16).slice(2)}`;
    return {
      maxBytes,
      /** { blob, size, sha256 }: the file's bytes, checked against the machine's sha256. */
      async read(path, { signal, onProgress } = {}) {
        checkPath(path);
        if (signal?.aborted) throw aborted();
        const head = parseHeader((await run(headerCommand(path, maxBytes), { signal })).output, maxBytes);
        if (head.size > maxBytes) throw new Error(`${path} is ${head.size} bytes; files of at most ${maxBytes} bytes (${maxBytes >> 20} MiB) are copied`);
        const parts = [];
        let done = 0;
        onProgress?.({ phase: "read", done, total: head.size });
        for (let i = 0; done < head.size; i++) {
          if (signal?.aborted) throw aborted();
          const bytes = parseSlice((await run(sliceCommand(path, i, readSlice), { signal })).output, i);
          const want = Math.min(readSlice, head.size - done);
          if (bytes.length !== want) throw new Error(`slice ${i}: ${bytes.length} bytes, not ${want} (did the file change?)`);
          parts.push(bytes);
          done += bytes.length;
          onProgress?.({ phase: "read", done, total: head.size });
        }
        const blob = new Blob(parts);
        const sum = await sha256(blob);
        if (sum !== head.sha256) throw new Error(`what was read has sha256 ${sum}, the machine's file ${head.sha256} (did it change?)`);
        return { blob, size: head.size, sha256: sum };
      },
      /** { size, sha256 }: the file written at `path`, its sha256 checked in the machine before
       *  it replaced anything there. */
      async write(path, blob, { signal, onProgress, sha256: expected } = {}) {
        checkPath(path);
        if (!(blob instanceof Blob)) blob = new Blob([blob]);
        if (blob.size > maxBytes) throw new Error(`${blob.size} bytes; files of at most ${maxBytes} bytes (${maxBytes >> 20} MiB) are copied`);
        const sum = expected ?? await sha256(blob);
        const tmp = tmpName();
        let done = 0;
        onProgress?.({ phase: "write", done, total: blob.size });
        try {
          for (let i = 0; done < blob.size; i++) {
            if (signal?.aborted) throw aborted();
            const bytes = new Uint8Array(await blob.slice(done, done + writeSlice).arrayBuffer());
            await run(writeSliceCommand(tmp, i), { files: { c: bytes }, signal });
            done += bytes.length;
            onProgress?.({ phase: "write", done, total: blob.size });
          }
          if (signal?.aborted) throw aborted();
          const r = parseFinish((await run(finishCommand(tmp, path, sum), { signal })).output);
          if (r.sha256 !== sum || r.size !== blob.size) throw new Error(`the machine has ${r.size} bytes with sha256 ${r.sha256}, not ${blob.size} with ${sum}`);
          return r;
        } catch (e) {
          // Nothing half-written left behind (the target was never touched)
          try { await run(`rm -f -- ${quote(tmp)}\n`, {}); } catch {}
          throw e;
        }
      },
    };
  }

  const SnowglobeTransfer = { overJobs, headerCommand, parseHeader, sliceCommand, parseSlice, writeSliceCommand, finishCommand,
    parseFinish, checkPath, sha256, fromBase64, limits: { MAX_BYTES, READ_SLICE, WRITE_SLICE } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeTransfer;
  else root.SnowglobeTransfer = SnowglobeTransfer;
})(typeof window !== "undefined" ? window : globalThis);
