"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("./memory-debug.js");

const MB = 1 << 20;

// A machine at 384 MB of guest RAM, as one measured: most of the host side is the heap
const report = (over = {}) => ({
  memory: 862 * MB,
  guest_ram: 384 * MB,
  guest_ram_at: 16 * MB,
  heap: { live: 300 * MB, peak: 420 * MB, large: 250 * MB, kept: 0 },
  fs: { inodes: 6000, cached_blobs: 900, cached_bytes: 63 * MB, cache_limit: 64 * MB, written_buffers: 3, written_bytes: 20 * MB, written_capacity: 20 * MB },
  jit: { compiled: 1, flushes: 0 },
  pages: {
    before_ram: { bytes: 16 * MB, used: 0 },
    guest_ram: { bytes: 384 * MB, used: 315 * MB },
    after_ram: { bytes: 462 * MB, used: 351 * MB },
  },
  ...over,
});
const info = { memory_mb: 384, fs_cache_mb: 64, pack_give_mb: 48, pack_given_bytes: 48 * MB, sampling: true };

test("digest: rows say what is in use, in the guest's RAM and on the host side", () => {
  const d = M.digest({ report: report(), samples: [], info });
  const by = Object.fromEntries(d.rows.map((r) => [r.label.trim(), r]));
  assert.equal(by["whole memory"].mb, 862);
  assert.equal(by["in use"].mb, 666);
  assert.equal(by["in use"].of, 862);
  assert.equal(by["guest RAM touched"].mb, 315);
  assert.equal(by["guest RAM touched"].of, 384);
  assert.equal(by["host side in use"].mb, 351);
  assert.equal(by["heap, live"].mb, 300);
  assert.equal(by["file cache"].mb, 63);
  assert.equal(by["file cache"].of, 64);
  assert.equal(by["written files"].mb, 20);
  // The heap's live bytes, less the cache and the written files, are the rest of it
  assert.equal(by.other.mb, 217);
  assert.equal(by["not the heap's"].mb, 51);
  assert.match(d.headline, /862 MB grown, 666 MB in use/);
});

test("digest: findings name what to change", () => {
  const d = M.digest({ report: report(), samples: [], info });
  const said = (re) => d.findings.some((f) => re.test(f.text));
  assert.ok(said(/guest has touched 315 MB of its 384 MB/), "RAM mostly touched");
  assert.ok(said(/file cache is full/), "cache at its limit");
  assert.ok(said(/grown but holds nothing/), "grown and unused");
  assert.ok(said(/peaked at 420 MB and holds 300 MB/), "heap peak");
  assert.ok(said(/warm pack put 48 MB/), "the pack");
  assert.ok(!said(/Sampling is off/));
  assert.ok(d.findings.find((f) => /file cache is full/.test(f.text)).level === "warn");
});

test("digest: a small machine has nothing to warn about, and a missing scan says no pages", () => {
  const quiet = report({
    memory: 300 * MB,
    heap: { live: 60 * MB, peak: 70 * MB, large: 0, kept: 0 },
    fs: { cached_bytes: 10 * MB, cache_limit: 64 * MB, written_buffers: 0, written_bytes: 0, written_capacity: 0, cached_blobs: 10 },
    pages: {
      before_ram: { bytes: 16 * MB, used: 0 },
      guest_ram: { bytes: 384 * MB, used: 100 * MB },
      after_ram: { bytes: 0, used: 64 * MB },
    },
  });
  const d = M.digest({ report: quiet, samples: [], info: { ...info, pack_given_bytes: 0 } });
  assert.deepEqual(d.findings.filter((f) => f.level === "warn"), []);
  const noScan = M.digest({ report: report({ pages: undefined }), samples: [], info });
  assert.ok(!noScan.rows.some((r) => r.label === "in use"));
  assert.match(noScan.headline, /862 MB grown;/);
});

test("digest: wasted room in written files and a full cache of kept blocks are said", () => {
  const d = M.digest({
    report: report({
      heap: { live: 300 * MB, peak: 300 * MB, large: 0, kept: 12 * MB },
      fs: { cached_bytes: 0, cache_limit: 64 * MB, cached_blobs: 0, written_buffers: 2, written_bytes: 10 * MB, written_capacity: 30 * MB },
    }),
    samples: [],
    info,
  });
  assert.ok(d.findings.some((f) => /20 MB more than they contain/.test(f.text)));
  assert.ok(d.findings.some((f) => /12 MB of freed big blocks is kept/.test(f.text)));
});

test("jumps: the biggest steps between samples, with what the machine was doing", () => {
  const s = (t, label, memory, live) => ({ t, label, memory: memory * MB, heap: { live: live * MB } });
  const steps = M.jumps([
    s(100, "created", 200, 10),
    s(2000, "restored", 700, 480),
    s(7000, "tick", 710, 485),
    s(12000, "save begins", 720, 490),
    s(13000, "save ends", 760, 530),
  ]);
  assert.equal(steps[0].label, "restored");
  assert.equal(steps[0].grew, 500);
  assert.equal(steps[1].label, "save ends");
  assert.equal(steps.length, 2, "10 MB steps are not worth a line");
  const d = M.digest({ report: report(), samples: [s(100, "created", 200, 10), s(2000, "restored", 700, 480)], info });
  assert.equal(d.jumps[0].label, "restored");
});

test("text: lines to read, with the findings and where it grew", () => {
  const d = M.digest({ report: report(), samples: [{ t: 100, label: "created", memory: 100 * MB, heap: { live: 0 } }, { t: 3000, label: "restored", memory: 700 * MB, heap: { live: 400 * MB } }], info });
  const t = M.text(d, "supabase");
  assert.match(t, /^supabase: 862 MB grown/);
  assert.match(t, /guest RAM touched\s+315 of 384 MB/);
  assert.match(t, /file cache\s+63 of 64 MB/);
  assert.match(t, /! The file cache is full/);
  assert.match(t, /where it grew:\n\s+3 s, restored: memory \+600 MB/);
  assert.match(M.text(null, "x"), /x: no memory report/);
});

test("enabled: only when the address or the storage asks for the memory debug", () => {
  const store = (v) => ({ getItem: () => v });
  assert.equal(M.enabled({ search: "?debug=memory" }, store(null)), true);
  assert.equal(M.enabled({ search: "?a=1&debug=memory&b=2" }, store(null)), true);
  assert.equal(M.enabled({ search: "?debug=net,memory" }, store(null)), true);
  assert.equal(M.enabled({ search: "?debug=memoryx" }, store(null)), false);
  assert.equal(M.enabled({ search: "" }, store(null)), false);
  assert.equal(M.enabled({ search: "" }, store("memory")), true);
  assert.equal(M.enabled({ search: "" }, store("net, memory")), true);
  assert.equal(M.enabled({ search: "" }, store("memoryx")), false);
  assert.equal(M.enabled({ search: "" }, { getItem() { throw new Error("blocked"); } }), false);
});

test("mount: shows each machine's digest, and goes when stopped", async () => {
  const made = [];
  const el = (tag) => {
    const e = { tag, children: [], style: {}, textContent: "", listeners: {}, open: false, append(...c) { this.children.push(...c); }, addEventListener(n, f) { this.listeners[n] = f; }, remove() { this.removed = true; } };
    made.push(e);
    return e;
  };
  const doc = { createElement: el };
  const parent = el("body");
  const panel = M.mount(parent, async () => [{ name: "db", snapshot: { report: report(), samples: [], info } }], { every: 1e9, doc });
  await panel.refresh();
  const pre = made.find((e) => e.tag === "pre");
  assert.match(pre.textContent, /^db: 862 MB grown/);
  panel.stop();
  assert.equal(made.find((e) => e.tag === "details").removed, true);
});
