// The agent page's own elements (site/agent/index.html) over orchestrator.js. At the top, the
// studio: the app an agent builds in its preview (with its width, address, reload, and its build's
// state), its code (studio.js: the project's tree and files, read from the machine) and database
// (Supabase's tables), and beside it the agent's steps as a conversation (builder.js's feed), how
// to connect an agent, undo and revert. Below, the machines: their list and state,
// the awake limit, the command form (agent-panel.js), the preview, the copy form, the terminal of
// the selected machine. And the WebMCP tools. Everything here runs only in answer
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

  // No dialog: the machines live in this tab, not on the person's computer, so there is nothing to
  // ask about. Only "Start fresh" (it deletes saved files) still confirms, below.
  const ask = async () => {};
  ask.granted = () => true;
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
    builderActivity(e).catch(() => {});
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
        : "";
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
  const studio = $("studio");
  // Where each machine's servers usually are: web's built pages on 4173, an app on 3000 elsewhere
  const PORTS = { conduit: 4173, web: 4173 };
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

  const previewBar = $("preview-bar");
  const previewEmpty = $("preview-empty");
  function showPreview(p) {
    const was = current;
    current = p;
    studio.classList.toggle("open", !!p);
    // Its server's builds: read while it is open, a new one reloads it (builder.js)
    if (!p) buildWatch.stop();
    else if (!was || was.runtime !== p.runtime || was.port !== p.port || !buildWatch.running) buildWatch.start();
    previewPanel.hidden = !p;
    previewBar.hidden = !p;
    previewEmpty.hidden = !!p;
    previewClose.disabled = !p;
    showBuilding(false);
    showBuildFail(null);
    if (!p) {
      previewFrame.removeAttribute("src");
      previewNote.textContent = previewable ? "" : previewNote.textContent;
      render();
      return;
    }
    previewRuntime.value = p.runtime;
    previewPort.value = String(p.port);
    previewPath.value = p.path;
    lastPort.set(p.runtime, p.port);
    $("preview-host").textContent = `${p.runtime}:${p.port}`;
    previewAddress.value = p.path;
    previewTab.href = p.url;
    navigate(p.url);
    previewNote.textContent = `${p.runtime}'s port ${p.port}, at ${p.base}. The machine stays awake while the preview is open; ` +
      `the page in it reaches other machines at ${p.base.replace(/[^/]+\/\d+\/$/, "")}<runtime>/<port>/.`;
    render();
  }

  // The address bar follows what the frame shows (it is this site's: same origin)
  previewFrame.addEventListener("load", () => {
    previewFrame.classList.remove("reloading");
    if (!current) return;
    shownBuild = lastOk;
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
  /** The preview's page loaded again, where it is (its path kept) */
  function reloadPreview() {
    if (!current) return;
    previewFrame.classList.add("reloading");
    setTimeout(() => previewFrame.classList.remove("reloading"), 4000);
    try {
      claim(previewFrame.contentWindow.location.href);
      previewFrame.contentWindow.location.reload();
    } catch { go(previewAddress.value); }
  }
  $("preview-reload").addEventListener("click", reloadPreview);
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
  // A WebSocket the page in the preview opens to a machine (preview-hook.js), spoken here (api.previewSocket)
  addEventListener("message", (e) => { if (e.data?.type === "snowglobe-preview-socket" && e.origin === location.origin && e.source === previewFrame.contentWindow && e.ports?.[0]) api.previewSocket(e.data, e.ports[0]); });

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

  // ---------------------------------------------------------------- the agent's steps
  // Every run, write, read and copy in every machine, as the agent's conversation (newest last on
  // screen, newest first in reading order), with the files each changed in a watched project (web's
  // /root/app) and their diffs; the open preview's builds, and its reloads after them
  const B = SnowglobeBuilder;
  const St = SnowglobeStudio;
  const stream = $("stream");
  const feedEmpty = $("feed-empty");
  const connect = $("connect");
  // Held at its end while the person is there: a new step scrolls into view, as in a chat
  let stick = true;
  stream.addEventListener("scroll", () => { stick = stream.scrollHeight - stream.scrollTop - stream.clientHeight < 48; });
  const toEnd = () => { if (stick) requestAnimationFrame(() => { stream.scrollTop = stream.scrollHeight; }); };
  const feed = new B.Feed($("feed"), { doc, onchange: () => { feedState(); toEnd(); } });
  const feedFilter = $("feed-filter");
  feedFilter.append(...machines.map((m) => new Option(m.title.replace(/ in the browser$/, ""), m.name)));
  function feedState() {
    const any = feed.entries.length > 0;
    feedEmpty.hidden = !any || feed.entries.some((e) => feed.shows(e));
    feedEmpty.textContent = "Nothing from this machine yet.";
    // How to connect an agent, until one does something
    connect.hidden = any;
  }
  feedFilter.addEventListener("change", () => { feed.setFilter(feedFilter.value); feedState(); });
  $("feed-clear").addEventListener("click", () => { feed.clear(); feedState(); });
  const builderStatus = $("builder-status");
  const sayBuilder = (text) => { if (builderStatus.textContent !== text) builderStatus.textContent = text; };
  const feedRuns = new Map(); // job or copy id: its entry
  const secs = (ms) => ms == null ? "" : ms < 10000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`;

  // The dot by "Agent": live while an agent's step runs, ink once a model context has the tools
  const agentDot = $("agent-dot");
  let agentRunning = 0;
  const drawDot = () => { agentDot.dataset.on = agentRunning > 0 ? "live" : api._webmcp?.registered?.length ? "ok" : ""; };
  const fromAgent = (source) => source !== "form" && source !== "studio";

  async function builderActivity(e) {
    if (e.kind === "run") {
      feedRuns.set(e.jobId, feed.add({ kind: "run", runtime: e.runtime, source: e.source, command: e.command, state: "running", watch: e.watch }));
      if (fromAgent(e.source)) { agentRunning++; drawDot(); }
    } else if (e.kind === "job") {
      const entry = feedRuns.get(e.jobId);
      code.jobEnded(e.runtime);
      if (!entry) return;
      feedRuns.delete(e.jobId);
      if (fromAgent(entry.source)) { agentRunning = Math.max(0, agentRunning - 1); drawDot(); }
      let v;
      try { v = await api.readJob(e.jobId); } catch (err) { v = { state: "failed", error: err?.message ?? String(err) }; }
      feed.update(entry, { state: v.state, exitStatus: v.exitStatus, error: v.error, changes: v.changes ?? null });
      const touched = !!v.changes?.files.length;
      if (touched) {
        sayBuilder(`${e.runtime}: ${B.summary(v.changes)}.${current?.runtime === e.runtime && buildWatch.supported !== false ? " Waiting for the rebuild…" : ""}`);
        code.changed(e.runtime, v.changes);
      }
      if (/^SQL: /.test(entry.command ?? "")) db.stale();
      if (current?.runtime === e.runtime) {
        // A change in the previewed machine: its server's build is read often for a while; a server
        // with no /__build (plain `serve`, `vite preview`) has the preview reloaded instead
        if (buildWatch.supported === false) reloadPreview();
        else buildWatch.kick();
      }
    } else if (e.kind === "read" || e.kind === "list") {
      feed.add({ kind: e.kind, runtime: e.runtime, source: e.source, paths: e.paths, path: e.path });
    } else if (e.kind === "copy") {
      let entry = feedRuns.get(e.id);
      if (!entry) feedRuns.set(e.id, (entry = feed.add({ kind: "run", runtime: e.to.split(":")[0], source: e.source, command: `copy ${e.from} → ${e.to}`, state: "running" })));
      if (e.state === "running") return;
      feedRuns.delete(e.id);
      feed.update(entry, e.result ? { state: "exited", exitStatus: 0, text: `Copied ${e.result.bytes} bytes.` }
        : { state: e.state === "cancelled" ? "cancelled" : "failed", error: e.error });
      if (current && e.result && e.to.startsWith(current.runtime + ":")) buildWatch.kick();
    } else if (e.kind === "preview") {
      if (e.preview) feed.add({ kind: "preview", runtime: e.preview.runtime, source: e.source,
        text: `Opened the preview on ${e.preview.runtime}'s port ${e.preview.port}${e.result?.error ? `; its first request failed: ${e.result.error}` : ""}` });
      else feed.add({ kind: "preview", text: `Closed the preview${e.why && e.why !== "closed" ? ` (${e.why})` : ""}` });
    }
  }

  // ---------------------------------------------------------------- the preview's builds
  // The previewed server's /__build (serve --watch): a new build reloads the preview; a failed one
  // is shown over it, and the preview keeps the last page that built
  const building = $("building");
  const buildFail = $("build-fail");
  const showBuilding = (on) => { building.hidden = !on; };
  function showBuildFail(b) {
    buildFail.hidden = !b;
    if (b) {
      $("build-fail-title").textContent = `Build ${b.version} failed: the preview keeps the last page that built`;
      $("build-fail-text").textContent = String(b.error ?? "unknown error").trim();
    }
  }
  $("build-fail-close").addEventListener("click", () => showBuildFail(null));
  const buildWatch = new B.BuildWatch({
    get: () => current ? api.previewGet({ runtime: current.runtime, port: current.port, path: "/__build" }) : Promise.resolve(null),
    visible: () => !doc.hidden,
    onState: (b) => {
      showBuilding(b?.state === "building");
      if (b?.state === "building") sayBuilder(`${current?.runtime ?? "The machine"} is rebuilding its app…`);
    },
    onBuild: (b) => {
      const rt = current?.runtime;
      if (b.state === "ok") {
        lastOk = b.version;
        reloadPreview();
        showBuildFail(null);
        feed.add({ kind: "build", runtime: rt, state: "ok", version: b.version, ms: b.ms, text: "The preview reloaded." });
        sayBuilder(`${rt} rebuilt its app${b.ms != null ? ` in ${secs(b.ms)}` : ""}; the preview reloaded.`);
      } else if (b.state === "error") {
        showBuildFail(b);
        feed.add({ kind: "build", runtime: rt, state: "error", version: b.version, error: b.error ?? "unknown error", text: "The preview keeps the last page that built." });
        sayBuilder(`${rt}'s build failed: ${String(b.error ?? "").split("\n").find((l) => l.trim()) ?? "see the steps"}`);
      }
    },
  });
  addEventListener("visibilitychange", () => { if (!doc.hidden && current) buildWatch.kick(); });

  // ---------------------------------------------------------------- the agent's eyes on the preview
  // preview_snapshot and preview_interact (inspect.js): the page in the preview, read and used from
  // here (it is this site's: same origin). What it logs comes from the hook the service worker puts
  // in each of its pages (preview-hook.js), posted here. The build line says whether what it shows
  // is the server's latest build
  const I = SnowglobeInspect;
  const inspector = new I.Inspector();
  let lastOk = null; // the last build seen to succeed
  let shownBuild = null; // the build the preview's page was last loaded with
  addEventListener("message", (e) => {
    if (e.data?.type !== "snowglobe-preview-log" || e.origin !== location.origin || e.source !== previewFrame.contentWindow) return;
    inspector.log(e.data);
  });
  const needPreview = () => {
    if (!current) throw new Error("no preview is open: open_preview first (web, port 4173, for the app)");
  };
  /** The frame's page loaded (not a blank frame, not mid-navigation), or after `ms` anyway. */
  async function loaded(ms = 8000) {
    const t0 = Date.now();
    for (;;) {
      let d = null;
      try { d = previewFrame.contentDocument; } catch {}
      if (d && d.readyState === "complete" && d.URL !== "about:blank") return;
      if (Date.now() - t0 > ms) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const framePath = () => {
    try {
      const loc = previewFrame.contentWindow.location;
      const base = new URL(current.base);
      return loc.pathname.startsWith(base.pathname) ? "/" + loc.pathname.slice(base.pathname.length) + loc.search + loc.hash : loc.href;
    } catch { return null; }
  };
  async function buildLine() {
    try {
      const r = await api.previewGet({ runtime: current.runtime, port: current.port, path: "/__build" });
      return I.buildText(r?.status === 200 ? JSON.parse(r.body) : null, shownBuild);
    } catch { return I.buildText(null); }
  }
  async function look({ maxChars, since, done, error } = {}) {
    const s = inspector.read(previewFrame, { maxChars });
    return { s, text: I.snapshotText(s, { build: await buildLine(), consoleInfo: inspector.consoleSince(since ?? inspector.loadAt),
      path: `${current.runtime}:${current.port}${framePath() ?? ""}`, done, error }) };
  }
  // In the steps: looks one after another are one entry, counted
  let lastLook = null;
  function feedLook(source) {
    if (lastLook && feed.entries[0] === lastLook && Date.now() - lastLook.at < 120000) {
      lastLook.count++;
      feed.update(lastLook, { text: `Looked at the preview (${lastLook.count} times)` });
      return;
    }
    lastLook = feed.add({ kind: "preview", runtime: current?.runtime, source, text: "Looked at the preview", count: 1 });
  }
  api.previewSnapshot = async ({ maxChars } = {}, { source = "script" } = {}) => {
    needPreview();
    await ask();
    await loaded();
    const { s, text } = await look({ maxChars });
    feedLook(source);
    return { text, url: s.url, title: s.title, outline: s.outline, truncated: s.truncated, console: inspector.consoleSince().lines };
  };
  api.previewInteract = async ({ actions, maxChars = 6000 } = {}, { source = "script", signal } = {}) => {
    needPreview();
    await ask();
    // The person sees it happen
    if (tabs.find((t) => t.id === "tab-preview")?.getAttribute("aria-selected") !== "true") selectTab($("tab-preview"));
    await loaded();
    const t0 = Date.now();
    const r = await I.run(inspector, previewFrame, actions, { signal, settle: (a, o) => I.settle(previewFrame, o) });
    await loaded();
    let text;
    try {
      text = (await look({ maxChars, since: t0, done: r.done, error: r.error })).text;
    } catch (e) {
      text = [...r.done.map((d) => `done: ${d}`), ...(r.error ? [`FAILED: ${r.error}`] : []), `(no snapshot after: ${e?.message ?? e})`].join("\n");
    }
    feed.add({ kind: "preview", runtime: current?.runtime, source, text: I.stepsTitle(r.done, r.error), ...(r.error ? { state: "failed", error: r.error } : {}) });
    lastLook = null;
    return { text, done: r.done, error: r.error ?? null };
  };

  // The preview's width: the app as a desktop, a tablet or a phone sees it
  const device = $("device");
  for (const b of doc.querySelectorAll(".devices button")) {
    b.addEventListener("click", () => {
      device.dataset.size = b.dataset.size;
      for (const o of doc.querySelectorAll(".devices button")) o.setAttribute("aria-pressed", String(o === b));
    });
  }

  // "Open the app": web's built app on port 4173, the studio's usual preview
  const hasWeb = machines.some((m) => m.name === "web");
  const openApp = $("open-app");
  const hasConduit = machines.some((m) => m.name === "conduit");
  openApp.disabled = !previewable || !(hasWeb || hasConduit);
  if (!hasWeb && !hasConduit) openApp.hidden = true;
  openApp.addEventListener("click", async () => {
    openApp.disabled = true;
    const appRuntime = runtimeSelect.value === "conduit" && hasConduit ? "conduit" : hasWeb ? "web" : "conduit";
    openApp.textContent = `Starting ${appRuntime}…`;
    try {
      const r = await api.openPreview({ runtime: appRuntime, port: 4173, path: "/" }, { source: "form" });
      if (r.error) previewNote.textContent = `It opened; its first request failed: ${r.error}`;
    } catch (err) {
      previewNote.textContent = `${err?.message ?? err}`.replace(/^(.)/, (c) => c.toUpperCase()) + ".";
    } finally {
      openApp.textContent = "Open the app";
      openApp.disabled = !previewable;
    }
  });

  // ---------------------------------------------------------------- the stage's tabs
  const tabs = [...doc.querySelectorAll('[role="tab"]')];
  function selectTab(tab, focus = false) {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      t.tabIndex = on ? 0 : -1;
      $(t.getAttribute("aria-controls")).hidden = !on;
    }
    if (focus) tab.focus();
    previewBar.classList.toggle("vh", tab.id !== "tab-preview");
    if (tab.id === "tab-code") code.shown();
    if (tab.id === "tab-db") db.shown();
  }
  for (const t of tabs) {
    t.addEventListener("click", () => selectTab(t));
    t.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(t);
      const to = e.key === "ArrowRight" ? tabs[(i + 1) % tabs.length] : e.key === "ArrowLeft" ? tabs[(i - 1 + tabs.length) % tabs.length]
        : e.key === "Home" ? tabs[0] : e.key === "End" ? tabs.at(-1) : null;
      if (to) { e.preventDefault(); selectTab(to, true); }
    });
  }

  // ---------------------------------------------------------------- the code
  // web's project as files: its tree (list_files), the open file (read_file), highlighted, with the
  // lines its last change added marked, or that change's diff. Read when the Code tab is shown, again
  // as the agent changes files; a read waits for a job in web to end (one job at a time)
  const code = (() => {
    const WATCH = machines.find((m) => m.name === "web")?.watch ?? "/root/app";
    const treeEl = $("code-tree");
    const note = $("code-tree-note");
    const view = $("code-view");
    const empty = $("code-empty");
    const pathEl = $("code-path");
    const meta = $("code-meta");
    const diffBtn = $("code-diff");
    const st = { loaded: false, open: null, text: "", diffShown: false, changed: new Map(), stale: false, retry: null, busy: false };
    const visible = () => !$("panel-code").hidden;

    async function guarded(fn) {
      try {
        st.busy = true;
        return await fn();
      } catch (e) {
        const msg = String(e?.message ?? e);
        // web runs a job: try again once it ends
        if (/busy/.test(msg)) { st.retry = fn; note.textContent = "web is busy with a job; this reads again once it is done."; }
        else note.textContent = msg.replace(/^(.)/, (c) => c.toUpperCase()) + ".";
        return null;
      } finally {
        st.busy = false;
      }
    }

    function drawTree(nodes, ul) {
      ul.replaceChildren(...nodes.map((n) => {
        const li = doc.createElement("li");
        if (n.type === "dir") {
          const d = doc.createElement("div");
          d.className = "dir";
          d.textContent = n.name + "/" + (n.skipped ? " …" : "");
          li.append(d);
          if (!n.skipped) {
            const sub = doc.createElement("ul");
            drawTree(n.children, sub);
            li.append(sub);
          }
        } else {
          const b = doc.createElement("button");
          b.type = "button";
          b.dataset.path = n.path;
          b.textContent = n.name;
          const c = st.changed.get(n.path);
          if (c) {
            const tag = doc.createElement("span");
            tag.className = "chg";
            tag.textContent = c.status === "added" ? "new" : "edited";
            if (Date.now() - c.at < 120000) tag.dataset.fresh = "";
            b.append(tag);
            b.setAttribute("aria-label", `${n.path}, ${tag.textContent}`);
          }
          if (n.path === st.open) b.setAttribute("aria-current", "true");
          b.addEventListener("click", () => openFile(n.path));
          li.append(b);
        }
        return li;
      }));
    }

    async function loadTree() {
      note.textContent = "Reading web's files…";
      const r = await guarded(() => api.listFiles({ runtime: "web" }, { source: "studio" }));
      if (!r) return;
      st.loaded = true;
      st.entries = r.entries;
      empty.hidden = true;
      drawTree(St.buildTree(r.entries), treeEl);
      note.textContent = `${r.entries.filter((e) => e.type === "file").length} files in ${r.dir ?? WATCH}${r.truncated ? " (the first 2000)" : ""}; node_modules and dist aren't listed.`;
      if (!st.open) {
        const first = ["src/App.jsx", "src/App.tsx"].find((p) => r.entries.some((e) => e.path === p));
        if (first) openFile(first);
      }
    }

    function drawFile() {
      const c = st.changed.get(st.open);
      diffBtn.disabled = !c?.diff;
      diffBtn.setAttribute("aria-pressed", String(st.diffShown && !!c?.diff));
      view.hidden = false;
      if (st.diffShown && c?.diff) {
        view.className = "code diff-view";
        view.setAttribute("aria-label", `Last change to ${st.open}`);
        view.replaceChildren(...B.diffLines(c.diff).map((l) => {
          const span = doc.createElement("span");
          span.className = "ln";
          span.dataset.kind = l.kind;
          span.textContent = l.text + "\n";
          return span;
        }));
        return;
      }
      view.className = "code";
      view.setAttribute("aria-label", `Code of ${st.open}`);
      St.renderCode(doc, view, st.text, St.langOf(st.open), { hot: c?.diff ? St.addedLines(c.diff) : undefined });
    }

    async function openFile(path) {
      st.open = path;
      st.diffShown = false;
      pathEl.textContent = path;
      meta.textContent = "reading…";
      for (const b of treeEl.querySelectorAll("button")) b.toggleAttribute("aria-current", b.dataset.path === path);
      for (const b of treeEl.querySelectorAll("button[aria-current]")) b.setAttribute("aria-current", "true");
      const r = await guarded(() => api.readFiles({ runtime: "web", paths: [`${WATCH}/${path}`] }, { source: "studio" }));
      if (!r || st.open !== path) return;
      const f = r[0];
      if (f.error) { meta.textContent = f.error; st.text = ""; view.hidden = true; return; }
      if (f.binary) { meta.textContent = `${f.size} bytes, binary`; st.text = ""; view.hidden = true; return; }
      st.text = f.text;
      meta.textContent = `${f.text.split("\n").length - (f.text.endsWith("\n") ? 1 : 0)} lines${f.truncated ? `, the first ${Math.round(f.text.length / 1024)} KiB of ${Math.round(f.size / 1024)}` : ""}`;
      drawFile();
    }

    diffBtn.addEventListener("click", () => { st.diffShown = !st.diffShown; drawFile(); });
    $("code-refresh").addEventListener("click", () => { loadTree().then(() => st.open && openFile(st.open)); });
    $("code-load").addEventListener("click", () => loadTree());

    return {
      /** The Code tab is shown: read what is new (only once the person has allowed the page). */
      shown() {
        if (!hasWeb) { note.textContent = "There is no web machine on this page."; return; }
        if (!ask.granted()) return;
        if (!st.loaded || st.stale) {
          st.stale = false;
          loadTree().then(() => st.open && st.loaded && openFile(st.open));
        }
      },
      /** A job in `runtime` changed these files. */
      changed(runtime, changes) {
        if (runtime !== "web") return;
        let shape = false;
        for (const f of changes.files) {
          if (f.status === "deleted") st.changed.delete(f.path);
          else st.changed.set(f.path, { status: f.status, diff: f.diff, at: Date.now() });
          if (f.status !== "modified") shape = true;
          if (f.path === st.open && f.status === "deleted") { st.open = null; view.hidden = true; pathEl.textContent = `${f.path} was deleted`; meta.textContent = ""; }
        }
        if (!st.loaded) return;
        if (!visible()) { st.stale = true; return; }
        const reopen = st.open && changes.files.some((f) => f.path === st.open);
        if (shape) loadTree().then(() => reopen && openFile(st.open));
        else {
          drawTree(St.buildTree(st.entries ?? []), treeEl);
          if (reopen) openFile(st.open);
        }
      },
      /** A job ended in `runtime`: a read that found web busy goes again. */
      jobEnded(runtime) {
        if (runtime !== "web" || !st.retry || st.busy) return;
        const fn = st.retry;
        st.retry = null;
        setTimeout(() => guarded(fn).then((r) => { if (r && Array.isArray(r.entries)) { st.loaded = true; st.entries = r.entries; drawTree(St.buildTree(r.entries), treeEl); note.textContent = ""; } else if (r && st.open) openFile(st.open); }), 300);
      },
    };
  })();

  // ---------------------------------------------------------------- the database
  // Supabase's public tables, their columns and row level security: one psql read, on request, and
  // again after an agent's SQL while the tab is shown
  const db = (() => {
    const list = $("db-tables");
    const note = $("db-note");
    const btn = $("db-load");
    const hasDb = machines.some((m) => m.name === "supabase");
    let loaded = false;
    let stale = false;
    if (!hasDb) { btn.hidden = true; note.textContent = "There is no supabase machine on this page."; }
    async function load() {
      btn.disabled = true;
      btn.textContent = "Reading…";
      try {
        const r = await api.runSql({ runtime: "supabase", sql: St.TABLES_SQL }, { source: "studio", tsv: true, silent: true });
        if (r.state !== "exited" || r.exitStatus !== 0) throw new Error(r.output.trim() || r.error || r.state);
        const tables = St.parseTables(r.output);
        loaded = true;
        list.replaceChildren(...tables.map((t) => {
          const li = doc.createElement("li");
          const h = doc.createElement("h3");
          h.textContent = t.name;
          const rls = doc.createElement("p");
          rls.className = "rls";
          rls.textContent = t.rls === true ? "Row level security on" : t.rls === false ? "Row level security off: anyone with the anon key reads and writes it" : "";
          const table = doc.createElement("table");
          const body = doc.createElement("tbody");
          for (const c of t.columns) {
            const tr = doc.createElement("tr");
            for (const v of [c.name, c.type]) { const td = doc.createElement("td"); td.textContent = v; tr.append(td); }
            body.append(tr);
          }
          table.append(body);
          table.setAttribute("aria-label", `Columns of ${t.name}`);
          li.append(h, rls, table);
          return li;
        }));
        note.textContent = tables.length ? `${tables.length} table${tables.length === 1 ? "" : "s"} in Supabase's public schema, read just now.` : "No tables yet; your agent creates them with run_sql.";
      } catch (e) {
        note.textContent = `The tables could not be read: ${String(e?.message ?? e)}`;
      } finally {
        btn.disabled = false;
        btn.textContent = loaded ? "Read again" : "Show the tables";
      }
    }
    btn.addEventListener("click", load);
    return {
      shown() { if (stale && loaded) { stale = false; load(); } },
      stale() { if ($("panel-db").hidden) stale = true; else if (loaded) load(); },
    };
  })();

  // ---------------------------------------------------------------- connecting an agent
  const promptText = St.agentPrompt(location.origin + location.pathname);
  $("agent-prompt").textContent = promptText;
  const copyPrompt = $("copy-prompt");
  copyPrompt.addEventListener("click", async () => {
    const label = copyPrompt.lastChild;
    try {
      await navigator.clipboard.writeText(promptText);
      label.textContent = "Copied";
    } catch {
      // No clipboard (an insecure context, a refusal): the text is selected for a manual copy
      const range = doc.createRange();
      range.selectNodeContents($("agent-prompt"));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      label.textContent = "Selected: copy it";
    }
    setTimeout(() => { label.textContent = "Copy the prompt"; }, 2500);
  });

  // ---------------------------------------------------------------- undo and revert
  const undoBtn = $("undo-change");
  const revertBtn = $("revert-start");
  if (!hasWeb) { undoBtn.hidden = true; revertBtn.hidden = true; }
  async function revert(to) {
    undoBtn.disabled = revertBtn.disabled = true;
    try {
      if (to === "start" && !(await SnowglobeWebMCP.confirmInPage(doc,
        "web's app goes back to how it was before the first change in this machine. Undo last change brings this back.",
        { title: "Revert the app to the starter?", yes: "Revert", no: "Keep it", danger: true }))) return;
      const r = await api.revert({ runtime: "web", to }, { source: "form" });
      sayBuilder(`${r.output}${r.changes ? ` ${B.summary(r.changes)}.` : ""}`);
    } catch (e) {
      sayBuilder(`${String(e?.message ?? e)}`.replace(/^(.)/, (c) => c.toUpperCase()) + ".");
    } finally {
      undoBtn.disabled = revertBtn.disabled = false;
    }
  }
  undoBtn.addEventListener("click", () => revert("previous"));
  revertBtn.addEventListener("click", () => revert("start"));

  // ---------------------------------------------------------------- WebMCP
  api._webmcp = { available: false, registered: [], reason: "looking for WebMCP (document.modelContext)" };
  const webmcpState = $("webmcp-state");
  SnowglobeWebMCP.register(api, { jobText: SnowglobeAgent.jobText, exposedTo: manifest.exposed_to ?? [], ask, waitMs: 15000 })
    .then((r) => { api._webmcp = r; }, (e) => { api._webmcp = { available: false, registered: [], reason: String(e?.message ?? e) }; })
    .then(() => {
      const w = api._webmcp;
      webmcpState.textContent = w.registered?.length ? `WebMCP: ${w.registered.length} tools offered` : w.available ? "WebMCP: no tools offered" : "No WebMCP here: agents drive the page";
      webmcpState.title = w.reason ?? "";
      drawDot();
    });

  // The slots: what each machine has saved, before anything boots
  await Promise.all(machines.map((m) => m.slot.open()));
  render();
  panel.refresh();
})();
