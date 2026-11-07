// The agent page's own elements (site/agent/index.html) over orchestrator.js: the list of machines
// and their state, the awake limit, the command form (agent-panel.js), the preview, the copy form,
// the terminal of the selected machine, and the WebMCP tools. Everything here runs only in answer
// to someone: a click, a key, an agent's call, and every run, copy and preview, whoever asks, needs
// the person at the page to allow it once. The address only preselects (?runtime=<name>).
//
// Its service worker (sw.js) makes the page cross-origin isolated, which machines on several CPUs
// need, and carries the preview's requests to it: the first visit installs it and reloads once.
(async function () {
  "use strict";
  const doc = document;
  const $ = (id) => doc.getElementById(id);
  const statusLine = $("agent-status");

  // In a frame, the page that frames it could click Allow for the person (GitHub Pages can't send
  // frame-ancestors to forbid it): the page refuses, and nothing is offered, tools or API
  let framed = true;
  try { framed = window.top !== window; } catch {}
  if (framed) {
    statusLine.textContent = "This page doesn't run inside another page. Open it in a tab of its own to use its machines.";
    for (const el of doc.querySelectorAll("form button, form textarea, form select, form input, #terminal-box")) el.disabled = true;
    $("terminal-box")?.remove();
    doc.body.classList.add("framed");
    return;
  }

  // The service worker: isolation (machines on several CPUs) and the preview. Installed on the
  // first visit, after which the page reloads, once, to be loaded through it
  const isolation = { isolated: window.crossOriginIsolated === true, controlled: false, reason: null };
  const swKey = "snowglobe-agent-sw:" + location.pathname;
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
          statusLine.textContent = "Setting the page up: it reloads once…";
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

  // Main-thread responsiveness, for anyone measuring: long tasks since the page loaded
  const longTasks = { count: 0, totalMs: 0, maxMs: 0 };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        longTasks.count++;
        longTasks.totalMs += e.duration;
        longTasks.maxMs = Math.max(longTasks.maxMs, e.duration);
      }
    }).observe({ type: "longtask", buffered: true });
  } catch {}

  let manifest;
  try {
    const r = await fetch("runtimes.json", { cache: "no-cache" });
    if (!r.ok) throw new Error(`runtimes.json: ${r.status}`);
    manifest = await r.json();
  } catch (e) {
    statusLine.textContent = `The list of machines could not be loaded (${e.message}). Reload to try again.`;
    return;
  }

  const ask = SnowglobeWebMCP.consent({ doc });
  const scheduler = new SnowglobeScheduler.Scheduler({ onchange: () => render() });
  const confirmFresh = (m) => SnowglobeWebMCP.confirmInPage(doc,
    `${m.title}: its saved files are deleted, and its next command starts from the machine as built. This cannot be undone.`,
    { title: `Start ${m.name} fresh?`, yes: "Start fresh", no: "Keep it", danger: true });
  const api = SnowglobeOrchestrator.createAgents(manifest, {
    pageUrl: location.href, scheduler, Machine: SnowglobeMachine.Machine, createMachine: SnowglobeHost.createMachine,
    ask, confirmFresh, onchange: () => render(), hidden: doc.hidden, onactivity: (e) => activity(e), isolated: isolation.isolated,
  });
  const machines = api._machines;
  addEventListener("visibilitychange", () => { for (const m of machines) m.lifecycle.setHidden(doc.hidden); });
  api.metrics = async () => ({
    longTasks: { ...longTasks },
    machines: machines.map((m) => ({ name: m.name, state: api._describe(m).state, wakeMs: m.wakeMs ?? null, wasmMB: Math.round(m.memoryBytes / (1 << 20)) })),
    jsHeapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / (1 << 20)) : null,
  });
  // Machines in this page's own thread instead of workers (to compare): armless.js is loaded here then
  const setTransport = api.setTransport;
  api.setTransport = async (t) => {
    if (t === "inline" && !window.Armless) await loadScript(new URL(manifest.armless.js, location.href).href);
    return setTransport(t);
  };
  window.snowglobeAgent = api;

  // What a reload loses: an awake machine's changes since its last save. The browser asks first
  addEventListener("beforeunload", (e) => {
    if (!api.unsaved().length) return;
    e.preventDefault();
    e.returnValue = "";
  });

  // ---------------------------------------------------------------- selects, preselection
  const runtimeSelect = $("agent-runtime");
  const copyFrom = $("copy-from");
  const copyTo = $("copy-to");
  for (const sel of [runtimeSelect, copyFrom, copyTo]) {
    sel.replaceChildren(...machines.map((m) => new Option(m.title.replace(/ in the browser$/, ""), m.name)));
  }
  const wanted = new URLSearchParams(location.search).get("runtime");
  if (wanted && machines.some((m) => m.name === wanted)) runtimeSelect.value = wanted;
  copyFrom.value = runtimeSelect.value;
  copyTo.value = machines.find((m) => m.name !== runtimeSelect.value)?.name ?? runtimeSelect.value;
  const selected = () => api._get(runtimeSelect.value);

  // ---------------------------------------------------------------- the command form
  let copyText = null; // a copy under way, as the status line says it
  const panelAgent = {
    status: async (rt) => api._status(rt ?? runtimeSelect.value),
    runCommand: (input) => api.runCommand({ runtime: runtimeSelect.value, ...input }, { source: "form" }),
    readJob: (id) => api.readJob(id),
    cancelJob: (id) => api.cancelJob(id),
    wake: (rt) => api.wake(rt ?? runtimeSelect.value),
    suspend: () => api.suspend(runtimeSelect.value),
  };
  const panel = SnowglobeAgentPanel.attach(panelAgent, {
    container: doc.querySelector(".work"), ask, jobText: SnowglobeAgent.jobText,
    label: () => runtimeSelect.value,
    hold: () => copyText ?? unreachable(selected()) ?? scheduler.waiting ?? scheduler.over,
  });
  const unreachable = (m) => m.blobsDown ? `${m.name} can't reach the machine's files (${m.blobsDown.url}). Commands that read files it hasn't fetched yet fail with I/O errors until it can.` : null;

  // Runs and copies that didn't come from this page's forms (WebMCP tools, a script): in the
  // history too, tagged with who asked, so the person sees what an agent did
  const BY = { webmcp: "WebMCP", script: "a script" };
  const others = new Map(); // job id or copy id: the run in the history
  async function activity(e) {
    if (e.kind === "preview") {
      showPreview(e.preview);
      if (e.preview && e.source !== "form") {
        const r = e.result ?? {};
        panel.record({ command: `open preview ${e.preview.runtime}:${e.preview.port} ${e.preview.path}`, runtime: `by ${BY[e.source] ?? e.source}`,
          state: r.error ? "failed" : "exited", exitStatus: r.error ? null : 0, error: r.error, endedAt: Date.now(),
          output: r.error ? `${e.preview.url}\n${r.error}` : `${e.preview.url}\nanswered ${r.status} ${r.statusText ?? ""}`.trim() });
      }
      return;
    }
    if (e.source === "form") return;
    if (e.kind === "run") {
      const run = { jobId: e.jobId, command: e.command, runtime: `${e.runtime}, by ${BY[e.source] ?? e.source}`, state: "running", output: "" };
      others.set(e.jobId, run);
      panel.record(run);
    } else if (e.kind === "job" && others.has(e.jobId)) {
      const run = others.get(e.jobId);
      others.delete(e.jobId);
      try {
        const v = await api.readJob(e.jobId);
        panel.update(run, { state: v.state, exitStatus: v.exitStatus, error: v.error, output: SnowglobeAgent.jobText(v).replace(/^\n(?=\[)/, ""), endedAt: Date.now() });
      } catch (err) {
        panel.update(run, { state: "failed", error: err?.message ?? String(err), endedAt: Date.now() });
      }
    } else if (e.kind === "copy") {
      let run = others.get(e.id);
      if (!run) {
        run = { command: `copy ${e.from} → ${e.to}`, runtime: `by ${BY[e.source] ?? e.source}`, state: "running", output: "" };
        others.set(e.id, run);
        panel.record(run);
      }
      if (e.state === "running") return;
      others.delete(e.id);
      const r = e.result;
      panel.update(run, r ? { state: "copied", output: `Copied ${r.bytes} bytes. sha256 ${r.sha256}, checked on both ends.`, endedAt: Date.now() }
        : { state: e.state === "cancelled" ? "cancelled" : "failed", error: e.error, output: e.error ?? "", endedAt: Date.now() });
    }
  }
  runtimeSelect.addEventListener("change", () => {
    history.replaceState(null, "", `?runtime=${encodeURIComponent(runtimeSelect.value)}`);
    // The preview form follows the selected machine, while no preview is open
    if (!current) {
      previewRuntime.value = runtimeSelect.value;
      previewPort.value = String(portFor(runtimeSelect.value));
    }
    render();
    panel.refresh();
    if (terminalBox.open) mountTerminal();
  });

  // ---------------------------------------------------------------- the awake limit
  // For this page load: it runs nothing, so it asks no one
  const limitInput = $("awake-limit");
  limitInput.max = String(SnowglobeScheduler.defaults.MAX_BUDGET);
  limitInput.value = String(scheduler.budget);
  limitInput.addEventListener("change", async () => {
    const n = Number(limitInput.value);
    if (!Number.isInteger(n) || n < 1 || n > SnowglobeScheduler.defaults.MAX_BUDGET) {
      panel.say(`Machines awake at once: a whole number from 1 to ${SnowglobeScheduler.defaults.MAX_BUDGET}.`);
      limitInput.value = String(scheduler.budget);
      return;
    }
    try {
      const r = await api.setAwakeLimit(n);
      panel.say(`Up to ${r.awakeLimit} machine${r.awakeLimit === 1 ? "" : "s"} awake at once; ${r.awake} awake now.${r.overLimit ? ` ${r.overLimit}.` : ""}`);
    } catch (e) {
      panel.say(`${e?.message ?? e}`.replace(/^(.)/, (c) => c.toUpperCase()) + ".");
    }
    render();
  });

  // ---------------------------------------------------------------- the machines
  const list = $("machines");
  list.replaceChildren(); // the static list, until now
  const rows = new Map();
  const STATE_TEXT = { asleep: "asleep", awake: "awake", busy: "busy", waking: "waking", suspending: "suspending", failed: "failed" };
  for (const m of machines) {
    const li = doc.createElement("li");
    li.className = "machine";
    li.innerHTML = `<button class="pick" type="button"></button><span class="state"></span><p class="purpose"></p><div class="facts"></div>`;
    li.querySelector(".pick").textContent = m.title.replace(/ in the browser$/, "");
    li.querySelector(".pick").addEventListener("click", () => {
      runtimeSelect.value = m.name;
      runtimeSelect.dispatchEvent(new Event("change"));
      $("agent-command").focus();
    });
    li.querySelector(".purpose").textContent = m.purpose;
    list.append(li);
    rows.set(m, li);
  }

  async function act(fn) {
    try { await fn(); } catch (e) { panel.say(`${e?.message ?? e}`.replace(/^(.)/, (c) => c.toUpperCase()) + "."); }
    render();
  }

  const button = (label, fn, aria) => {
    const b = doc.createElement("button");
    b.type = "button";
    b.className = "link";
    b.textContent = label;
    if (aria) b.setAttribute("aria-label", aria);
    b.addEventListener("click", () => act(fn));
    return b;
  };

  let rendering = false;
  function render() {
    if (rendering) return;
    rendering = true;
    requestAnimationFrame(() => {
      rendering = false;
      for (const m of machines) drawRow(m);
      const awake = scheduler.awake().length;
      $("budget").querySelector("b").textContent = `${awake} of ${scheduler.budget} awake`;
      if (doc.activeElement !== limitInput && limitInput.value !== String(scheduler.budget)) limitInput.value = String(scheduler.budget);
      $("limit-note").textContent = scheduler.over ?? "";
      const storeErr = machines.find((m) => m.slot.error)?.slot.error;
      $("storage").textContent = storeErr ? `Not saving in this tab: ${storeErr}. It tries again at the next suspend.`
        : "A machine's files are saved in this browser when it is suspended. What an awake machine did since then is lost on reload.";
      const m = selected();
      $("terminal-label").textContent = terminalBox.open ? `Hide ${m.name}'s terminal` : `Show ${m.name}'s terminal`;
      $("agent-sample").textContent = m.sample ? `Try: ${m.sample}` : "Runs as root, from /root, one at a time per machine.";
      copyGo.disabled = !!copying;
      copyCancel.disabled = !copying;
      noteTerminal();
    });
  }

  function drawRow(m) {
    const li = rows.get(m);
    const d = api._describe(m);
    li.dataset.state = d.state;
    li.setAttribute("aria-current", String(m.name === runtimeSelect.value));
    let state = STATE_TEXT[d.state];
    if (d.state === "waking" && m.loading != null) state = `waking ${m.loading}%`;
    if (d.state === "busy") state = m.job ? "busy: a job" : m.xfers ? "busy: a copy" : m.previews.size ? "busy: a preview" : "busy";
    li.querySelector(".state").textContent = state;
    const facts = [];
    if (d.state === "asleep") facts.push(d.saved ? `saved ${new Date(d.savedAt ?? Date.now()).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "not started");
    if (d.memoryMB) facts.push(`${d.memoryMB} MB`);
    if (d.wakeSeconds != null && d.state !== "asleep") facts.push(`woke in ${d.wakeSeconds} s`);
    if (d.state === "failed") facts.push(d.error);
    if (d.unsaved) facts.push("not saved yet");
    if (d.filesUnreachable) facts.push(d.filesUnreachable);
    if (d.cpus > 1) facts.push(`${d.cpus} CPUs`);
    if (d.previewPorts.length) facts.push(`preview: port ${d.previewPorts.join(", ")}`);
    if (d.unavailable) facts.push(`not in this page load: ${isolation.reason ?? "it isn't cross-origin isolated"}`);
    const box = li.querySelector(".facts");
    const parts = facts.map((f) => Object.assign(doc.createElement("span"), { textContent: f }));
    const acts = doc.createElement("span");
    acts.className = "acts";
    if (d.state === "failed") acts.append(button("Retry", () => api.retry(m.name), `Retry ${m.name}`));
    if (d.state === "awake") acts.append(button("Suspend", () => api.suspend(m.name), `Suspend ${m.name}`));
    if ((d.saved || d.state === "awake") && d.state !== "busy") acts.append(button("Start fresh…", () => api.startFresh(m.name), `Start ${m.name} fresh`));
    if (acts.childElementCount) parts.push(acts);
    // Rebuilt only when it changed, so focus on a button survives the frequent redraws
    const key = facts.join("|") + "|" + [...acts.children].map((b) => b.textContent).join(",");
    if (box.dataset.key !== key) {
      box.dataset.key = key;
      box.replaceChildren(...parts);
    }
  }

  // ---------------------------------------------------------------- the copy form
  const copyGo = $("copy-go");
  const copyCancel = $("copy-cancel");
  let copying = null;
  const mb = (n) => n < 1 << 20 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KiB` : `${(n / (1 << 20)).toFixed(1)} MiB`;
  $("copy-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (copying) return;
    const req = { fromRuntime: copyFrom.value, fromPath: $("copy-from-path").value.trim(), toRuntime: copyTo.value, toPath: $("copy-to-path").value.trim() };
    const what = `${req.fromRuntime}:${req.fromPath} → ${req.toRuntime}:${req.toPath}`;
    copying = new AbortController();
    render();
    const run = { command: `copy ${what}`, runtime: `${req.fromRuntime} → ${req.toRuntime}`, state: "running", output: "" };
    try {
      copyText = "Waiting for the person at this page to allow it…";
      panel.refresh();
      await ask();
      panel.record(run);
      copyText = `Copying ${what}: starting…`;
      panel.refresh();
      const r = await api.copyFile(req, {
        source: "form",
        signal: copying.signal,
        onProgress: (p) => {
          copyText = `Copying ${what}: ${p.phase === "read" ? "reading" : "writing"} ${mb(p.done)} of ${mb(p.total)}…`;
          panel.say(copyText);
        },
      });
      const text = `Copied ${r.bytes} bytes. sha256 ${r.sha256}, checked on both ends.\nRead in ${r.readSeconds.toFixed(1)} s, written in ${r.writeSeconds.toFixed(1)} s` +
        ` (${Math.round(r.bytes / 1024 / Math.max(r.readSeconds, 0.001))} and ${Math.round(r.bytes / 1024 / Math.max(r.writeSeconds, 0.001))} KiB/s).`;
      copyText = null;
      panel.update(run, { state: "copied", output: text, endedAt: Date.now() });
      panel.last = `Copied ${r.bytes} bytes to ${req.toRuntime}:${req.toPath}.`;
      panel.say(panel.last);
    } catch (err) {
      copyText = null;
      const cancelled = err?.name === "AbortError";
      const msg = cancelled ? "Copy cancelled: nothing was written at the target." : `Copy failed: ${err?.message ?? err}.`;
      if (panel.runs.includes(run)) panel.update(run, { state: cancelled ? "cancelled" : "failed", error: err?.message ?? String(err), output: msg, endedAt: Date.now() });
      panel.last = msg;
      panel.say(msg);
    } finally {
      copying = null;
      render();
      panel.refresh();
    }
  });
  copyCancel.addEventListener("click", () => {
    copying?.abort();
    panel.say("Cancelling the copy…");
  });

  // ---------------------------------------------------------------- the preview
  // A machine's web server, in a frame of this page: its address is the preview's, under preview/,
  // which the service worker carries to the machine (preview.js). One at a time
  const previewForm = $("preview-form");
  const previewRuntime = $("preview-runtime");
  const previewPort = $("preview-port");
  const previewPath = $("preview-path");
  const previewOpen = $("preview-open");
  const previewClose = $("preview-close");
  const previewPanel = $("preview-panel");
  const previewFrame = $("preview-frame");
  const previewAddress = $("preview-address");
  const previewTab = $("preview-tab");
  const previewNote = $("preview-note");
  // Where each machine's servers usually are: web's built pages on 4173, an app on 3000 elsewhere
  const PORTS = { web: 4173 };
  const lastPort = new Map();
  const portFor = (rt) => lastPort.get(rt) ?? PORTS[rt] ?? 3000;
  previewRuntime.replaceChildren(...machines.filter((m) => m.network).map((m) => new Option(m.title.replace(/ in the browser$/, ""), m.name)));
  if ([...previewRuntime.options].some((o) => o.value === runtimeSelect.value)) previewRuntime.value = runtimeSelect.value;
  previewPort.value = String(portFor(previewRuntime.value));
  previewRuntime.addEventListener("change", () => { previewPort.value = String(portFor(previewRuntime.value)); });
  let current = null; // the open preview: { runtime, port, path, url, base }
  const previewable = !!navigator.serviceWorker?.controller;
  if (!previewable) {
    previewOpen.disabled = true;
    previewNote.textContent = `The preview needs this page's service worker, and ${isolation.reason ?? "it isn't in control"}.`;
  }

  // The service worker answers a preview request from the tab it belongs to: this tab says which
  // navigations of its frame (and its open-in-a-tab link) are its own, just before they happen
  const claim = (url) => {
    try { navigator.serviceWorker?.controller?.postMessage({ type: "snowglobe-preview-nav", url: new URL(url, location.href).href }); } catch {}
  };
  const navigate = (url) => {
    claim(url);
    previewFrame.src = url;
  };
  previewTab.addEventListener("click", () => claim(previewTab.href));

  function showPreview(p) {
    current = p;
    previewPanel.hidden = !p;
    previewClose.disabled = !p;
    if (!p) {
      previewFrame.removeAttribute("src");
      previewNote.textContent = previewable ? "No preview is open. A server in a machine must listen on 0.0.0.0 to be seen here." : previewNote.textContent;
      render();
      return;
    }
    previewRuntime.value = p.runtime;
    previewPort.value = String(p.port);
    previewPath.value = p.path;
    lastPort.set(p.runtime, p.port);
    previewAddress.value = p.path;
    previewTab.href = p.url;
    navigate(p.url);
    previewNote.textContent = `${p.runtime}'s port ${p.port}, at ${p.base}. The machine stays awake while the preview is open; ` +
      `the page in it reaches other machines at ${p.base.replace(/[^/]+\/\d+\/$/, "")}<runtime>/<port>/.`;
    render();
  }

  // The address bar follows what the frame shows (it is this site's: same origin)
  previewFrame.addEventListener("load", () => {
    if (!current) return;
    try {
      const loc = previewFrame.contentWindow.location;
      const base = new URL(current.base);
      if (loc.pathname.startsWith(base.pathname)) {
        previewAddress.value = "/" + loc.pathname.slice(base.pathname.length) + loc.search + loc.hash;
        previewTab.href = loc.href;
      }
    } catch {}
  });
  const go = (path) => {
    if (!current) return;
    let p = path.trim() || "/";
    if (!p.startsWith("/")) p = "/" + p;
    try {
      const url = SnowglobePreview.previewUrl(location.href, current.runtime, current.port, p);
      navigate(url);
      previewTab.href = url;
    } catch (e) {
      panel.say(`${e.message}.`);
    }
  };
  previewAddress.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      go(previewAddress.value);
    }
  });
  $("preview-reload").addEventListener("click", () => {
    try {
      claim(previewFrame.contentWindow.location.href);
      previewFrame.contentWindow.location.reload();
    } catch { go(previewAddress.value); }
  });
  previewForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!previewable) return;
    const req = { runtime: previewRuntime.value, port: Number(previewPort.value), path: previewPath.value.trim() || "/" };
    previewOpen.disabled = true;
    panel.say(`Opening ${req.runtime}'s port ${req.port}…`);
    try {
      const r = await api.openPreview(req, { source: "form" });
      panel.say(r.error ? `The preview is open; its first request failed: ${r.error}` : `The preview shows ${req.runtime}'s port ${req.port}: it answered ${r.status}.`);
    } catch (err) {
      panel.say(`${err?.message ?? err}`.replace(/^(.)/, (c) => c.toUpperCase()) + ".");
    } finally {
      previewOpen.disabled = !previewable;
      render();
    }
  });
  previewClose.addEventListener("click", () => act(() => api.closePreview({ source: "form" })));

  // The service worker hands each preview request over a channel of its own: answered here, by
  // the machine (api.previewRequest), as it comes; the worker gives up on a page that doesn't take it
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

  // ---------------------------------------------------------------- the terminal
  const terminalBox = $("terminal-box");
  let term = null;
  let fit = null;
  let mounted = null;
  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = doc.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`could not load ${src}`));
    doc.head.append(s);
  });
  async function xterm() {
    if (root.Terminal) return;
    const base = new URL(manifest.xterm, location.href);
    const css = doc.createElement("link");
    css.rel = "stylesheet";
    css.href = new URL("xterm.css", base).href;
    doc.head.append(css);
    await loadScript(new URL("xterm.js", base).href);
    await loadScript(new URL("addon-fit.js", base).href);
  }
  const root = window;
  function sizeToGuest() {
    if (!term || !mounted) return;
    fit.fit();
    if (mounted.lifecycle.state === "running") mounted.host?.resize(term.cols, term.rows);
  }
  function noteTerminal() {
    const note = $("terminal-note");
    if (!mounted) return (note.hidden = true);
    const st = api._describe(mounted).state;
    note.hidden = st === "awake" || st === "busy";
    note.textContent = st === "asleep" ? `${mounted.name} is asleep. A key typed here wakes it.` : st === "failed" ? `${mounted.name} failed.` : `${mounted.name} is ${st}…`;
  }
  async function mountTerminal() {
    await xterm();
    const m = selected();
    if (!term) {
      term = new Terminal({ cursorBlink: true, scrollback: 5000, fontSize: matchMedia("(max-width: 640px)").matches ? 13 : 12.5,
        fontFamily: "Fragment Mono, ui-monospace, Menlo, Consolas, monospace", theme: { background: "#0b0b0c", foreground: "#e9e9e4" } });
      fit = new FitAddon.FitAddon();
      term.loadAddon(fit);
      term.open($("terminal"));
      new ResizeObserver(() => sizeToGuest()).observe($("terminal"));
      term.onData((data) => {
        const t = mounted;
        if (!t) return;
        t.lastUsed = Date.now();
        if (t.lifecycle.state === "running" && t.host) { t.lifecycle.touch(); t.dirty = true; return t.host.input(data); }
        // Asleep: what is typed waits for the wake it starts, kept with the machine it was typed to
        t.typed = (t.typed ?? "") + data;
        api.wake(t.name).catch((e) => {
          t.typed = "";
          panel.say(`Could not wake ${t.name}: ${e.message}.`);
        });
      });
    }
    // Another machine: what was typed to the one before (asleep) is dropped, never sent here
    if (mounted && mounted !== m) { mounted.onConsole = null; mounted.onWake = null; mounted.typed = ""; }
    mounted = m;
    term.reset();
    for (const bytes of m.tape) term.write(bytes);
    m.onConsole = (bytes) => term.write(bytes);
    m.onWake = () => {
      setTimeout(() => {
        sizeToGuest();
        if (m.typed && m.host && mounted === m) { m.dirty = true; m.host.input(m.typed); }
        m.typed = "";
      }, 0);
    };
    sizeToGuest();
    term.focus();
    render();
  }
  terminalBox.addEventListener("toggle", () => {
    if (terminalBox.open) mountTerminal().catch((e) => panel.say(`The terminal could not load: ${e.message}.`));
    render();
  });

  // ---------------------------------------------------------------- WebMCP
  api._webmcp = { available: false, registered: [], reason: "looking for WebMCP (document.modelContext)" };
  SnowglobeWebMCP.register(api, { jobText: SnowglobeAgent.jobText, exposedTo: manifest.exposed_to ?? [], ask, waitMs: 15000 })
    .then((r) => { api._webmcp = r; }, (e) => { api._webmcp = { available: false, registered: [], reason: String(e?.message ?? e) }; });

  // The slots: what each machine has saved, before anything boots
  await Promise.all(machines.map((m) => m.slot.open()));
  render();
  panel.refresh();
})();
