const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const available = fs.existsSync(path.join(__dirname, 'sessions.js'));
const S = available ? require('./sessions.js') : {};

test('the browser checkpoint implementation is shipped', () => assert.ok(available));
const check = (name, fn) => test(name, { skip: !available }, fn);
const config = { build: 'build-a', memory: 512, cpus: 2, network: 'none' };
const checkpoint = () => ({ version: 1, id: 'one', name: 'My session', config, savedAt: 1000,
  encoding: 'raw', state: new Blob([new Uint8Array([1, 2, 3])]),
  console: new Blob([S.consoleRecord(new Uint8Array([27, 91, 50, 74])), S.resizeRecord(90, 30)]) });

check('checkpoint backup round trips binary state and raw terminal events', async () => {
  const original = checkpoint();
  const result = await S.decodeBackup(await S.encodeBackup(original));
  assert.deepEqual(result.config, config);
  assert.equal(result.name, original.name);
  assert.deepEqual(new Uint8Array(await result.state.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(S.consoleEvents(await result.console.arrayBuffer()), [
    { bytes: new Uint8Array([27, 91, 50, 74]) }, { cols: 90, rows: 30 },
  ]);
});
check('truncated and corrupt backups cannot replace a valid checkpoint', async () => {
  const bytes = new Uint8Array(await (await S.encodeBackup(checkpoint())).arrayBuffer());
  await assert.rejects(S.decodeBackup(new Blob([bytes.slice(0, -1)])), /backup/i);
  bytes[bytes.length - 1] ^= 1;
  await assert.rejects(S.decodeBackup(new Blob([bytes])), /checksum/i);
  await assert.rejects(S.decodeBackup(new Blob(['not a session'])), /backup/i);
});
check('backup checksum covers metadata as well as binary payload', async () => {
  const bytes = new Uint8Array(await (await S.encodeBackup(checkpoint())).arrayBuffer());
  const headerSize = new DataView(bytes.buffer).getUint32(11, true);
  const header = new TextDecoder().decode(bytes.subarray(15, 15 + headerSize));
  const altered = new TextEncoder().encode(header.replace('My session', 'No session'));
  assert.equal(altered.length, headerSize);
  bytes.set(altered, 15);
  await assert.rejects(S.decodeBackup(new Blob([bytes])), /checksum/i);
});
check('configuration mismatch is detected without discarding the saved session', () => {
  assert.equal(S.compatible(checkpoint(), config), true);
  for (const change of [{ build: 'b' }, { cpus: 1 }, { memory: 256 }, { network: 'fetch' }]) {
    assert.equal(S.compatible(checkpoint(), { ...config, ...change }), false);
  }
});
check('console recording rejects invalid sizes and truncated events', () => {
  assert.throws(() => S.resizeRecord(0, 30), /size/i);
  assert.throws(() => S.consoleEvents(new Uint8Array([0, 10, 0, 0, 0]).buffer), /console/i);
});
check('snapshot capture pauses all CPUs and resumes even if capture fails', async () => {
  const calls = [];
  const vm = { running: true, stop: async () => calls.push('stop'),
    save_state: async () => { calls.push('save'); throw new Error('capture failed'); },
    run: () => calls.push('run') };
  await assert.rejects(S.capture(vm), /capture failed/);
  assert.deepEqual(calls, ['stop', 'save', 'run']);
});
check('capture does not restart a previously paused guest', async () => {
  let runs = 0;
  const vm = { running: false, stop: async () => {}, save_state: async () => new Uint8Array([42]), run: () => runs++ };
  assert.deepEqual(await S.capture(vm), { state: new Uint8Array([42]), process: null });
  assert.equal(runs, 0);
});
check('capture takes the snapshot in pieces where the machine hands it out so', async () => {
  const pieces = [new Uint8Array([1, 2]), new Uint8Array([3])];
  const vm = { running: false, stop: async () => {}, run: () => {},
    save_state: async () => { throw new Error('the one buffer, not wanted'); },
    save_state_pieces: async () => pieces };
  assert.equal((await S.capture(vm)).state, pieces);
});
check("with no kernel, capture takes the program's process in the same stop, after the machine's state", async () => {
  const calls = [];
  const vm = { running: true, user: true, stop: async () => calls.push('stop'), run: () => calls.push('run'),
    save_state: async () => { calls.push('state'); return new Uint8Array([1]); },
    save_process: async () => { calls.push('process'); return new Uint8Array([9, 9]); } };
  assert.deepEqual(await S.capture(vm), { state: new Uint8Array([1]), process: new Uint8Array([9, 9]) });
  assert.deepEqual(calls, ['stop', 'state', 'process', 'run']);
});
check('a backup with a process round trips it between the state and the console; one without has none', async () => {
  const c = { ...checkpoint(), process: new Blob([new Uint8Array([7, 8, 9])]) };
  const result = await S.decodeBackup(await S.encodeBackup(c));
  assert.deepEqual(new Uint8Array(await result.state.arrayBuffer()), new Uint8Array([1, 2, 3]));
  assert.deepEqual(new Uint8Array(await result.process.arrayBuffer()), new Uint8Array([7, 8, 9]));
  assert.deepEqual(S.consoleEvents(await result.console.arrayBuffer()), [{ bytes: new Uint8Array([27, 91, 50, 74]) }, { cols: 90, rows: 30 }]);
  assert.equal((await S.decodeBackup(await S.encodeBackup(checkpoint()))).process, undefined);
  // Its size is covered by the checksum like the rest of the header
  const bytes = new Uint8Array(await (await S.encodeBackup(c)).arrayBuffer());
  const headerSize = new DataView(bytes.buffer).getUint32(11, true);
  const header = new TextDecoder().decode(bytes.subarray(15, 15 + headerSize));
  const altered = new TextEncoder().encode(header.replace('"processBytes":3,"consoleBytes":' + c.console.size, '"processBytes":2,"consoleBytes":' + (c.console.size + 1)));
  assert.equal(altered.length, headerSize);
  bytes.set(altered, 15);
  await assert.rejects(S.decodeBackup(new Blob([bytes])), /checksum/i);
});
check('pieces pack to the snapshot they make up', async () => {
  const pieces = [new Uint8Array(6000).fill(7), new Uint8Array(4000).fill(9)];
  const whole = new Uint8Array(10000);
  whole.fill(7, 0, 6000);
  whole.fill(9, 6000);
  assert.deepEqual(await S.unpackState(await S.packState(pieces)), whole);
});
check('gzip snapshots decode to the original bytes', async () => {
  const bytes = new Uint8Array(10000).fill(42);
  const packed = await S.packState(bytes);
  assert.equal(packed.encoding, 'gzip');
  assert.ok(packed.state.size < bytes.length);
  assert.deepEqual(await S.unpackState(packed), bytes);
});

// A faithful file-handle boundary, not a replacement for real IndexedDB/browser tests.
class Directory {
  files = new Map(); fail = false; openFail = false;
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && !options.create) throw new DOMException('Missing', 'NotFoundError');
    if (!this.files.has(name) && options.create) this.files.set(name, new Blob([]));
    const dir = this;
    return { getFile: async () => dir.files.get(name), createWritable: async () => {
      if (dir.openFail) throw new Error('cannot open writer');
      let pending;
      return { write: async blob => { pending = new Blob([blob]); }, close: async () => {
        if (dir.fail) throw new Error('disk full');
        dir.files.set(name, pending);
      } };
    } };
  }
  async removeEntry(name) { this.files.delete(name); }
  async *entries() { for (const [name] of this.files) yield [name, await this.getFileHandle(name)]; }
}
check('folder checkpoints preserve the previous generation when a write fails', async () => {
  const dir = new Directory();
  const store = new S.FolderStore(dir);
  await store.put(checkpoint());
  dir.fail = true;
  await assert.rejects(store.put({ ...checkpoint(), savedAt: 2000 }), /disk full/);
  assert.equal((await store.get('one')).savedAt, 1000);
  dir.fail = false;
  await store.put({ ...checkpoint(), savedAt: 2000 });
  assert.equal((await store.get('one')).savedAt, 2000);
  assert.deepEqual((await store.list()).map(x => x.id), ['one']);
});
check('a failed first folder write does not leave an empty broken session', async () => {
  const dir = new Directory(); const store = new S.FolderStore(dir);
  dir.fail = true;
  await assert.rejects(store.put(checkpoint()), /disk full/);
  dir.fail = false;
  assert.deepEqual(await store.list(), []);
  await store.put(checkpoint());
  assert.equal((await store.get('one')).savedAt, 1000);
});
check('failed writer creation also cleans up only a newly created empty file', async () => {
  const dir = new Directory(); const store = new S.FolderStore(dir);
  dir.openFail = true;
  await assert.rejects(store.put(checkpoint()), /cannot open writer/);
  assert.deepEqual(await store.list(), []);
});
check('an unrelated corrupt folder session does not block new sessions', async () => {
  const dir = new Directory(); const store = new S.FolderStore(dir);
  dir.files.set('broken.a.snowglobe', new Blob(['broken']));
  await store.put(checkpoint());
  const entries = await store.list();
  assert.ok(entries.find(e => e.id === 'broken').unreadable);
  assert.ok(entries.find(e => e.id === 'one'));
  assert.ok(dir.files.has('broken.a.snowglobe'));
});
check('folder listing validates one large checkpoint at a time', async () => {
  const store = new S.FolderStore(new Directory());
  for (const id of ['one', 'two', 'three']) await store.put({ ...checkpoint(), id });
  const get = store.get.bind(store); let active = 0, peak = 0;
  store.get = async id => { active++; peak = Math.max(peak, active); try { return await get(id); } finally { active--; } };
  assert.equal((await store.list()).length, 3);
  assert.equal(peak, 1, 'Parallel validation can allocate many entire snapshots at once');
});
check('folder checkpoint falls back to last valid generation after corruption', async () => {
  const dir = new Directory();
  const store = new S.FolderStore(dir);
  await store.put(checkpoint());
  await store.put({ ...checkpoint(), savedAt: 2000 });
  dir.files.set('one.b.snowglobe', new Blob(['corrupt']));
  assert.equal((await store.get('one')).savedAt, 1000);
});
check('folder filenames never incorporate user-supplied paths', async () => {
  const store = new S.FolderStore(new Directory());
  await assert.rejects(store.put({ ...checkpoint(), id: '../../private' }), /identifier/i);
});
check('only session-owned folder files are deleted', async () => {
  const dir = new Directory();
  const store = new S.FolderStore(dir);
  dir.files.set('unrelated.txt', new Blob(['keep']));
  await store.put(checkpoint());
  await store.remove('one');
  assert.equal(await store.get('one'), null);
  assert.ok(dir.files.has('unrelated.txt'));
});
