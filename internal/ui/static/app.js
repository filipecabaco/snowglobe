// snowglobe ui: the daemon's last hour on one time axis. Everything comes from the daemon's API,
// forwarded under /api by `snowglobe ui`. The graph, the inspector and the tasks are Preact
// components (graph.js, inspect.js, tasks.js) reading the same state through store.js.

import { html, render as mount } from "./vendor/preact/index.js";
import { store, publish } from "./store.js";
import { Graph } from "./graph.js";
import { Inspector } from "./inspect.js";
import { Tasks } from "./tasks.js";
import { Fleets } from "./fleets.js";

const HOUR = 60 * 60 * 1000;
const MIN = 60 * 1000;
// What the axis spans: what the daemon has lived, from 10 minutes to an hour
function span() {
  const lived = state.totals ? Date.now() - new Date(state.totals.started).getTime() : HOUR;
  return Math.min(HOUR, Math.max(10 * MIN, Math.ceil((lived + MIN) / (5 * MIN)) * 5 * MIN));
}
const $ = (id) => document.getElementById(id);
const svgNS = "http://www.w3.org/2000/svg";

// --- the API

async function api(path, opts = {}) {
  const res = await fetch("/api" + path, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error((data && data.error) || `${res.status} ${res.statusText}`);
  return data;
}

const b64 = (s) => {
  if (!s) return "";
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// --- formatting

const mb = (bytes) => (bytes / 1048576);
function size(bytes) {
  if (bytes >= 1 << 30) return [(bytes / (1 << 30)).toFixed(1), "GB"];
  return [Math.round(mb(bytes)).toString(), "MB"];
}
function since(t) {
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "dataset") Object.assign(e.dataset, v);
    // Through the CSSOM: the page's CSP refuses style attributes
    else if (k === "style") for (const decl of v.split(";")) {
      const i = decl.indexOf(":");
      if (i > 0) e.style.setProperty(decl.slice(0, i).trim(), decl.slice(i + 1).trim());
    }
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (v !== undefined && v !== null && v !== false) e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat()) if (k !== null && k !== undefined && k !== false) e.append(k);
  return e;
}
const figure = (value, unit) => [value, unit ? el("small", {}, unit) : null];
// Colour and cursor codes out of a program's output
const plain = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
// A duration as the daemon writes it ("5m0s", "1h30m0s"), said shortly
const dur = (d) => (typeof d === "string" ? d.replace(/(\D)0s$/, "$1").replace(/(\D)0m$/, "$1") : "") || "–";

// --- state

const state = {
  stats: null, templates: [], machines: [], services: [], snapshots: [], builds: [], ports: [], runs: [],
  samples: [], totals: null, events: [], lives: new Map(), selected: null, graph: null, links: [], plan: null,
  fleets: [], fleet: null, fleetView: null, view: "overview",
  seen: new Set(), cursorAt: null, reachable: true,
  // What the daemon's mode has on (GET /v1/version); a daemon from before modes has everything
  mode: "full", features: null,
};

const on = (feature) => !state.features || state.features[feature];
// What each view needs on
const VIEWS = { overview: "machines", network: "links", fleets: "fleets", machines: "machines", run: "jobs", builds: "builds" };

async function learnMode() {
  try {
    const v = await api("/v1/version");
    state.mode = v.mode;
    state.features = v.features;
  } catch {}
  for (const a of document.querySelectorAll("#views a")) a.hidden = !on(VIEWS[a.getAttribute("href").slice(1)]);
  if (state.features?.artifacts_only) {
    $("builds-intro").textContent = "Build a site for the page from an image, a Dockerfile written here, or a directory with " +
      "a Dockerfile, packed into one file to download: a static site for any host or CDN. What was built already of " +
      "the same image (its digest) with the same options comes back at once.";
  }
}

function banner(msg) {
  const b = $("banner");
  b.hidden = !msg;
  b.textContent = msg || "";
}

async function refresh() {
  // What the mode has off is not asked for: it is none
  const ask = (path, feature, none = []) => (on(feature) ? api(path) : Promise.resolve(none));
  try {
    const [stats, templates, machines, services, snapshots, builds, ports, runs, graph, links] = await Promise.all([
      api("/v1/stats"), ask("/v1/templates", "templates"), ask("/v1/machines", "machines"), ask("/v1/services", "services"),
      ask("/v1/snapshots", "snapshots"), ask("/v1/builds", "builds"), ask("/v1/ports", "ports"), ask("/v1/runs", "machines"),
      ask("/v1/graph", "links", null), ask("/v1/links", "links"),
    ]);
    Object.assign(state, { stats, templates, machines, services, snapshots, builds, ports, runs, graph, links, reachable: true });
    for (const m of machines) {
      const l = state.lives.get(m.name);
      if (!l || l.end) state.lives.set(m.name, { name: m.name, template: m.template, start: new Date(m.created).getTime(), end: null });
    }
    banner(null);
  } catch (e) {
    state.reachable = false;
    banner(`The daemon isn't answering (${e.message}). Start it with \`snowglobe daemon --detach\`.`);
  }
  render();
}

async function refreshMetrics() {
  if (!on("metrics")) return;
  try {
    const last = state.samples.at(-1);
    const m = await api("/v1/metrics" + (last ? `?since=${new Date(last.time).getTime()}` : ""));
    state.samples.push(...m.samples);
    const cut = Date.now() - HOUR;
    state.samples = state.samples.filter((s) => new Date(s.time).getTime() >= cut);
    state.totals = m.totals;
    state.every = m.every_ms;
    renderSeries();
    renderEvents();
  } catch {}
}

// The daemon's events, kept and then live (server-sent events, read off a fetch)
async function followEvents() {
  if (!on("events")) return;
  for (;;) {
    try {
      const after = state.events.at(-1)?.seq || 0;
      const res = await fetch(`/api/v1/events?after=${after}`);
      if (!res.ok) throw new Error(res.statusText);
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const data = block.split("\n").find((l) => l.startsWith("data: "));
          if (data) onEvent(JSON.parse(data.slice(6)));
        }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
}

let eventsQueued = false;
function onEvent(ev) {
  state.events.push(ev);
  if (state.events.length > 400) state.events.shift();
  const t = new Date(ev.time).getTime();
  const name = ev.subject.replace(/^machine /, "");
  if (ev.kind === "machine.up") {
    const tpl = /up from (\S+)/.exec(ev.message)?.[1] || "";
    state.lives.set(name, { name, template: tpl, start: t, end: null, fresh: state.seen.has("ready") });
  } else if (["machine.removed", "machine.stopped", "machine.expired"].includes(ev.kind)) {
    const l = state.lives.get(name);
    if (l && !l.end) l.end = t;
  }
  if (!eventsQueued) {
    eventsQueued = true;
    requestAnimationFrame(() => { eventsQueued = false; renderEvents(); renderLanes(); });
  }
  // What changed the lists: look again soon
  if (/^(machine|template|service|snapshot|build|link)\./.test(ev.kind)) {
    scheduleRefresh();
    if (state.view === "fleets") refreshFleets();
  }
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 250);
}

// --- the timeline

const x = (t, w) => ((t - (Date.now() - span())) / span()) * w;

function draw(svg, build) {
  const w = svg.clientWidth || 600, h = svg.clientHeight || 60;
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.replaceChildren(...build(w, h));
}

function path(points) {
  return points.map(([px, py], i) => `${i ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`).join("");
}

function renderSeries() {
  const s = state.samples;
  const stats = state.stats;
  const budget = stats?.memory_budget || 0;
  const used = stats?.memory_used ?? s.at(-1)?.memory_used ?? 0;
  $("memory-now").replaceChildren(...figure(...size(used)));
  $("memory-of").textContent = budget ? ` of ${size(budget).join(" ")}` : "";
  $("machines-now").textContent = stats ? `${stats.machines} machines` : "";
  renderStrips();
  const recent = s.slice(-12);
  const p95 = Math.max(0, ...recent.map((v) => v.job_ms_p95));
  $("jobs-now").replaceChildren(...(recent.some((v) => v.jobs) ? figure(Math.round(p95), "ms") : ["–"]));

  const step = state.every || 5000;
  draw($("chart-memory"), (w, h) => {
    const top = Math.max(budget, ...s.map((v) => v.memory_used), 1);
    const y = (v) => h - 4 - (v / top) * (h - 8);
    const nodes = [];
    if (budget) {
      const l = document.createElementNS(svgNS, "line");
      l.setAttribute("class", "budget");
      l.setAttribute("x1", 0); l.setAttribute("x2", w); l.setAttribute("y1", y(budget)); l.setAttribute("y2", y(budget));
      nodes.push(l);
    }
    if (s.length) {
      const p = document.createElementNS(svgNS, "path");
      p.setAttribute("class", "line");
      p.setAttribute("d", path(s.map((v) => [x(new Date(v.time).getTime(), w), y(v.memory_used)])));
      nodes.push(p);
    }
    return nodes;
  });
  draw($("chart-jobs"), (w, h) => {
    const top = Math.max(1, ...s.map((v) => v.jobs));
    const bw = Math.max(1.5, (step / span()) * w * 0.6);
    return s.filter((v) => v.jobs).map((v) => {
      const r = document.createElementNS(svgNS, "rect");
      const bh = Math.max(1, (v.jobs / top) * (h - 6));
      r.setAttribute("class", "bar");
      r.setAttribute("x", x(new Date(v.time).getTime(), w) - bw);
      r.setAttribute("y", h - bh);
      r.setAttribute("width", bw);
      r.setAttribute("height", bh);
      return r;
    });
  });
  renderAxis();
}

// One strip per template: how many of its machines ran at each minute of the hour, on a shared scale
function renderStrips() {
  const now = Date.now(), sp = span(), cut = now - sp, N = 120;
  const names = new Set(state.templates.map((t) => t.name));
  for (const l of state.lives.values()) if (l.template && (!l.end || l.end >= cut)) names.add(l.template);
  const lives = [...state.lives.values()];
  const series = [...names].sort().map((name) => {
    const mine = lives.filter((l) => l.template === name);
    const counts = Array.from({ length: N + 1 }, (_, i) => {
      const t = cut + (i / N) * sp;
      return mine.filter((l) => l.start <= t && (!l.end || l.end >= t)).length;
    });
    return { name, counts, now: mine.filter((l) => !l.end).length };
  });
  const top = Math.max(1, ...series.flatMap((v) => v.counts));
  const strips = $("strips");
  if (!series.length) { strips.replaceChildren(el("p", { class: "strips-none" }, "None yet.")); return; }
  strips.replaceChildren(...series.map((v) => {
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "chart");
    svg.setAttribute("preserveAspectRatio", "none");
    const w = $("chart-memory").clientWidth || 600, h = 24;
    const pts = [];
    v.counts.forEach((c, i) => {
      const px = (i / N) * w, py = h - (c / top) * (h - 2);
      if (i) pts.push([px, pts.at(-1)[1]]);
      pts.push([px, py]);
    });
    const p = document.createElementNS(svgNS, "path");
    p.setAttribute("class", "area");
    p.setAttribute("d", path([[0, h], ...pts, [w, h]]) + "Z");
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    svg.replaceChildren(p);
    const sel = state.selected?.kind === "template" && state.selected.name === v.name;
    return el("div", { class: "strip" + (v.now ? "" : " off") + (sel ? " selected" : "") },
      el("button", { class: "strip-name", type: "button", onclick: () => select("template", v.name) }, el("span", {}, v.name), el("b", {}, v.now)),
      svg);
  }));
}

function renderAxis() {
  const now = Date.now(), sp = span();
  const minutes = Math.round(sp / MIN);
  $("overview-title").textContent = minutes >= 60 ? "The last hour" : `The last ${minutes} minutes`;
  // Round minutes, each at its own place: every 2 at 10 minutes, 5 at half an hour, 15 at an hour
  const every = (minutes <= 15 ? 2 : minutes <= 30 ? 5 : 15) * MIN;
  const marks = [];
  // None close enough to "now" for their labels to meet
  for (let t = Math.ceil((now - sp) / every) * every; t < now - Math.max(every / 2, sp * 0.14); t += every) marks.push(t);
  const at = (t) => `${((t - (now - sp)) / sp) * 100}%`;
  // One at the very start begins at its tick rather than centring on it, so it stays on the page
  const kids = marks.map((t) => el("span", { class: (t - (now - sp)) / sp < 0.06 ? "edge" : null, style: `left:${at(t)}` }, clock(t)));
  kids.push(el("span", { class: "now", style: "left:100%" }, "now"));
  const started = state.totals ? new Date(state.totals.started).getTime() : 0;
  if (started > now - sp) {
    const late = (started - (now - sp)) / sp > 0.7;
    kids.push(el("span", { class: "start" + (late ? " late" : ""), style: `left:${at(started)}` }, `daemon started ${clock(started)}`));
  }
  $("axis").replaceChildren(...kids);
}

// Which events count as marks on the axis, and which are quiet ones
const loud = /^(machine\.up|template\.(added|awake|asleep)|build\.(done|failed)|service\.replica_up|snapshot\.saved|admission\.refused)$/;
function renderEvents() {
  const cut = Date.now() - span();
  const ticks = state.events.filter((e) => new Date(e.time).getTime() >= cut);
  // An empty span: say so, unless the daemon's start (marked on the axis) already explains it
  const startShown = state.totals && new Date(state.totals.started).getTime() > cut;
  const quiet = !ticks.length && !startShown;
  $("event-ticks").classList.toggle("empty", quiet);
  $("event-ticks").replaceChildren(...(quiet ? [el("span", { class: "caption" }, "Nothing happened in this span yet.")] : []), ...ticks.map((e) => el("button", {
    class: "tick" + (loud.test(e.kind) ? "" : " quiet"), type: "button",
    style: `left:${((new Date(e.time).getTime() - cut) / span()) * 100}%`,
    title: `${clock(e.time)} · ${e.subject}: ${e.message}`, "aria-label": `${clock(e.time)}, ${e.subject}: ${e.message}`,
  })));
  const list = $("recent");
  const shown = state.events.slice(-8).reverse();
  list.replaceChildren(...shown.map((e) => el("li", { class: state.seen.has(e.seq) ? "" : "enter" },
    el("time", { datetime: e.time }, clock(e.time)),
    el("span", {}, el("b", {}, e.subject.replace(/^(machine|template|service|build|snapshot|run) /, "")), " ", plain(e.message)))));
  if (!shown.length) list.replaceChildren(el("li", { class: "nothing" }, "Nothing yet."));
  for (const e of shown) state.seen.add(e.seq);
}

// A lane per template: each machine's life as a bar from up to now (or to when it stopped),
// stacked in as few rows as they fit
function renderLanes() {
  const lanes = $("lanes");
  const sp = span();
  const cut = Date.now() - sp;
  const names = new Set(state.templates.map((t) => t.name));
  for (const l of state.lives.values()) if (l.template && (!l.end || l.end >= cut)) names.add(l.template);
  $("lanes-empty").hidden = names.size > 0 || !state.reachable;
  const memory = state.stats?.memory || {};
  lanes.replaceChildren(...[...names].sort().map((name) => {
    const t = state.templates.find((v) => v.name === name);
    const lives = [...state.lives.values()].filter((l) => l.template === name && (!l.end || l.end >= cut)).sort((a, b) => a.start - b.start);
    const rows = [];
    const bars = lives.map((l) => {
      const start = Math.max(l.start, cut), end = l.end || Date.now();
      let row = rows.findIndex((r) => r < start);
      if (row < 0) { row = rows.length; rows.push(0); }
      rows[row] = end + 30000;
      const left = ((start - cut) / sp) * 100, width = Math.max(0.3, ((end - start) / sp) * 100);
      const live = !l.end;
      const b = el("button", {
        class: `mbar${live ? " live" : " gone"}${left > 55 ? " end" : ""}${state.selected?.kind === "machine" && state.selected.name === l.name ? " selected" : ""}${l.fresh ? " grow" : ""}`,
        type: "button", style: `left:${left}%;width:${width}%;top:${row * 30 + 4}px`,
        "aria-label": `machine ${l.name}, ${live ? "up for " + since(l.start) : "stopped " + clock(l.end)}`,
        onclick: () => select("machine", l.name),
      }, el("em", {}, live ? `${l.name} · ${since(l.start)}${memory[l.name] ? " · " + size(memory[l.name]).join(" ") : ""}` : `${l.name} · stopped ${clock(l.end)}`));
      l.fresh = false;
      return b;
    });
    const caption = t ? `${t.asleep ? "asleep" : "awake"} · ${lives.filter((l) => !l.end).length} running` : "removed";
    return el("div", { class: "lane" + (state.selected?.kind === "template" && state.selected.name === name ? " selected" : "") },
      el("button", { class: "lane-name", type: "button", onclick: () => select("template", name) }, name, el("small", {}, caption)),
      el("div", { class: "bars", style: `height:${Math.max(1, rows.length) * 30 + 6}px` }, bars));
  }));
}

// The hairline under the pointer: the minute it stands for, across every row and lane
function wireCursor() {
  const tl = $("timeline"), cursor = $("cursor"), readout = $("readout");
  tl.addEventListener("pointermove", (e) => {
    const chart = $("chart-memory").getBoundingClientRect();
    const box = tl.getBoundingClientRect();
    if (e.clientX < chart.left || e.clientX > chart.right) { cursor.hidden = true; readout.textContent = ""; return; }
    cursor.hidden = false;
    cursor.style.left = `${e.clientX - box.left}px`;
    const t = Date.now() - span() + ((e.clientX - chart.left) / chart.width) * span();
    const s = state.samples.reduce((best, v) => (!best || Math.abs(new Date(v.time) - t) < Math.abs(new Date(best.time) - t) ? v : best), null);
    const running = [...state.lives.values()].filter((l) => l.start <= t && (!l.end || l.end >= t)).length;
    const near = s && Math.abs(new Date(s.time) - t) < 60000;
    readout.replaceChildren(el("b", {}, clock(t)), near
      ? ` ${size(s.memory_used).join(" ")} · ${s.machines} machines · ${s.jobs} jobs${s.jobs ? `, p95 ${Math.round(s.job_ms_p95)} ms` : ""}`
      : ` ${running} machines`);
  });
  tl.addEventListener("pointerleave", () => { cursor.hidden = true; readout.textContent = ""; });
}

// --- the selection

// What is selected, and where it was selected (its inspector shows there): the timeline or the
// graph. extra carries a link being made (linkTo).
function select(kind, name, from = "timeline", extra = {}) {
  state.selected = kind ? { kind, name, from, ...extra } : null;
  render();
  if (kind) requestAnimationFrame(() => $(from === "graph" ? "inspect-graph" : "selection")?.scrollIntoView({ behavior: "smooth", block: "nearest" }));
}

async function act(fn, done) {

  try {
    await fn();
    banner(null);
    $("run-meta").textContent = done || "";
  } catch (e) {
    banner(e.message);
  }
  refresh();
}
function confirmAct(question, fn, done) {
  if (confirm(question)) act(fn, done);
}

// --- tables

function renderTables() {
  const memory = state.stats?.memory || {};
  const row = (cells, actions, selected) => el("tr", { class: selected ? "selected" : "" }, cells, el("td", {}, actions));
  const none = (n, text) => el("tr", { class: "none" }, el("td", { colspan: n }, text));
  const tplBody = $("templates-table").tBodies[0];
  tplBody.replaceChildren(...(state.templates.length ? state.templates.map((t) => row([
    el("td", { class: "name" }, el("span", { class: "dot " + (t.asleep ? "idle" : "live") }), t.name),
    el("td", { class: "site", title: t.site }, t.site),
    el("td", {}, t.asleep ? "asleep" : "awake"),
    el("td", {}, t.egress || (t.allow_private ? "private" : "as built")),
    el("td", { class: "num" }, state.machines.filter((m) => m.template === t.name).length),
    el("td", { class: "num" }, memory["template/" + t.name] ? size(memory["template/" + t.name]).join(" ") : "–"),
  ], [
    el("button", { class: "link", type: "button", onclick: () => act(() => api("/v1/machines", { method: "POST", body: { template: t.name } }), "Up from " + t.name) }, "Up"),
    el("button", { class: "link", type: "button", onclick: () => select("template", t.name, "graph") }, "Show"),
  ], state.selected?.kind === "template" && state.selected.name === t.name)) : [none(7, "No templates.")]));

  $("machines-table").tBodies[0].replaceChildren(...(state.machines.length ? state.machines.map((m) => row([
    el("td", { class: "name" }, el("span", { class: "dot live" }), m.name),
    el("td", {}, m.template),
    el("td", {}, since(m.created)),
    el("td", { class: "num" }, memory[m.name] ? size(memory[m.name]).join(" ") : "–"),
    el("td", { class: "mono" }, (m.ports || []).map((p) => `${p.host}→${p.guest}`).join(" ") || "–"),
  ], [
    el("button", { class: "link", type: "button", onclick: () => openTerminal(m.name) }, "Terminal"),
    el("button", { class: "link", type: "button", onclick: () => act(() => api(`/v1/machines/${m.name}`, { method: "DELETE" }), "Stopped " + m.name) }, "Stop"),
  ], state.selected?.kind === "machine" && state.selected.name === m.name)) : [none(6, "No machines running.")]));

  $("services-table").tBodies[0].replaceChildren(...(state.services.length ? state.services.map((s) => row([
    el("td", { class: "name" }, el("span", { class: "dot " + (s.replicas?.length ? "live" : "idle") }), s.name),
    el("td", {}, s.template),
    el("td", { class: "mono" }, (s.ports || []).map((p) => `${p.host}→${p.guest}`).join(" ")),
    el("td", {}, `${s.replicas?.length || 0} of ${s.min}–${s.max}${!s.replicas?.length && s.min === 0 ? " · at zero" : ""}`),
    el("td", {}, dur(s.idle)),
    el("td", {}, s.state),
  ], [
    el("button", { class: "link", type: "button", onclick: () => confirmAct(`Remove service ${s.name}?`, () => api(`/v1/services/${s.name}`, { method: "DELETE" }), "Removed " + s.name) }, "Remove"),
  ])) : [none(7, "No services. A service puts a template's machines behind a port and can scale to zero.")]));

  $("snapshots-table").tBodies[0].replaceChildren(...(state.snapshots.length ? state.snapshots.map((s) => row([
    el("td", { class: "name" }, s.name),
    el("td", {}, s.machine || "–"),
    el("td", { class: "num" }, s.bytes ? size(s.bytes).join(" ") : "–"),
    el("td", {}, s.created ? clock(s.created) : "–"),
  ], [
    el("button", { class: "link", type: "button", onclick: () => act(() => api("/v1/templates", { method: "POST", body: { snapshot: s.name, name: s.name } }), "Template " + s.name + " added") }, "Make a template"),
    el("button", { class: "link", type: "button", onclick: () => confirmAct(`Remove snapshot ${s.name}?`, () => api(`/v1/snapshots/${s.name}`, { method: "DELETE" }), "Removed " + s.name) }, "Remove"),
  ])) : [none(5, "No snapshots. Save one from a machine you set up.")]));

  for (const sel of document.querySelectorAll('select[name="template"]')) {
    const keep = sel.value;
    sel.replaceChildren(...state.templates.map((t) => el("option", { value: t.name }, t.name)));
    if (state.templates.some((t) => t.name === keep)) sel.value = keep;
    sel.disabled = !state.templates.length;
  }
}

// --- fire-and-forget runs

const runHow = (r) => r.status === "running" ? "running"
  : r.error ? "couldn't run"
  : r.exit === null || r.exit === undefined ? "out of time"
  : `exit ${r.exit} · ${r.ms} ms`;
function renderRuns() {
  $("runs").replaceChildren(...state.runs.slice(0, 6).map((r) => {
    const failed = r.status !== "running" && (r.error || (r.exit ?? 1) !== 0);
    return el("li", { class: failed ? "failed" : "" },
    el("button", { type: "button", onclick: () => showRun(r.id), title: r.cmd, "aria-current": state.shownRun === r.id ? "true" : null },
      el("span", { class: "dot " + (r.status === "running" ? "waiting" : failed ? "failed" : "") }),
      el("span", { class: "cmd" }, r.cmd),
      el("span", { class: "how" }, `${r.template} · ${runHow(r)}`)));
  }));
}
async function showRun(id) {
  const out = $("run-output"), meta = $("run-meta");
  try {
    const r = await api(`/v1/runs/${encodeURIComponent(id)}`);
    state.shownRun = id;
    renderRuns();
    out.hidden = false;
    out.textContent = `$ ${r.cmd}\n` + b64(r.output) + (r.error ? r.error : "");
    meta.textContent = `${r.id} on a fork of ${r.template} · ${runHow(r)}${r.status === "running" ? "" : ", the fork is gone"}`;
  } catch (err) { meta.textContent = err.message; }
}

// --- ports

function renderPorts() {
  const body = $("ports-table").tBodies[0];
  if (!state.ports.length) {
    body.replaceChildren(el("tr", { class: "none" }, el("td", { colspan: 5 }, "No ports yet. Give a machine one with Ports when you up it, or add a service.")));
    return;
  }
  body.replaceChildren(...state.ports.map((p) => {
    const where = p.ip === "0.0.0.0" || p.ip === "::" ? location.hostname : p.ip;
    const href = `http://${where.includes(":") ? `[${where}]` : where}:${p.host}/`;
    const live = p.kind === "service" ? p.replicas > 0 : p.open;
    const stateText = p.kind === "service" ? (p.replicas ? `${p.replicas} replica${p.replicas > 1 ? "s" : ""}` : "at zero") : (p.open ? "open" : "not listening");
    return el("tr", { class: state.selected?.kind === "machine" && state.selected.name === p.name ? "selected" : "" },
      el("td", { class: "host" }, el("a", { href, target: "_blank", rel: "noopener" }, `${p.ip}:${p.host}`)),
      el("td", { class: "name" }, p.kind === "machine"
        ? el("button", { class: "link", type: "button", onclick: () => select("machine", p.name, "graph") }, p.name)
        : p.name, el("small", { class: "kind" }, ` ${p.kind}`)),
      el("td", { "data-label": "guest port" }, p.guest),
      el("td", { "data-label": "template" }, p.template),
      el("td", {}, el("span", { class: "dot " + (live ? "live" : "idle") }), stateText));
  }));
}

// What holds a host port: the fleet, another program, or nothing
async function checkPort(port, ip) {
  return api(`/v1/ports/check?port=${encodeURIComponent(port)}&ip=${encodeURIComponent(ip || "")}`);
}
function sayCheck(out, c) {
  out.replaceChildren(c.free
    ? el("span", {}, el("b", {}, `${c.ip}:${c.port}`), " is free")
    : el("span", {}, el("b", {}, `${c.ip}:${c.port}`), ` is taken by ${c.by}`));
}

function wirePorts() {
  $("port-check").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements, out = $("port-check-result");
    try { sayCheck(out, await checkPort(f.port.value, f.ip.value.trim())); } catch (err) { out.textContent = err.message; }
  });
}

// --- builds

const buildState = { done: "done", failed: "failed", cancelled: "cancelled", interrupted: "interrupted", queued: "queued", running: "building" };
function renderBuilds() {
  const list = $("build-list");
  list.replaceChildren(...state.builds.slice(0, 12).map((b) => {
    const running = b.status === "running" || b.status === "queued";
    const took = b.started ? Math.round(((b.ended ? new Date(b.ended) : Date.now()) - new Date(b.started)) / 1000) : 0;
    return el("div", { class: "build " + b.status },
      el("span", { class: "dot " + (running ? "waiting" : b.status === "done" ? "" : "idle") }),
      el("span", { class: "what" }, b.name, el("small", {}, b.kind === "dockerfile" ? "a Dockerfile" : b.source)),
      el("span", { class: "state" }, `${buildState[b.status] || b.status}${took ? ` · ${Math.floor(took / 60)}:${String(took % 60).padStart(2, "0")}` : ""}${b.kernel === "none" ? " · no kernel" : ""}`),
      el("span", {},
        el("button", { class: "link", type: "button", onclick: () => showLog(b) }, "Log"),
        b.artifact ? el("a", { class: "link", href: `/api/v1/builds/${encodeURIComponent(b.id)}/artifact`, download: `${b.name}.tar.zst`,
          title: `sha256 ${b.artifact.sha256}` }, `Download (${size(b.artifact.bytes).join(" ")})`) : null,
        running ? el("button", { class: "link", type: "button", onclick: () => act(() => api(`/v1/builds/${b.id}`, { method: "DELETE" }), "Cancelled " + b.name) }, "Cancel") : null),
      b.status === "done" && state.templates.some((t) => t.name === b.template)
        ? el("p", { class: "made" }, `Now the template ${b.template}. `,
          el("button", { class: "link", type: "button", onclick: () => act(() => api("/v1/machines", { method: "POST", body: { template: b.template } }), "Up from " + b.template) }, "Up a machine"),
          el("button", { class: "link", type: "button", onclick: () => { select("template", b.template, "graph"); } }, "Show"))
        : null,
      b.error ? el("p", { class: "error" }, plain(b.error)) : null);
  }));
  if (!state.builds.length) list.replaceChildren(el("p", { class: "caption" }, "No builds yet."));
}

let logAbort = null;
async function showLog(b) {
  logAbort?.abort();
  logAbort = new AbortController();
  $("build-log").hidden = false;
  $("build-log-title").textContent = `Log of ${b.name}`;
  const pre = $("build-log-text");
  pre.textContent = "";
  $("build-log").scrollIntoView({ behavior: "smooth", block: "nearest" });
  try {
    const res = await fetch(`/api/v1/builds/${b.id}/log?follow=1`, { signal: logAbort.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const stick = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 8;
      pre.textContent += plain(dec.decode(value, { stream: true }));
      if (stick) pre.scrollTop = pre.scrollHeight;
    }
  } catch {}
}

function wireBuilds() {
  const form = $("build-form");
  const kind = () => form.elements.kind.value;
  form.addEventListener("change", (e) => {
    if (e.target.name !== "kind") return;
    for (const l of form.querySelectorAll("[data-kind]")) l.hidden = l.dataset.kind !== kind();
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const body = { name: f.name.value || undefined, network: f.network.checked ? "fetch" : undefined,
      memory_mb: +f.memory.value || undefined, cpus: +f.cpus.value || undefined, kernel: f.kernel.value || undefined };
    if (kind() === "dir") body.source = f.dir.value.trim();
    if (kind() === "image") body.source = f.image.value.trim();
    if (kind() === "dockerfile") body.dockerfile = f.dockerfile.value;
    try {
      const b = await api("/v1/builds", { method: "POST", body });
      banner(null);
      refresh();
      showLog(b);
    } catch (err) {
      banner(err.message);
    }
  });
  $("build-log-close").addEventListener("click", () => { logAbort?.abort(); $("build-log").hidden = true; });
}

// --- forms

function wireForms() {
  $("run-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const out = $("run-output"), meta = $("run-meta");
    // Submit: fire and forget, the result lands in the list below
    if (e.submitter?.value === "submit") {
      try {
        const r = await api("/v1/runs", { method: "POST", body: { template: f.template.value, cmd: f.cmd.value, timeout: 600 } });
        meta.textContent = `${r.id} runs once in the background on a fresh fork; its result appears below`;
        refresh();
      } catch (err) { meta.textContent = err.message; }
      return;
    }
    const btn = e.submitter || e.target.querySelector("button");
    btn.disabled = true;
    out.hidden = false;
    out.textContent = `$ ${f.cmd.value}\n`;
    meta.textContent = `running on a fresh fork of ${f.template.value}…`;
    const begun = performance.now();
    try {
      const r = await api(`/v1/templates/${f.template.value}/jobs`, { method: "POST", body: { cmd: f.cmd.value, timeout: 120 } });
      out.textContent += b64(r.output);
      const ms = Math.round(performance.now() - begun);
      meta.textContent = r.status === null ? `out of time after ${ms} ms; everything it started was killed`
        : `exit ${r.status} · ${ms} ms · the fork is gone, nothing it did is kept`;
    } catch (err) {
      out.textContent += err.message;
      meta.textContent = "";
    }
    btn.disabled = false;
  });
}

// --- the terminal (ghostty-web, over the daemon's attach WebSocket)

let term = null;
async function openTerminal(name) {
  closeTerminal();
  const box = $("terminal");
  box.hidden = false;
  $("terminal-title").textContent = name;
  $("terminal-state").textContent = "connecting…";
  box.scrollIntoView({ behavior: "smooth", block: "start" });
  const { init, Terminal, FitAddon } = await import("./vendor/ghostty-web/ghostty-web.js");
  await init();
  const css = getComputedStyle(document.documentElement);
  const t = new Terminal({
    fontSize: matchMedia("(max-width: 640px)").matches ? 13 : 13.5,
    fontFamily: "Fragment Mono, ui-monospace, Menlo, monospace",
    cursorBlink: true,
    scrollback: 5000,
    theme: { background: css.getPropertyValue("--panel").trim(), foreground: css.getPropertyValue("--panel-ink").trim(), cursor: css.getPropertyValue("--signal").trim() },
  });
  const fit = new FitAddon();
  t.loadAddon(fit);
  t.open($("terminal-screen"));
  fit.fit();
  const ws = new WebSocket(`ws://${location.host}/api/v1/machines/${encodeURIComponent(name)}/attach?rows=${t.rows}&cols=${t.cols}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { $("terminal-state").textContent = `live · ${t.cols}×${t.rows}`; document.body.classList.add("live"); t.focus(); };
  ws.onmessage = (e) => t.write(new Uint8Array(e.data));
  ws.onclose = (e) => {
    $("terminal-state").textContent = e.reason || "disconnected";
    document.body.classList.remove("live");
  };
  const enc = new TextEncoder();
  t.onData((d) => ws.readyState === 1 && ws.send(enc.encode(d)));
  term = { t, ws, name };
}
function closeTerminal() {
  if (!term) return;
  term.ws.close();
  term.t.dispose?.();
  $("terminal-screen").replaceChildren();
  term = null;
  document.body.classList.remove("live");
}

// --- the page

function render() {
  const st = state.stats;
  $("daemon").textContent = !state.reachable ? "the daemon isn't answering"
    : !on("machines") ? `${state.mode} mode · ${st ? st.builds_running : 0} building · ${st ? st.artifacts : 0} artifacts`
    : `daemon up ${state.totals ? since(state.totals.started) : "…"} · ${st ? st.machines : 0} machines`;
  renderSeries();
  renderLanes();
  renderEvents();
  renderTables();
  renderPorts();
  renderRuns();
  renderBuilds();
  publish();
}

// What the components may do
store.state = state;
store.actions = {
  api, act, select, openTerminal, banner,
  refresh: () => refresh(),
  runOn: (template) => { $("run-template").value = template; $("run-cmd").scrollIntoView({ block: "center" }); $("run-cmd").focus(); },
  // A POST whose answer is kept even when it failed (a fleet's log)
  post,
  refreshFleets,
  // The fleet shown under Fleets (and its plan's steps in the graph), in one of its instances
  showFleet: async (name, stay, instance) => {
    state.fleet = name;
    if (!name) { state.fleetView = null; state.plan = null; publish(); return; }
    if (!stay) location.hash = "#fleets";
    try {
      state.fleetView = await api(`/v1/fleets/${encodeURIComponent(name)}${instance ? `?instance=${encodeURIComponent(instance)}` : ""}`);
      state.plan = state.fleetView.plan || null;
    } catch (e) { state.fleetView = { name, error: e.message }; state.plan = null; }
    publish();
  },
  // One step of the shown fleet's plan (or all of them) in an instance: its log and error
  applyStep: async (step, instance) => {
    const out = await post(`/v1/fleets/${encodeURIComponent(state.fleet)}/apply`, { step: step || undefined, instance: instance || state.plan?.instance });
    if (out.plan) { state.plan = out.plan; if (state.fleetView) state.fleetView.plan = out.plan; }
    await refresh();
    return out;
  },
};

async function post(path, body) {
  const res = await fetch("/api" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return res.ok ? data : { ...(data.result || {}), error: data.error || res.statusText };
}

async function refreshFleets() {
  try { state.fleets = await api("/v1/fleets"); } catch { state.fleets = []; }
  publish();
}

// One view at a time, by the address: #overview, #network, #fleets, #machines, #run, #builds
const OLD = { ports: "machines", fleet: "machines" };
function route() {
  // The first view the mode has on, when the one asked for is off
  const first = Object.keys(VIEWS).find((v) => on(VIEWS[v])) || "builds";
  const want = location.hash.slice(1) || first;
  let view = OLD[want] || (document.querySelector(`[data-view="${want}"]`) ? want : first);
  if (!on(VIEWS[view])) view = first;
  state.view = view;
  for (const s of document.querySelectorAll("[data-view]")) s.hidden = s.dataset.view !== view;
  for (const a of document.querySelectorAll("#views a")) a.setAttribute("aria-current", a.getAttribute("href") === `#${view}` ? "page" : "false");
  // A view shown again draws at its width
  if (view === "overview") { renderSeries(); renderLanes(); renderEvents(); }
  if (view === "fleets") refreshFleets();
  publish();
}
addEventListener("hashchange", route);
await learnMode();
mount(html`<${Graph} />`, $("graph"));
mount(html`<${Inspector} where="graph" />`, $("inspect-graph"));
mount(html`<${Inspector} where="timeline" />`, $("selection"));
mount(html`<${Tasks} />`, $("tasks"));
mount(html`<${Fleets} />`, $("fleets-root"));
route();
$("terminal-close").addEventListener("click", () => { closeTerminal(); $("terminal").hidden = true; });
wireCursor();
wireForms();
wireBuilds();
wirePorts();
await refresh();
await refreshMetrics();
followEvents();
state.seen.add("ready");
setInterval(refresh, 3000);
setInterval(refreshMetrics, 5000);
// The axis moves with the clock even when nothing happens
setInterval(() => { renderSeries(); renderLanes(); renderEvents(); }, 15000);
addEventListener("resize", () => renderSeries());
