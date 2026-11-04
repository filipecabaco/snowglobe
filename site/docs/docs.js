// The docs' pages: what they share once the script runs (every page reads and works without it).
// Old links to one long page (docs/#orchestration) find their section's page; the page being
// read opens in the contents to its sections, marking the one in view; every code block gets a
// copy button; and a search over every page's headings, commands, flags and settings.
(() => {
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    n.append(...kids);
    return n;
  };

  // ── Links from before the split: docs/#section goes to its page ──────────────────────
  const moved = $("#moved");
  if (moved && location.hash) {
    const id = decodeURIComponent(location.hash.slice(1));
    const to = JSON.parse(moved.textContent)[id];
    if (to && !document.getElementById(id)) location.replace(to);
  }

  // ── Contents: the current page opened to its sections ───────────────────────────────
  const toc = $(".toc");
  const current = $('.toc a[aria-current="page"]');
  const headings = [...document.querySelectorAll(".doc section h3[id], .doc section h2.h3[id]")];
  if (current && headings.length) {
    const sub = el("ol", { className: "sub" });
    const links = new Map();
    for (const h of headings) {
      const a = el("a", { href: "#" + h.id, textContent: h.textContent });
      links.set(h.id, a);
      sub.append(el("li", {}, a));
    }
    current.after(sub);
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        for (const a of links.values()) a.removeAttribute("aria-current");
        links.get(e.target.id)?.setAttribute("aria-current", "true");
      }
    }, { rootMargin: "0px 0px -70% 0px" });
    headings.forEach((h) => seen.observe(h));
  }
  // On narrow screens the pages are a menu
  if (toc && current) {
    const toggle = el("button", { className: "toc-toggle", type: "button" },
      el("span", { textContent: "Pages" }), el("span", { textContent: current.textContent }));
    toggle.setAttribute("aria-expanded", "false");
    toggle.addEventListener("click", () => toggle.setAttribute("aria-expanded", String(toc.classList.toggle("open"))));
    toc.prepend(toggle);
  }

  // ── Copy buttons on code ─────────────────────────────────────────────────────────────
  for (const pre of document.querySelectorAll(".doc pre")) {
    const box = el("div", { className: "code" });
    pre.replaceWith(box);
    box.append(pre);
    const btn = el("button", { className: "copy", type: "button", textContent: "Copy" });
    btn.setAttribute("aria-label", "Copy this code");
    btn.addEventListener("click", async () => {
      // The commands without the comments set dim beside them
      const clone = pre.cloneNode(true);
      clone.querySelectorAll(".dim").forEach((d) => d.remove());
      const text = clone.textContent.replace(/[ \t]+$/gm, "").replace(/\n{2,}/g, "\n").trim();
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = "Copied";
      } catch {
        getSelection().selectAllChildren(pre);
        btn.textContent = "Selected";
      }
      setTimeout(() => (btn.textContent = "Copy"), 1600);
    });
    box.append(btn);
  }

  // ── Search ───────────────────────────────────────────────────────────────────────────
  const input = $("#search");
  const results = $("#search-results");
  if (!input || !toc) return;
  let index = null;
  let picked = -1;

  // Every page's headings, and the first cell of its tables (commands, flags, settings, labels)
  async function build() {
    const pages = [...toc.querySelectorAll(":scope > ol > li > a")].map((a) => ({ url: a.href, title: a.textContent }));
    const docs = await Promise.all(pages.map(async (p) => {
      if (p.url.split("#")[0] === location.href.split("#")[0]) return [p, document];
      try {
        const html = await fetch(p.url).then((r) => r.text());
        return [p, new DOMParser().parseFromString(html, "text/html")];
      } catch { return [p, null]; }
    }));
    const out = [];
    for (const [p, doc] of docs) {
      if (!doc) continue;
      const base = p.url.split("#")[0];
      out.push({ label: p.title, where: "Docs", url: base, rank: 3 });
      let near = { id: "", text: p.title };
      for (const n of doc.querySelectorAll(".doc section h2[id], .doc section h3[id], .doc section table tbody tr")) {
        if (n.tagName === "TR") {
          const cell = n.querySelector("td, th");
          if (!cell) continue;
          const label = cell.textContent.trim().replace(/\s+/g, " ");
          const what = n.querySelector("td.wrap-cell, td:last-child")?.textContent.trim().replace(/\s+/g, " ") || "";
          out.push({ label, where: `${p.title} · ${near.text}`, detail: what, url: base + (near.id ? "#" + near.id : ""), rank: 1 });
        } else {
          near = { id: n.id, text: n.textContent.trim() };
          out.push({ label: near.text, where: p.title, url: base + "#" + n.id, rank: 2 });
        }
      }
    }
    return out;
  }

  function find(q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return [];
    const scored = [];
    for (const e of index) {
      const hay = (e.label + " " + e.where + " " + (e.detail || "")).toLowerCase();
      if (!terms.every((t) => hay.includes(t))) continue;
      const label = e.label.toLowerCase();
      const score = (label.startsWith(terms[0]) ? 6 : label.includes(terms[0]) ? 3 : 0) + e.rank;
      scored.push([score, e]);
    }
    return scored.sort((a, b) => b[0] - a[0]).slice(0, 12).map((s) => s[1]);
  }

  function render() {
    const found = find(input.value);
    picked = found.length ? 0 : -1;
    results.replaceChildren(...(found.length ? found.map((e, i) => {
      const a = el("a", { href: e.url }, e.label, el("small", { textContent: e.detail ? `${e.where} · ${e.detail.slice(0, 90)}` : e.where }));
      a.setAttribute("role", "option");
      a.setAttribute("aria-selected", String(i === 0));
      a.addEventListener("click", () => close());
      return el("li", {}, a);
    }) : [el("li", { className: "none", textContent: `Nothing for "${input.value}"` })]));
    results.hidden = !input.value.trim();
    input.setAttribute("aria-expanded", String(!results.hidden));
  }
  function close() {
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }
  function move(by) {
    const links = [...results.querySelectorAll("a")];
    if (!links.length) return;
    picked = (picked + by + links.length) % links.length;
    links.forEach((a, i) => a.setAttribute("aria-selected", String(i === picked)));
    links[picked].scrollIntoView({ block: "nearest" });
  }

  input.addEventListener("focus", async () => { index ??= await build(); if (input.value) render(); });
  input.addEventListener("input", async () => { index ??= await build(); render(); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); move(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); move(-1); }
    else if (e.key === "Enter") {
      const a = results.querySelectorAll("a")[picked];
      if (a) { e.preventDefault(); close(); location.href = a.href; }
    } else if (e.key === "Escape") { input.value = ""; close(); input.blur(); }
  });
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) close(); });
  // "/" or ⌘K / ctrl-K from anywhere
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
    if ((e.key === "/" && !typing) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) {
      e.preventDefault();
      input.focus();
      input.select();
    }
  });
})();
