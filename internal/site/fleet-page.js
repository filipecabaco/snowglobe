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
  // person's yes. Nothing else can start one, but the page's own window.snowglobeFleet.api is not
  // exposed to tools, so the gate only has to say "granted" once a click has run something. The
  // preview answers its frame's requests only after that.
  let clicked = false;
  const ask = async () => {};
  ask.granted = () => clicked;
  const scheduler = new SnowglobeScheduler.Scheduler({ onchange: () => render() });
  const api = SnowglobeOrchestrator.createAgents(manifest, {
    pageUrl: location.href, scheduler, Machine: SnowglobeMachine.Machine, createMachine: SnowglobeHost.createMachine,
    ask, confirmFresh: async () => false, onchange: () => render(), hidden: doc.hidden, isolated: isolation.isolated,
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
  const machinesList = $("fleet-machines");
  const frame = $("fleet-frame");
  const frameBox = $("fleet-frame-box");
  const frameTitle = $("fleet-frame-title");

  let current = null; // { plan, run } for what the text says now
  let parseError = null;

  function read() {
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
      go.disabled = busy() || !ready;
      go.title = ready ? "" : `needs ${s.needs.join(", ")} first`;
      go.addEventListener("click", () => {
        clicked = true;
        run.runStep(s.key).then(() => after(s), (e) => say(e.message));
      });
      const head = el("div", "step-head");
      const dot = el("span", "dot");
      dot.dataset.on = st.status === "running" ? "live" : st.status === "done" ? "ok" : "";
      dot.setAttribute("aria-hidden", "true");
      head.append(dot, el("b", null, `${s.kind} ${s.name}`), el("span", "step-sum", s.summary), go);
      const row = li(head);
      const state = st.status === "failed" ? st.error : st.status === "running" ? (st.detail ?? "running…") : st.status === "done" ? st.detail : "";
      if (state) row.append(el("p", "step-state" + (st.status === "failed" ? " bad" : ""), state));
      if (st.output && st.status !== "done") row.append(el("pre", "step-out", st.output));
      return row;
    }));
    runAll.disabled = busy() || !steps.length || steps.every((s) => run.state(s.key).status === "done");

    // Only the machines this fleet uses
    machinesList.replaceChildren(...machines.filter((m) => steps.some((s) => s.runtime === m.name)).map((m) => {
      const d = api._describe(m);
      return li(el("b", null, m.name), ` ${d.state}`, d.doing ? ` · ${d.doing}` : "", d.unavailable ? ` · ${d.unavailable}` : "");
    }));
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

  runAll.addEventListener("click", async () => {
    if (!current) return;
    clicked = true;
    const { plan, run } = current;
    say("Running the fleet…");
    const ok = await run.runAll();
    for (const s of plan.steps) after(s);
    say(ok ? "The fleet is up." : "A step failed. Run all continues from there.");
  });

  $("fleet-frame-close").addEventListener("click", async () => {
    frame.removeAttribute("src");
    frameBox.hidden = true;
    try { await api.closePreview({ source: "fleet" }); } catch {}
    render();
  });

  text.addEventListener("input", () => { if (!busy()) read(); });
  $("fleet-file").addEventListener("change", async (e) => {
    const f = e.target.files?.[0];
    if (!f || busy()) return;
    if (f.size > 256 << 10) { say("That file is over 256 KiB."); return; }
    text.value = await f.text();
    e.target.value = "";
    read();
  });
  $("fleet-example").addEventListener("click", async () => {
    if (busy()) return;
    try {
      const r = await fetch("snowglobe.toml", { cache: "no-cache" });
      if (!r.ok) throw new Error(String(r.status));
      text.value = await r.text();
      read();
    } catch (e) {
      say(`The example could not be loaded (${e.message}).`);
    }
  });

  if (!isolation.isolated) say(`Machines on several CPUs are off: ${isolation.reason ?? "this page isn't cross-origin isolated"}.`);
  else say("");
  // The example, to begin with: the file beside the page (the repo's examples/fleet/snowglobe.toml)
  read();
  $("fleet-example").click();
})();
