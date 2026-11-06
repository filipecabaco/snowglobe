// The daemon as a graph, read top down:
//
//   the plan    a strip of templates, one column each, with the links between them dotted: what
//               every instance is made from and is allowed to reach
//   the runs    a ruled group per fleet instance (and one for what no fleet made), its services
//               and machines in their template's column, and solid edges where a machine really
//               reaches another, labelled with the name it uses
//   the outside the host's ports, each a tag on what it opens (signal while something listens)
//
// A fleet's steps still to apply are dashed, each with its own Apply. Dragging from a node's
// handle onto another starts a link; the inspector finishes it (and does the same by keyboard).

import { html, useEffect, useRef, useState } from "./vendor/preact/index.js";
import { useStore } from "./store.js";

const NW = 176, NH = 52, ROW = 76, COL = 228, X0 = 120;
const STRIP_Y = 40, GROUP_HEAD = 54;

const id = (kind, name) => `${kind}:${name}`;
const STATE = { live: "live", idle: "idle", asleep: "idle", planned: "planned" };
const NOFLEET = "\u0000";

// What a fleet's plan would add, as nodes and dotted links
function planned(plan, nodes) {
  const ghosts = [], ghostLinks = [], marks = new Map();
  if (!plan) return { ghosts, ghostLinks, marks };
  const tplOf = (s) => (s.deps || []).find((d) => d.startsWith("template/"))?.slice(9);
  for (const s of plan.steps) {
    const nid = id(s.kind, s.name);
    if (s.action === "remove" || (s.action === "replace" && nodes.has(nid))) { marks.set(nid, s); continue; }
    if (s.kind === "link") {
      const ends = (s.deps || []).map((d) => d.split("/")[1]);
      ghostLinks.push({ step: s, ends, label: s.detail?.match(/ as ([^,]+)/)?.[1] || s.name });
    } else if (["template", "service", "machine"].includes(s.kind)) {
      ghosts.push({ id: nid, kind: s.kind, name: s.name, template: s.kind === "template" ? s.name : tplOf(s), state: "planned", step: s,
        fleet: plan.fleet, instance: s.kind === "template" ? "" : plan.instance, labels: {} });
    }
  }
  return { ghosts, ghostLinks, marks };
}

function layout(graph, plan) {
  const nodes = new Map(graph.nodes.filter((n) => n.kind !== "snapshot" && n.kind !== "port").map((n) => [n.id, { ...n }]));
  const { ghosts, ghostLinks, marks } = planned(plan, nodes);
  for (const g of ghosts) if (!nodes.has(g.id)) nodes.set(g.id, g);
  // Replicas are their service's: of its fleet and instance, under it
  const replicasOf = new Map();
  for (const e of graph.edges) if (e.kind === "replica" && nodes.has(e.to)) {
    if (!replicasOf.has(e.from)) replicasOf.set(e.from, []);
    replicasOf.get(e.from).push(e.to);
    const svc = nodes.get(e.from), r = nodes.get(e.to);
    if (svc && r) { r.fleet ||= svc.fleet; r.instance ||= svc.instance; r.replica = true; }
  }
  const templates = [...nodes.values()].filter((n) => n.kind === "template").sort((a, b) => a.name.localeCompare(b.name));
  const col = new Map(templates.map((t, i) => [t.name, i]));
  const x = (t) => X0 + (col.get(t) ?? templates.length) * COL;
  const pos = new Map();
  templates.forEach((t) => pos.set(t.id, { x: x(t.name), y: STRIP_Y }));

  // Groups: a fleet's instance each, what no fleet made last
  const groupKey = (n) => (n.fleet ? `${n.fleet}\u0001${n.instance || "main"}` : NOFLEET);
  const groups = new Map();
  for (const n of nodes.values()) {
    if (n.kind === "template" || n.replica) continue;
    const k = groupKey(n);
    if (!groups.has(k)) groups.set(k, { key: k, fleet: n.fleet || "", instance: n.fleet ? (n.instance || "main") : "", items: [] });
    groups.get(k).items.push(n);
  }
  const ordered = [...groups.values()].sort((a, b) => (a.key === NOFLEET) - (b.key === NOFLEET) || a.fleet.localeCompare(b.fleet)
    || (a.instance === "main" ? -1 : b.instance === "main" ? 1 : a.instance.localeCompare(b.instance, undefined, { numeric: true })));
  let y = STRIP_Y + NH + 44;
  const bands = [];
  for (const g of ordered) {
    const rows = new Map();
    const place = (n) => {
      const c = n.template;
      const r = rows.get(c) || 0;
      pos.set(n.id, { x: x(c), y: y + GROUP_HEAD + r * ROW });
      rows.set(c, r + 1);
    };
    const items = g.items.sort((a, b) => (a.kind === "service" ? 0 : 1) - (b.kind === "service" ? 0 : 1) || a.name.localeCompare(b.name));
    for (const n of items) {
      place(n);
      if (n.kind === "service") for (const r of (replicasOf.get(n.id) || []).sort()) place(nodes.get(r));
    }
    const h = GROUP_HEAD + Math.max(1, ...rows.values()) * ROW + 8;
    bands.push({ ...g, y, h });
    y += h;
  }
  // Ports: tags on top of what they open, side by side
  const ports = [];
  const at = new Map();
  for (const e of graph.edges) if (e.kind === "port") {
    const to = pos.get(e.to);
    const n = graph.nodes.find((v) => v.id === e.from);
    if (!to || !n) continue;
    const k = at.get(e.to) || 0;
    at.set(e.to, k + 1);
    ports.push({ node: n, edge: e, x: to.x + k * 92, y: to.y - 19 });
  }
  // The plan's links, between template columns, once per pair (dotted); a fleet's links name
  // services and machines, drawn from the template they are of
  const tplOfNode = (nid) => nodes.get(nid)?.template || (nid.startsWith("template:") ? nid.slice(9) : null);
  const rules = new Map();
  for (const e of graph.edges) if (e.kind === "link") {
    const a = tplOfNode(e.from), b = tplOfNode(e.to);
    if (!a || !b || a === b && e.from.startsWith("template:") && e.to.startsWith("template:")) continue;
    const k = `${a}>${b}>${e.label}`;
    if (!rules.has(k)) rules.set(k, { from: id("template", a), to: id("template", b), label: e.label, links: [] });
    rules.get(k).links.push(e.link);
  }
  for (const g of ghostLinks) {
    const [a, b] = g.ends.map((n) => tplOfNode(id("template", n)) || [...nodes.values()].find((v) => v.name === n)?.template || n);
    if (!a || !b) continue;
    const k = `${a}>${b}>${g.label}`;
    if (!rules.has(k)) rules.set(k, { from: id("template", a), to: id("template", b), label: g.label, links: [], ghost: g });
  }
  const width = X0 + Math.max(1, templates.length) * COL;
  return { nodes, pos, bands, ports, rules: [...rules.values()], marks, height: y + 16, width };
}

// An edge from a to b: out of the side facing b, into the side facing a (around, in one column)
function curve(a, b) {
  if (Math.abs(a.x - b.x) < 2) {
    const x1 = a.x + NW, y1 = a.y + NH / 2, y2 = b.y + NH / 2, out = 38;
    return { d: `M${x1},${y1} C${x1 + out},${y1} ${x1 + out},${y2} ${x1},${y2}`, mx: x1 + out * 0.75, my: (y1 + y2) / 2 };
  }
  const right = b.x > a.x;
  const x1 = right ? a.x + NW : a.x, x2 = right ? b.x : b.x + NW;
  const y1 = a.y + NH / 2, y2 = b.y + NH / 2;
  const d = Math.max(40, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return { d: `M${x1},${y1} C${x1 + d},${y1} ${x2 - d},${y2} ${x2},${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
}
// Between template chips in the strip: an arc above them
function arc(a, b, i) {
  const x1 = a.x + NW / 2, x2 = b.x + NW / 2, y = STRIP_Y, lift = 22 + i * 12;
  if (x1 === x2) return { d: `M${x1 - 20},${y} C${x1 - 20},${y - lift} ${x1 + 20},${y - lift} ${x1 + 20},${y}`, mx: x1, my: y - lift * 0.75 };
  return { d: `M${x1},${y} C${x1},${y - lift} ${x2},${y - lift} ${x2},${y}`, mx: (x1 + x2) / 2, my: y - lift * 0.75 };
}

function caption(n, mark) {
  if (n.state === "planned") return `${n.step.action === "replace" ? "to replace" : "to add"} · ${n.kind}`;
  if (mark) return `${n.kind} · ${mark.action === "remove" ? "the file drops it" : "the file changes it"}`;
  if (n.kind === "service") return n.detail;
  if (n.kind === "template") return n.state === "asleep" ? "template · asleep" : "template";
  return n.replica ? "replica" : "machine";
}

function Node({ n, p, selected, faded, mark, onSelect, onDragStart, linking, onApply, busy }) {
  const ghost = n.state === "planned";
  const canFrom = !ghost && (n.kind === "machine" || n.kind === "template");
  const canTo = !ghost && (n.kind === "machine" || n.kind === "service" || n.kind === "template");
  const cap = caption(n, mark);
  const cls = ["node", n.kind, ghost && "ghost", selected && "selected", faded && "faded", linking && canTo && "drop", mark && "marked"].filter(Boolean).join(" ");
  return html`<div class=${cls} ref=${(el) => el && (el.style.left = `${p.x}px`, el.style.top = `${p.y}px`)} data-node=${n.id}>
    <button type="button" class="node-body" onClick=${() => !ghost && onSelect(n)} aria-pressed=${selected ? "true" : "false"}
      aria-label=${`${n.kind} ${n.name}, ${cap}`} disabled=${ghost}>
      <span class=${"dot " + (STATE[n.state] || "idle")}></span><b>${n.name}</b><small>${cap}</small>
    </button>
    ${ghost && html`<button type="button" class="node-apply link" disabled=${!n.step.ready || busy}
      title=${n.step.ready ? `Apply ${n.step.key}` : `After ${(n.step.deps || []).join(", ")}`}
      onClick=${() => onApply(n.step)}>${busy ? "Applying…" : n.step.ready ? "Apply" : "Waits"}</button>`}
    ${canFrom && html`<span class="handle" title=${`Drag onto what ${n.name} should reach`} onPointerDown=${(e) => onDragStart(e, n)} aria-hidden="true"></span>`}
  </div>`;
}

export function Graph() {
  const { state, actions } = useStore();
  const box = useRef(null);
  const [width, setWidth] = useState(1100);
  const [drag, setDrag] = useState(null);
  const [busy, setBusy] = useState(null);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e.contentRect.width)));
    ro.observe(box.current);
    return () => ro.disconnect();
  }, []);
  if (!state?.graph) return html`<div class="graph" ref=${box}><p class="caption">Reading the daemon…</p></div>`;

  const L = layout(state.graph, state.plan);
  const sel = state.selected ? id(state.selected.kind, state.selected.name) : null;
  const near = new Set(sel ? [sel] : []);
  if (sel) for (const e of state.graph.edges) if (e.from === sel || e.to === sel) { near.add(e.from); near.add(e.to); }
  const select = (n) => actions.select(n.kind, n.name, "graph");
  const apply = async (step) => { setBusy(step.key); await actions.applyStep(step.key); setBusy(null); };

  const startDrag = (e, from) => {
    e.preventDefault();
    const canvas = box.current.querySelector(".graph-canvas").getBoundingClientRect();
    const p = L.pos.get(from.id);
    const move = (ev) => setDrag({ x1: p.x + NW, y1: p.y + NH / 2, x2: ev.clientX - canvas.left, y2: ev.clientY - canvas.top });
    const up = (ev) => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      setDrag(null);
      const target = document.elementFromPoint(ev.clientX, ev.clientY)?.closest("[data-node]")?.dataset.node;
      const to = target && L.nodes.get(target);
      if (to && to.id !== from.id && to.state !== "planned" && ["machine", "service", "template"].includes(to.kind)) {
        actions.select(from.kind, from.name, "graph", { linkTo: { kind: to.kind, name: to.name } });
      }
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    move(e);
  };

  if (!L.nodes.size) {
    return html`<div class="graph" ref=${box}><p class="empty">Nothing runs yet. Start a fleet under <a href="#fleets">Fleets</a>, or add a
      template under <a href="#machines">Machines</a>; its machines, the ports they open on this host and what reaches what appear here.</p></div>`;
  }
  if (width < 720) return html`<div class="graph" ref=${box}><${GraphList} L=${L} graph=${state.graph} sel=${sel} select=${select} apply=${apply} busy=${busy} /></div>`;

  const W = Math.max(width, L.width);
  const dim = (e) => (sel && !(e.from === sel || e.to === sel) ? " faded" : "");
  const reach = state.graph.edges.filter((e) => e.kind === "reach" && L.pos.has(e.from) && L.pos.has(e.to));
  const quiet = state.graph.edges.filter((e) => e.kind === "replica" && L.pos.has(e.from) && L.pos.has(e.to));
  return html`<div class="graph" ref=${box}>
    <div class="graph-canvas" ref=${(el) => el && (el.style.height = `${L.height}px`, el.style.width = `${W}px`)}>
      <span class="g-label strip-label">The plan</span>
      <svg class="edges" width=${W} height=${L.height} aria-hidden="true">
        <defs><marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" class="arrow" /></marker></defs>
        ${L.bands.map((b) => html`<line class="band" x1="0" x2=${W} y1=${b.y} y2=${b.y} />`)}
        ${L.rules.map((r, i) => L.pos.has(r.from) && L.pos.has(r.to) && html`<path class=${"edge rule" + (r.ghost ? " ghost" : "")} d=${arc(L.pos.get(r.from), L.pos.get(r.to), i).d} marker-end="url(#arrow)" />`)}
        ${quiet.map((e) => html`<path class=${"edge replica" + dim(e)} d=${`M${L.pos.get(e.from).x + 14},${L.pos.get(e.from).y + NH} L${L.pos.get(e.to).x + 14},${L.pos.get(e.to).y}`} />`)}
        ${reach.map((e) => html`<path class=${"edge reach" + dim(e)} d=${curve(L.pos.get(e.from), L.pos.get(e.to)).d} marker-end="url(#arrow)" />`)}
        ${drag && html`<line class="edge drafting" x1=${drag.x1} y1=${drag.y1} x2=${drag.x2} y2=${drag.y2} />`}
      </svg>
      ${L.bands.map((b) => html`<div class="group-head" ref=${(el) => el && (el.style.top = `${b.y}px`)}>
        ${b.fleet ? html`<a href="#fleets" onClick=${() => actions.showFleet(b.fleet)}><b>${b.fleet}</b></a><span>instance ${b.instance}</span>` : html`<b>Not in a fleet</b>`}</div>`)}
      ${L.rules.map((r, i) => L.pos.has(r.from) && L.pos.has(r.to) && html`<button type="button" class=${"rule-label" + (r.ghost ? " ghost" : "")}
          ref=${(el) => { if (!el) return; const c = arc(L.pos.get(r.from), L.pos.get(r.to), i); el.style.left = `${c.mx}px`; el.style.top = `${c.my}px`; }}
          disabled=${r.ghost && (!r.ghost.step.ready || busy)}
          title=${r.ghost ? `Apply ${r.ghost.step.key}` : `${r.links.length} link${r.links.length > 1 ? "s" : ""}: ${r.links.join(", ")}`}
          onClick=${() => (r.ghost ? apply(r.ghost.step) : actions.select("link", r.links[0], "graph"))}>${r.label}${r.ghost ? ` · ${r.ghost.step.ready ? "apply" : "waits"}` : ""}</button>`)}
      ${L.ports.map(({ node, edge, x, y }) => html`<a class=${"port-tag" + (node.state === "live" ? "" : " idle") + (sel && edge.to !== sel ? " faded" : "")}
          href=${portHref(node.name)} target="_blank" rel="noopener" title=${`${node.name}, open on this host, ${node.detail}`}
          ref=${(el) => el && (el.style.left = `${x}px`, el.style.top = `${y}px`)}>${node.name.replace(/^127\.0\.0\.1:/, ":")}<i>${edge.label.split("→")[1]}</i></a>`)}
      ${reach.map((e) => { const c = curve(L.pos.get(e.from), L.pos.get(e.to)); return html`<button type="button" class=${"link-label" + dim(e)}
          ref=${(el) => el && (el.style.left = `${c.mx}px`, el.style.top = `${c.my}px`)}
          onClick=${() => actions.select("link", e.link, "graph")} title=${`${e.from.split(":")[1]} reaches it as ${e.label} (link ${e.link})`}>${e.label}</button>`; })}
      ${[...L.nodes.values()].filter((n) => L.pos.has(n.id)).map((n) => html`<${Node} key=${n.id} n=${n} p=${L.pos.get(n.id)}
          selected=${sel === n.id} faded=${sel && !near.has(n.id)} mark=${L.marks.get(n.id)} onSelect=${select}
          onDragStart=${startDrag} linking=${!!drag} onApply=${apply} busy=${busy === n.step?.key} />`)}
    </div>
  </div>`;
}

function portHref(addr) {
  const i = addr.lastIndexOf(":");
  let host = addr.slice(0, i);
  if (host === "0.0.0.0" || host === "::") host = location.hostname;
  return `http://${host.includes(":") ? `[${host}]` : host}:${addr.slice(i + 1)}/`;
}

// Narrow screens: the same graph as a list, by group, with what reaches what in words
function GraphList({ L, graph, sel, select, apply, busy }) {
  const outs = (nid) => graph.edges.filter((e) => e.from === nid && e.kind === "reach");
  const ins = (nid) => graph.edges.filter((e) => e.to === nid && e.kind === "port");
  const inBand = (b) => [...L.nodes.values()].filter((n) => n.kind !== "template" && L.pos.get(n.id)?.y >= b.y && L.pos.get(n.id)?.y < b.y + b.h)
    .sort((a, c) => L.pos.get(a.id).x - L.pos.get(c.id).x || L.pos.get(a.id).y - L.pos.get(c.id).y);
  return html`<ol class="graph-list">
    ${L.bands.map((b) => html`<li>
      <p class="gl-head">${b.fleet ? html`<b>${b.fleet}</b> instance ${b.instance}` : html`<b>Not in a fleet</b>`}</p>
      <ul>${inBand(b).map((n) => html`<li>
        <button type="button" class=${"gl-node" + (sel === n.id ? " selected" : "")} disabled=${n.state === "planned"} onClick=${() => select(n)}>
          <span class=${"dot " + (STATE[n.state] || "idle")}></span>${n.name}<small>${caption(n)}</small></button>
        ${n.state === "planned" && html`<button type="button" class="link" disabled=${!n.step.ready || busy} onClick=${() => apply(n.step)}>${n.step.ready ? "Apply" : "Waits"}</button>`}
        ${ins(n.id).map((e) => html`<span class="gl-edge">open on this host as ${graph.nodes.find((v) => v.id === e.from)?.name}</span>`)}
        ${outs(n.id).map((e) => html`<span class="gl-edge">reaches ${e.to.split(":")[1]} as ${e.label}</span>`)}
      </li>`)}</ul>
    </li>`)}
  </ol>`;
}
