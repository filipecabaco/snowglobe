// The fleet page's own elements (site/fleet/index.html) over fleet.js and orchestrator.js: a
// snowglobe.toml in a text box, read as you type into the steps the page can take with it (each its
// own Run, or Run all), the machines those steps use, and a frame for the service it opens. Nothing
// runs because of the file or the address: only a click (Run, Run all), which is the person's yes,
// so there is no dialog (the machines run in this tab, as root). Its service worker (sw.js) makes the page cross-origin isolated and carries the frame's
// requests to the machine (and a link's: one machine's guest asking another's server), as the agent page's does: the first visit installs it and reloads once.
(async function () {
  "use strict";
  const doc = document;
  const $ = (id) => doc.getElementById(id);
  const statusLine = $("fleet-status");
  const say = (t) => { statusLine.textContent = t; };

  // A running step's clock (render() re-renders each second while one runs), and the files line
  let tickTimer = null;

  const mb = (n) => `${(n / (1 << 20)).toFixed(n < (10 << 20) ? 1 : 0)} MB`;
  const elapsed = (since) => {
    const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  };
  /** How a machine's files are coming in: the warm pack while it arrives, then what was fetched. */
  function filesText(f) {
    if (!f) return "";
    const parts = [];
    if (f.warm && !f.warm.done) parts.push(f.warm.total ? `files ${mb(f.warm.loaded)} of ${mb(f.warm.total)}` : "files starting");
    if (f.fetched) parts.push(`${f.fetched} fetched on demand (${mb(f.fetchedBytes)})`);
    if (f.prefetched) parts.push(`${f.prefetched} ahead (${mb(f.prefetchedBytes)})`);
    return parts.join(", ");
  }

  let framed = true;
  try { framed = window.top !== window; } catch {}
  if (framed) {
    say("Open this page in a tab of its own.");
    for (const el of doc.querySelectorAll("button, textarea, input")) el.disabled = true;
    return;
  }

  const isolation = { isolated: window.crossOriginIsolated === true, controlled: false, reason: null };
  const swKey = "snowglobe-fleet-sw:" + location.pathname;
  if ("serviceWorker" in navigator) {
    try {
      await navigator.serviceWorker.register("sw.js", { scope: "./" });
      isolation.controlled = !!navigator.serviceWorker.controller;
      if (isolation.isolated && isolation.controlled) {
        try { sessionStorage.removeItem(swKey); } catch {}
      } else {
        let tried = false;
        try { tried = sessionStorage.getItem(swKey) === "1"; } catch {}
        if (!tried) {
          try { sessionStorage.setItem(swKey, "1"); } catch {}
          say("Setting the page up: it reloads once…");
          await navigator.serviceWorker.ready;
          location.reload();
          return;
        }
        isolation.reason = isolation.controlled ? "the page isn't cross-origin isolated (its service worker couldn't make it so)"
          : "its service worker isn't in control of this load (a hard reload skips it): reload the page";
      }
    } catch (e) {
      isolation.reason = `its service worker could not start (${e?.message ?? e})`;
    }
  } else {
    isolation.reason = "this browser has no service workers";
  }

  let manifest;
  try {
    const r = await fetch("runtimes.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`runtimes.json: ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    say(`The list of machines could not be loaded (${e.message}). Reload to try again.`);
    return;
  }

  const F = window.SnowglobeFleet;
  // No dialog: every run here starts from a click on this page (Run, Run all), which is the
  // person's yes, so the buttons act only on a click the person made (isTrusted): a page in the
  // frame is this origin too, and could call .click() on them. The gate only has to say "granted"
  // once a click has run something. The preview answers its frame's requests only after that.
  let clicked = false;
  // The one thing that deletes a machine's saved state is Stop, which the person just clicked, and
  // only for the machines this fleet has used (freshFor)
  let freshOk = false;
  let freshFor = new Set();
  const ask = async () => {};
  ask.granted = () => clicked;
  const scheduler = new SnowglobeScheduler.Scheduler({ onchange: () => render() });
  const api = SnowglobeOrchestrator.createAgents(manifest, {
    pageUrl: location.href, scheduler, Machine: SnowglobeMachine.Machine, createMachine: SnowglobeHost.createMachine,
    ask, confirmFresh: async (m) => freshOk && freshFor.has(m.name), onchange: () => render(), hidden: doc.hidden, isolated: isolation.isolated,
  });
  const machines = api._machines;
  addEventListener("visibilitychange", () => { for (const m of machines) m.lifecycle.setHidden(doc.hidden); });
  addEventListener("beforeunload", (e) => {
    if (!api.unsaved().length) return;
    e.preventDefault();
    e.returnValue = "";
  });
  // The service worker hands each request of the frame over a channel of its own: answered here, by
  // the machine, as it comes. It answers only a tab it was told owns the frame's navigation (claim)
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type !== "snowglobe-preview" || !e.ports?.[0]) return;
    const port = e.ports[0];
    const cancel = new AbortController();
    port.onmessage = ({ data }) => { if (data?.type === "cancel") cancel.abort(); };
    port.postMessage({ type: "taken" });
    api.previewRequest(e.data.request, (msg, transfer) => port.postMessage(msg, transfer ?? []), { signal: cancel.signal })
      .catch((err) => port.postMessage({ type: "error", ...SnowglobePreview.errorPage(502, "The preview failed", String(err?.message ?? err)) }));
  });
  navigator.serviceWorker?.startMessages?.();
  // A WebSocket the page in the frame opens to a machine (preview-hook.js), spoken here (api.previewSocket)
  addEventListener("message", (e) => { if (e.data?.type === "snowglobe-preview-socket" && e.origin === location.origin && e.source === $("fleet-frame").contentWindow && e.ports?.[0]) api.previewSocket(e.data, e.ports[0]); });
  const claim = (url) => {
    try { navigator.serviceWorker?.controller?.postMessage({ type: "snowglobe-preview-nav", url: new URL(url, location.href).href }); } catch {}
  };
  window.snowglobeFleet = { api, plan: () => current?.plan, run: () => current?.run };

  // ---------------------------------------------------------------- the file
  const text = $("fleet-text");
  const problems = $("fleet-problems");
  const stepsList = $("fleet-steps");
  const notesList = $("fleet-notes");
  const runAll = $("fleet-run-all");
  const stopBtn = $("fleet-stop");
  let stopping = false;
  let ran = false; // something was run since the last Stop, by this file or an earlier one
  const touched = new Set(); // the machines it used
  const machinesList = $("fleet-machines");
  const frame = $("fleet-frame");
  const frameBox = $("fleet-frame-box");
  const frameTitle = $("fleet-frame-title");

  // ---------------------------------------------------------------- the file, coloured
  const hlCode = $("fleet-hl").firstElementChild;
  const editor = $("fleet-editor");
  const escapeHtml = (t) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  function paint() {
    hlCode.innerHTML = F.highlight(text.value).map(([c, t]) => (c ? `<span class="hl-${c}">${escapeHtml(t)}</span>` : escapeHtml(t))).join("") + "\n ";
    scrollHl();
  }
  function scrollHl() { hlCode.style.transform = `translate(${-text.scrollLeft}px, ${-text.scrollTop}px)`; }
  text.addEventListener("scroll", scrollHl);

  // ---------------------------------------------------------------- the graph
  const SVG = "http://www.w3.org/2000/svg";
  const svg = $("fleet-graph");
  const svgEl = (tag, attrs, txt) => {
    const e = doc.createElementNS(SVG, tag);
    for (const [k, v] of Object.entries(attrs ?? {})) e.setAttribute(k, v);
    if (txt != null) e.textContent = txt;
    return e;
  };
  /** The fleet drawn: a box for each machine of the page it uses, an arrow for each link (from the one that reaches to the one reached). */
  function drawGraph() {
    const g = current ? F.graph(current.plan) : { nodes: [], edges: [] };
    $("fleet-graph-box").hidden = !g.nodes.length;
    if (!g.nodes.length) return svg.replaceChildren();
    const W = 140, H = 62, GX = 150, GY = 26, PAD = 10;
    const cols = Math.max(...g.nodes.map((n) => n.rank)) + 1;
    const rowsIn = (r) => g.nodes.filter((n) => n.rank === r).length;
    const rowsMax = Math.max(...Array.from({ length: cols }, (_, r) => rowsIn(r)));
    const width = PAD * 2 + cols * W + (cols - 1) * GX;
    const height = PAD * 2 + rowsMax * H + (rowsMax - 1) * GY + 14;
    const at = new Map(g.nodes.map((n) => {
      const colH = rowsIn(n.rank) * H + (rowsIn(n.rank) - 1) * GY;
      return [n.id, { x: PAD + n.rank * (W + GX), y: PAD + 7 + (rowsMax * H + (rowsMax - 1) * GY - colH) / 2 + n.row * (H + GY) }];
    }));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("width", width);
    const out = [];
    const defs = svgEl("defs");
    const marker = svgEl("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "8", markerHeight: "8", orient: "auto-start-reverse" });
    marker.append(svgEl("path", { d: "M0 0 L10 5 L0 10 z", class: "head" }));
    defs.append(marker);
    out.push(defs);
    const described = new Map(machines.map((m) => [m.name, api._describe(m)]));
    const linkOn = (e) => described.get(e.to)?.doing?.startsWith("serving") && described.get(e.from)?.state === "running";
    for (const [i, e] of g.edges.entries()) {
      const a = at.get(e.from), b = at.get(e.to);
      if (!a || !b) continue;
      const back = b.x <= a.x;
      const x1 = back ? a.x : a.x + W, x2 = back ? b.x + W : b.x;
      const y1 = a.y + H / 2, y2 = b.y + H / 2;
      const bend = back ? 70 : (x2 - x1) / 2;
      const d = e.from === e.to ? `M${a.x + W} ${a.y + 14} C${a.x + W + 50} ${a.y - 10} ${a.x + W + 50} ${a.y + H + 10} ${a.x + W} ${a.y + H - 14}`
        : `M${x1} ${y1} C${x1 + (back ? -bend : bend)} ${y1} ${x2 + (back ? bend : -bend)} ${y2} ${x2} ${y2}`;
      const edge = svgEl("path", { d, class: "edge" + (linkOn(e) ? " live" : ""), "marker-end": "url(#arrow)" });
      out.push(edge);
      // The label sits on the middle of the curve, nudged up so edges of one pair don't print over each other
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2 - 7 - (i % 2) * 14;
      out.push(svgEl("text", { x: mx, y: my, class: "lbl" }, e.label));
    }
    for (const n of g.nodes) {
      const { x, y } = at.get(n.id);
      const d = described.get(n.runtime);
      const box = svgEl("g", { class: "node", "data-state": d?.state ?? "asleep" });
      box.append(svgEl("title", null, `${n.runtime}: ${d?.state ?? "asleep"}${d?.doing ? ` · ${d.doing}` : ""}`));
      box.append(svgEl("rect", { x, y, width: W, height: H, rx: 8 }));
      box.append(svgEl("circle", { cx: x + 14, cy: y + 18, r: 4, class: "dot" }));
      const names = [...n.names, ...n.services.map((s) => s.name)];
      box.append(svgEl("text", { x: x + 26, y: y + 22, class: "t" }, names.join(", ") || n.runtime));
      const sub = [n.runtime, ...n.services.map((s) => `:${s.port}`)].join(" · ");
      box.append(svgEl("text", { x: x + 14, y: y + 44, class: "s" }, sub));
      out.push(box);
    }
    svg.replaceChildren(...out);
  }

  let current = null; // { plan, run } for what the text says now
  let parseError = null;

  function read() {
    paint();
    parseError = null;
    let file;
    try {
      file = F.parse(text.value);
    } catch (e) {
      parseError = e.message;
      current = null;
      return render();
    }
    const plan = F.plan(file, manifest.runtimes);
    // A new file starts from no links: its link steps set its own. A machine that was awake with the
    // old ones is suspended (it reads its names at its next wake)
    api.setLinks([]).catch((e) => say(e.message));
    current = { plan, run: F.createRun(api, plan, { onchange: () => render() }) };
    render();
  }

  const busy = () => !!current && current.plan.steps.some((s) => current.run.state(s.key).status === "running");
  const li = (...kids) => { const el = doc.createElement("li"); el.append(...kids); return el; };
  const el = (tag, cls, txt) => { const e = doc.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };

  function render() {
    // A file can't be edited under steps that are running
    text.readOnly = busy();
    if (busy()) editor.dataset.readonly = ""; else delete editor.dataset.readonly;
    const items = [];
    if (parseError) items.push(li(el("b", null, "The file doesn't read: "), parseError));
    for (const p of current?.plan.problems ?? []) items.push(li(el("code", null, p.where), `: ${p.message}`));
    problems.replaceChildren(...items);
    problems.hidden = !items.length;
    notesList.replaceChildren(...(current?.plan.notes ?? []).map((n) => li(n)));
    $("fleet-notes-box").hidden = !current?.plan.notes.length;
    $("fleet-notes-count").textContent = current?.plan.notes.length ? `(${current.plan.notes.length})` : "";

    const steps = current?.plan.steps ?? [];
    $("fleet-name").textContent = current ? current.plan.name : "";
    $("fleet-plan-empty").hidden = !!steps.length;
    $("fleet-plan-empty").textContent = parseError ? "" : current ? "Nothing in this file can run on this page." : "";
    const run = current?.run;
    stepsList.replaceChildren(...steps.map((s) => {
      const st = run.state(s.key);
      const ready = s.needs.every((n) => run.state(n).status === "done");
      const go = el("button", "btn sm", st.status === "done" ? "Again" : st.status === "failed" ? "Retry" : "Run");
      go.type = "button";
      go.disabled = stopping || busy() || !ready;
      go.title = ready ? "" : `needs ${s.needs.join(", ")} first`;
      go.addEventListener("click", (e) => {
        if (!e.isTrusted || stopping) return;
        mark();
        clicked = true;
        fit().then(() => run.runStep(s.key)).then(() => after(s), (e) => say(e.message));
      });
      const head = el("div", "step-head");
      const dot = el("span", "dot");
      dot.dataset.on = st.status === "running" ? "live" : st.status === "done" ? "ok" : "";
      dot.setAttribute("aria-hidden", "true");
      head.append(dot, el("b", null, `${s.kind} ${s.name}`), el("span", "step-sum", s.summary), go);
      const row = li(head);
      // A running step says how long it has run, so a slow one (a phone's) doesn't look stuck
      const running = st.status === "running" ? `${st.detail ?? "running…"}${st.startedAt != null ? ` · ${elapsed(st.startedAt)}` : ""}` : "";
      const state = st.status === "failed" ? st.error : st.status === "running" ? running : st.status === "done" ? st.detail : "";
      if (state) row.append(el("p", "step-state" + (st.status === "failed" ? " bad" : ""), state));
      if (st.output && st.status !== "done") row.append(el("pre", "step-out", st.output));
      return row;
    }));
    stopBtn.disabled = stopping || !ran;
    runAll.disabled = stopping || busy() || !steps.length || steps.every((s) => run.state(s.key).status === "done");

    drawGraph();

    // Only the machines this fleet uses
    machinesList.replaceChildren(...machines.filter((m) => steps.some((s) => s.runtime === m.name)).map((m) => {
      const d = api._describe(m);
      const files = filesText(d.files);
      return li(el("b", null, m.name), ` ${d.state}`, d.doing ? ` · ${d.doing}` : "", files ? ` · ${files}` : "",
        d.filesUnreachable ? ` · ${d.filesUnreachable}` : "", d.unavailable ? ` · ${d.unavailable}` : "");
    }));
    // While a step runs, its time moves on every second
    if (busy() && !tickTimer) tickTimer = setInterval(() => { if (busy()) render(); else { clearInterval(tickTimer); tickTimer = null; } }, 1000);
  }

  /** A run starts: remember it, and the machines it uses, for Stop (which a later edit of the file doesn't forget). */
  function mark() {
    ran = true;
    for (const n of current ? F.graph(current.plan).nodes : []) touched.add(n.id);
  }

  /**
   * The page keeps two machines awake by default, and a fleet that links three (a viewer and two
   * sources) would have each wake suspend another and its links fail. So a run raises the limit to
   * the machines the file uses (at most 8, the scheduler's own ceiling), and Stop puts it back.
   */
  async function fit(back) {
    const n = back ? 2 : Math.min(8, Math.max(2, current ? F.graph(current.plan).nodes.length : 2));
    try { await api.setAwakeLimit(n); } catch (e) { say(e.message); }
  }

  /** Once a service's step is done, its frame shows what it serves. */
  function after(step) {
    const st = current?.run.state(step.key);
    if (step.kind !== "service" || !st || st.status !== "done" || !st.url) return;
    frameTitle.textContent = `${step.name}: ${step.runtime}'s port ${step.port}`;
    claim(st.url);
    frame.src = st.url;
    frameBox.hidden = false;
  }

  runAll.addEventListener("click", async (e) => {
    if (!current || !e.isTrusted || stopping) return;
    mark();
    clicked = true;
    const { plan, run } = current;
    say("Running the fleet…");
    await fit();
    const ok = await run.runAll();
    if (stopping) return;
    for (const s of plan.steps) after(s);
    say(ok ? "The fleet is up." : "A step failed. Run all continues from there.");
  });

  stopBtn.addEventListener("click", async (e) => {
    if (!current || stopping || !e.isTrusted) return;
    stopping = true;
    say("Stopping the fleet…");
    render();
    frame.removeAttribute("src");
    frameBox.hidden = true;
    freshFor = new Set([...touched, ...current.plan.steps.map((s) => s.runtime).filter(Boolean)]);
    freshOk = true;
    let r;
    try { r = await current.run.stop({ also: [...touched] }); } catch (e) { r = { problems: [e.message] }; } finally { freshOk = false; }
    await fit(true);
    stopping = false;
    clicked = false;
    ran = false;
    touched.clear();
    freshFor = new Set();
    say(r.problems.length ? `Stopped, but ${r.problems.join("; ")}.` : "The fleet is stopped: its machines are back to their image.");
    render();
  });

  $("fleet-frame-close").addEventListener("click", async () => {
    frame.removeAttribute("src");
    frameBox.hidden = true;
    try { await api.closePreview({ source: "fleet" }); } catch {}
    render();
  });

  text.addEventListener("input", () => { if (!busy() && !stopping) read(); else paint(); });
  $("fleet-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f || busy() || stopping) return;
    if (f.size > 256 << 10) { say("That file is over 256 KiB."); return; }
    text.value = await f.text();
    e.target.value = "";
    read();
  });
  /** A file beside the page into the text box (the example, or a template). */
  async function load(url, what) {
    if (busy() || stopping) return;
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(String(r.status));
      text.value = await r.text();
      read();
    } catch (e) {
      say(`${what} could not be loaded (${e.message}).`);
    }
  }
  $("fleet-example").addEventListener("click", () => load("snowglobe.toml", "The example"));
  $("fleet-template").addEventListener("change", async (e) => {
    const file = e.target.value;
    e.target.value = "";
    if (file) await load(`templates/${file}`, "The template");
  });

  if (!isolation.isolated) say(`Machines on several CPUs are off: ${isolation.reason ?? "this page isn't cross-origin isolated"}.`);
  else say("");
  // The example, to begin with: the file beside the page (the repo's examples/fleet/snowglobe.toml)
  read();
  $("fleet-example").click();
})();
