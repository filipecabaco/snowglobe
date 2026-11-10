// The memory debug: what a machine's memory holds, in words. armless (its `debug` option and
// memory_report()) measures; this turns the numbers into rows and findings, and shows them. It is off
// unless asked for: `?debug=memory` in the page's address, or "memory" in localStorage's
// "snowglobe-debug" (comma separated), and a page then passes `debug: true` to its machines.
//
//   digest({ report, samples, info })  ->  { headline, rows, findings, jumps }
//   text(digest)                       ->  the same as lines to read or paste
//   mount(parent, read)                ->  a panel that shows read() (machines' snapshots) every few seconds
//
// A snapshot is what Core.memoryReport() returns: armless's report, the samples it took, and what the
// machine was set up with. It never touches a machine itself.
(function (root) {
  "use strict";

  const MB = 1 << 20;
  const mb = (bytes) => Math.round((bytes ?? 0) / MB);
  const fmt = (bytes) => `${mb(bytes)} MB`;

  /** Whether the page asked for the memory debug. */
  function enabled(location = root.location, storage = root.localStorage) {
    try {
      if (/(?:^|[?&])debug=(?:[^&]*,)?memory(?:,|&|$)/.test(location?.search ?? "")) return true;
      return /(?:^|,)\s*memory\s*(?:,|$)/.test(storage?.getItem("snowglobe-debug") ?? "");
    } catch {
      return false;
    }
  }

  /** The biggest steps the memory took between samples (a machine's own samples), by what it was doing. */
  function jumps(samples, min = 20 * MB, top = 4) {
    const found = [];
    for (let i = 1; i < samples.length; i++) {
      const a = samples[i - 1], b = samples[i];
      const grew = b.memory - a.memory;
      const heap = (b.heap?.live ?? 0) - (a.heap?.live ?? 0);
      const delta = Math.max(grew, heap);
      if (delta >= min) {
        found.push({ at: b.t / 1000, label: b.label, grew: mb(grew), heap: mb(heap), memory: mb(b.memory) });
      }
    }
    return found.sort((x, y) => Math.max(y.grew, y.heap) - Math.max(x.grew, x.heap)).slice(0, top);
  }

  /** Rows and findings from one machine's snapshot. */
  function digest(snapshot) {
    const { report: r, samples = [], info = {} } = snapshot ?? {};
    if (!r) return null;
    const pages = r.pages;
    const heap = r.heap ?? {}, fs = r.fs ?? {};
    const used = pages ? pages.before_ram.used + pages.guest_ram.used + pages.after_ram.used : null;
    const hostUsed = pages ? pages.before_ram.used + pages.after_ram.used : null;
    const ramUsed = pages?.guest_ram.used ?? null;
    const rows = [];
    const row = (label, bytes, note = "", of = null) => rows.push({ label, mb: mb(bytes), of: of == null ? null : mb(of), note });

    row("whole memory", r.memory, "grown so far; it never shrinks");
    if (used != null) row("in use", used, "4 KiB pages holding a non-zero byte: what the machine really uses", r.memory);
    if (ramUsed != null) row("guest RAM touched", ramUsed, "pages the guest has written", r.guest_ram);
    if (hostUsed != null) {
      row("host side in use", hostUsed, "everything outside the guest's RAM");
      row("  heap, live", heap.live, `allocations held now; peak ${fmt(heap.peak)}`);
      row("    file cache", fs.cached_bytes, `blobs fetched, ${fs.cached_blobs ?? 0} of them`, fs.cache_limit);
      row("    written files", fs.written_bytes, `${fs.written_buffers ?? 0} buffers, made at ${fmt(fs.written_capacity)}`);
      row("    freed blocks kept", heap.kept, "big blocks held to be handed out again");
      const other = Math.max(0, (heap.live ?? 0) - (fs.cached_bytes ?? 0) - (fs.written_bytes ?? 0) - (heap.kept ?? 0));
      row("    other", other, "buffers, tables and queues of the devices, the network, the snapshot");
      row("  not the heap's", Math.max(0, hostUsed - (heap.live ?? 0)), "freed small blocks dlmalloc holds, thread stacks, static data");
    }

    const findings = [];
    const say = (level, text) => findings.push({ level, text });
    if (used != null && r.memory - used >= 0.15 * r.memory) {
      say("info", `${fmt(r.memory - used)} of the memory has grown but holds nothing now (the heap peaked at ${fmt(heap.peak)}): a page that was never written, or was given back, costs no physical memory on most systems, but a browser that counts the grown size would count it.`);
    }
    if (ramUsed != null && r.guest_ram > 0 && ramUsed >= 0.75 * r.guest_ram) {
      say("warn", `The guest has touched ${fmt(ramUsed)} of its ${fmt(r.guest_ram)}: its page cache grows into the RAM it is given, and what it touches stays. A smaller memory_mb makes the kernel reclaim instead of growing (it must stay above what the stack needs).`);
    }
    if (fs.cache_limit > 0 && fs.cached_bytes >= 0.9 * fs.cache_limit) {
      say("warn", `The file cache is full (${fmt(fs.cached_bytes)} of ${fmt(fs.cache_limit)}): fs_cache_mb (now ${info.fs_cache_mb ?? mb(fs.cache_limit)}) is a direct cost, and what it drops comes again from the warm pack.`);
    }
    if (fs.written_capacity - fs.written_bytes >= 8 * MB) {
      say("warn", `Files the guest wrote hold ${fmt(fs.written_capacity - fs.written_bytes)} more than they contain (buffers made larger than their data).`);
    }
    if ((heap.kept ?? 0) >= 8 * MB) {
      say("info", `${fmt(heap.kept)} of freed big blocks is kept to be reused; the host gives them back when the machine is up (armless_heap_flush).`);
    }
    if (hostUsed != null && hostUsed > 0 && hostUsed - (heap.live ?? 0) >= 0.3 * hostUsed && hostUsed - (heap.live ?? 0) >= 32 * MB) {
      say("warn", `${fmt(hostUsed - (heap.live ?? 0))} of the host side is not a live allocation: freed small blocks the allocator keeps, thread stacks, static data. If it is large, an allocation pattern is leaving holes (many mid-size buffers freed in between).`);
    }
    if ((heap.peak ?? 0) - (heap.live ?? 0) >= 48 * MB) {
      say("info", `The heap peaked at ${fmt(heap.peak)} and holds ${fmt(heap.live)} now: the ${fmt(heap.peak - heap.live)} difference is where the memory grew to (the restore, a save, a big read).`);
    }
    if (info.pack_given_bytes) {
      say("info", `The warm pack put ${fmt(info.pack_given_bytes)} into the machine (at most ${info.pack_give_mb ?? "?"} MB); the rest stays compressed in the page.`);
    }
    if (!info.sampling) say("info", "Sampling is off, so there is no timeline: open the page with ?debug=memory.");

    const steps = jumps(samples);
    const total = used != null ? used : r.memory;
    return {
      headline: `${mb(r.memory)} MB grown${used != null ? `, ${mb(used)} MB in use` : ""}; guest RAM ${mb(r.guest_ram)} MB, host side ${hostUsed != null ? mb(hostUsed) : "?"} MB`,
      total: mb(total),
      rows,
      findings,
      jumps: steps,
    };
  }

  /** A digest as lines. */
  function text(d, name = "") {
    if (!d) return `${name ? name + ": " : ""}no memory report (armless is too old)`;
    const out = [`${name ? name + ": " : ""}${d.headline}`];
    const width = Math.max(...d.rows.map((x) => x.label.length));
    for (const x of d.rows) {
      const value = x.of != null ? `${x.mb} of ${x.of} MB` : `${x.mb} MB`;
      out.push(`  ${x.label.padEnd(width)}  ${value.padStart(14)}  ${x.note}`);
    }
    for (const f of d.findings) out.push(`  ${f.level === "warn" ? "!" : "-"} ${f.text}`);
    if (d.jumps.length) {
      out.push("  where it grew:");
      for (const j of d.jumps) out.push(`    ${j.at.toFixed(0)} s, ${j.label}: memory +${j.grew} MB (heap +${j.heap} MB), ${j.memory} MB now`);
    }
    return out.join("\n");
  }

  /**
   * A panel in `parent` that shows what `read()` gives every `every` ms: an array of { name, snapshot } (one
   * per machine). It has a button that copies the raw snapshots as JSON, to attach to a report.
   */
  function mount(parent, read, { every = 5000, doc = root.document } = {}) {
    const box = doc.createElement("details");
    box.className = "memory-debug";
    box.open = true;
    box.style.cssText = "position:fixed;right:8px;bottom:8px;z-index:99999;max-width:min(92vw,720px);max-height:60vh;overflow:auto;background:#111;color:#ddd;font:11px/1.4 ui-monospace,monospace;padding:6px 8px;border-radius:6px;opacity:.95";
    const head = doc.createElement("summary");
    head.textContent = "memory debug";
    head.style.cursor = "pointer";
    const pre = doc.createElement("pre");
    pre.style.cssText = "margin:4px 0;white-space:pre-wrap";
    const copy = doc.createElement("button");
    copy.textContent = "copy JSON";
    copy.style.cssText = "font:inherit;margin-right:6px";
    let last = [];
    copy.addEventListener("click", () => root.navigator?.clipboard?.writeText(JSON.stringify(last, null, 2)));
    box.append(head, copy, pre);
    parent.append(box);
    let stopped = false;
    const refresh = async () => {
      try {
        last = await read();
        pre.textContent = last.map((m) => text(digest(m.snapshot), m.name)).join("\n\n") || "no machine is up";
      } catch (e) {
        pre.textContent = `memory debug: ${e?.message ?? e}`;
      }
    };
    refresh();
    const timer = setInterval(() => { if (!stopped) refresh(); }, every);
    return { refresh, stop() { stopped = true; clearInterval(timer); box.remove(); } };
  }

  const SnowglobeMemoryDebug = { enabled, digest, text, jumps, mount };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeMemoryDebug;
  else root.SnowglobeMemoryDebug = SnowglobeMemoryDebug;
})(typeof window !== "undefined" ? window : globalThis);
