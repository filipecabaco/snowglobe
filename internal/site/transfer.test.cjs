// Files in and out of a machine over its job runner (transfer.js): the framing, the checksums, and
// read/write against a stand-in guest that answers each job as the real one's shell would
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const T = require('./transfer.js');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const unquote = (s) => s.replace(/'\\''/g, "'");

// A guest: a filesystem, and the jobs transfer.js sends it, answered by what they print
function guest({ corrupt } = {}) {
  const fs = new Map();
  const ran = [];
  const run = async (command, { files, signal } = {}) => {
    ran.push(command);
    if (signal?.aborted) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
    let m;
    const out = (output, exitStatus = 0) => {
      if (exitStatus !== 0) throw new Error(`exited ${exitStatus}: ${output}`);
      return { state: 'exited', exitStatus, output };
    };
    if ((m = /^f='((?:[^']|'\\'')*)'\nif \[ ! -e/.exec(command))) {
      const f = fs.get(unquote(m[1]));
      if (!f) return out('SGXFER_ERR no such file\n');
      const max = Number(/-gt (\d+)/.exec(command)[1]);
      if (f.length > max) return out(`SGXFER_BIG ${f.length}\n`);
      return out(`SGXFER_HEAD ${f.length} ${sha(f)}\n`);
    }
    if ((m = /^f='((?:[^']|'\\'')*)'\nprintf 'SGXFER_CHUNK %s\\n' (\d+)\ndd if="\$f" bs=(\d+) skip=(\d+)/.exec(command))) {
      const f = fs.get(unquote(m[1]));
      const bs = Number(m[3]), i = Number(m[4]);
      let slice = Buffer.from(f.subarray(i * bs, (i + 1) * bs));
      if (corrupt === i) slice[0] ^= 1;
      return out(`SGXFER_CHUNK ${i}\n${slice.toString('base64')}\nSGXFER_END ${i}\n`);
    }
    if ((m = /^cat "\$EXCLAVE_WORKSPACE\/in\/c" >(>?)'((?:[^']|'\\'')*)' && echo SGXFER_OK (\d+)\n$/.exec(command))) {
      const tmp = unquote(m[2]);
      const prev = m[1] ? fs.get(tmp) ?? Buffer.alloc(0) : Buffer.alloc(0);
      fs.set(tmp, Buffer.concat([prev, Buffer.from(files.c)]));
      return out(`SGXFER_OK ${m[3]}\n`);
    }
    if ((m = /^t='((?:[^']|'\\'')*)'; f='((?:[^']|'\\'')*)'\n[\s\S]*if \[ "\$h" != '([0-9a-f]+)' \]/.exec(command))) {
      const tmp = unquote(m[1]), f = unquote(m[2]);
      const data = fs.get(tmp) ?? Buffer.alloc(0);
      if (sha(data) !== m[3]) { fs.delete(tmp); return out(`SGXFER_BAD ${sha(data)}\n`); }
      fs.set(f, data);
      fs.delete(tmp);
      return out(`SGXFER_DONE ${data.length} ${sha(data)}\n`);
    }
    if ((m = /^rm -f -- '((?:[^']|'\\'')*)'\n$/.exec(command))) { fs.delete(unquote(m[1])); return out(''); }
    throw new Error(`unexpected job: ${command}`);
  };
  return { fs, ran, run };
}

const every = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

test('framing: the header, a slice between its own frame lines, and what finishing says', () => {
  assert.deepEqual(T.parseHeader('noise\nSGXFER_HEAD   300 ' + 'a'.repeat(64) + '\n'), { size: 300, sha256: 'a'.repeat(64) });
  assert.throws(() => T.parseHeader('SGXFER_ERR no such file\n'), /no such file/);
  assert.throws(() => T.parseHeader('nothing'), /did not say/);
  const b64 = every.toString('base64');
  assert.deepEqual(Buffer.from(T.parseSlice(`SGXFER_CHUNK 3\n${b64}\nSGXFER_END 3\n`, 3)), every);
  assert.throws(() => T.parseSlice(`SGXFER_CHUNK 2\n${b64}\nSGXFER_END 2\n`, 3), /no start frame/);
  assert.throws(() => T.parseSlice(`SGXFER_CHUNK 3\n${b64}`, 3), /no end frame/);
  assert.throws(() => T.parseSlice(`SGXFER_CHUNK 3\nnot base64!\nSGXFER_END 3\n`, 3), /not base64/);
  assert.throws(() => T.parseFinish('SGXFER_BAD ' + 'b'.repeat(64)), /nothing was written/);
  assert.deepEqual(T.parseFinish('SGXFER_DONE 4 ' + 'c'.repeat(64)), { size: 4, sha256: 'c'.repeat(64) });
  for (const bad of ['', '  ', 'a\nb', 'x\0', 'dir/', 'x'.repeat(4097)]) assert.throws(() => T.checkPath(bad));
  // Paths go in single-quoted, whatever they hold
  assert.match(T.headerCommand("/root/it's $(rm -rf /).csv"), /^f='\/root\/it'\\''s \$\(rm -rf \/\)\.csv'\n/);
});

test('the checksum is SHA-256 of the bytes, binary-safe', async () => {
  assert.equal(await T.sha256(new Blob([every])), sha(every));
  assert.equal(await T.sha256(new Uint8Array(0)), sha(Buffer.alloc(0)));
});

test('a binary file read and written in slices, and checked on both ends', async () => {
  const g = guest();
  const data = Buffer.concat(Array.from({ length: 40 }, () => every)); // 10240 bytes, every byte value
  g.fs.set('/root/b.bin', data);
  const files = T.overJobs(g.run, { readSlice: 3000, writeSlice: 4096 });
  const progress = [];
  const r = await files.read('/root/b.bin', { onProgress: (p) => progress.push(`${p.phase} ${p.done}/${p.total}`) });
  assert.equal(r.size, data.length);
  assert.equal(r.sha256, sha(data));
  assert.deepEqual(Buffer.from(await r.blob.arrayBuffer()), data);
  assert.deepEqual(progress, ['read 0/10240', 'read 3000/10240', 'read 6000/10240', 'read 9000/10240', 'read 10240/10240']);

  const w = await files.write("/root/in/it's.bin", r.blob, { sha256: r.sha256 });
  assert.deepEqual(w, { size: data.length, sha256: sha(data) });
  assert.deepEqual(g.fs.get("/root/in/it's.bin"), data);
  assert.equal([...g.fs.keys()].filter((k) => k.startsWith('/tmp/')).length, 0, 'no temporary file left');
  // Three slices of at most 4096, each its own job, then the check
  assert.equal(g.ran.filter((c) => c.startsWith('cat ')).length, 3);

  // An empty file too
  g.fs.set('/root/empty', Buffer.alloc(0));
  const e = await files.read('/root/empty');
  assert.equal(e.size, 0);
  assert.deepEqual(await files.write('/root/empty2', e.blob), { size: 0, sha256: sha(Buffer.alloc(0)) });
});

test('a slice that changed on the way is caught by the checksum; nothing lands', async () => {
  const g = guest({ corrupt: 1 });
  g.fs.set('/a', Buffer.alloc(5000, 7));
  await assert.rejects(T.overJobs(g.run, { readSlice: 2000 }).read('/a'), /sha256 .* the machine's file/);
  // Written bytes that don't match the page's checksum are refused in the machine
  const h = guest();
  await assert.rejects(T.overJobs(h.run).write('/b', new Blob([every]), { sha256: 'f'.repeat(64) }), /nothing was written/);
  assert.equal(h.fs.has('/b'), false);
  assert.equal([...h.fs.keys()].length, 0);
});

test('at most 8 MiB, refused before anything moves; cancelled between slices, with the temporary file removed', async () => {
  const g = guest();
  g.fs.set('/big', Buffer.alloc((8 << 20) + 1));
  await assert.rejects(T.overJobs(g.run).read('/big'), /8388609 bytes; files of at most 8388608 bytes \(8 MiB\)/);
  assert.equal(g.ran.length, 1, 'only the header job ran');
  await assert.rejects(T.overJobs(g.run).write('/x', new Blob([new Uint8Array((8 << 20) + 1)])), /at most 8388608/);
  assert.equal(g.ran.length, 1);

  const h = guest();
  const c = new AbortController();
  const files = T.overJobs(h.run, { writeSlice: 100 });
  await assert.rejects(files.write('/y', new Blob([every]), { signal: c.signal, onProgress: (p) => { if (p.done >= 100) c.abort(); } }), { name: 'AbortError' });
  assert.equal(h.fs.has('/y'), false);
  assert.equal([...h.fs.keys()].length, 0, 'the temporary file removed');
  assert.match(h.ran.at(-1), /^rm -f -- '\/tmp\/\.sgxfer\./);
});

// The guest's side of it in a real shell: paths that start with "-" are paths, not options, and a
// file over the limit is refused on its size, before anything hashes it
test('the header and the finishing job, run by sh, with a path that starts with "-"', { skip: !require('node:child_process').spawnSync('sh', ['-c', 'command -v sha256sum']).stdout.length }, () => {
  const { execFileSync } = require('node:child_process');
  const os = require('node:os');
  const path = require('node:path');
  const nfs = require('node:fs');
  const dir = nfs.mkdtempSync(path.join(os.tmpdir(), 'sgxfer-'));
  try {
    const sh = (cmd) => execFileSync('sh', ['-c', cmd], { cwd: dir, encoding: 'utf8' });
    nfs.writeFileSync(path.join(dir, '-data.csv'), 'a,b\n1,2\n');
    assert.deepEqual(T.parseHeader(sh(T.headerCommand('-data.csv'))), { size: 8, sha256: sha('a,b\n1,2\n') });
    assert.throws(() => T.parseHeader(sh(T.headerCommand('-data.csv', 4)), 4), /the file is 8 bytes; files of at most 4 bytes/);
    assert.doesNotMatch(T.headerCommand('x', 4), /sha256sum[^\n]*\n[^\n]*-gt/, 'the size is checked before the hash');
    nfs.writeFileSync(path.join(dir, '-tmp'), 'xyz');
    const r = T.parseFinish(sh(T.finishCommand('-tmp', '-out/-x.csv', sha('xyz'))));
    assert.deepEqual(r, { size: 3, sha256: sha('xyz') });
    assert.equal(nfs.readFileSync(path.join(dir, '-out', '-x.csv'), 'utf8'), 'xyz');
    assert.equal(nfs.existsSync(path.join(dir, '-tmp')), false);
  } finally {
    nfs.rmSync(dir, { recursive: true, force: true });
  }
});
