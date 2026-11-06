// What is selected (a template, service, machine or link), its figures, and what can be done with
// it, each its own control. It shows where the selection was made: under the timeline, or beside
// the graph. A link is made here, from the selection (or from a drag on the graph).

import { html, useEffect, useRef, useState } from "./vendor/preact/index.js";
import { useStore } from "./store.js";

const mb = (b) => (b >= 1 << 30 ? `${(b / (1 << 30)).toFixed(1)} GB` : `${Math.round(b / 1048576)} MB`);
function since(t) {
  const s = Math.max(0, Math.round((Date.now() - new Date(t)) / 1000));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  return `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
}
const dur = (d) => (typeof d === "string" ? d.replace(/(\D)0s$/, "$1").replace(/(\D)0m$/, "$1") : "") || "–";

export function Inspector({ where }) {
  const { state, actions } = useStore();
  const sel = state?.selected;
  const [said, say] = useState(null);
  useEffect(() => say(null), [sel?.kind, sel?.name]);
  if (!sel || (sel.from || "timeline") !== where) return null;

  const memory = state.stats?.memory || {};
  const run = async (fn, done) => {
    try {
      await fn();
      say({ ok: true, text: done });
    } catch (e) {
      say({ ok: false, text: e.message });
    }
    actions.refresh();
  };
  const close = () => actions.select(null);
  let title = sel.name, caption = "", figures = [], buttons = [], linking = null;


  if (sel.kind === "machine") {
    const m = state.machines.find((v) => v.name === sel.name);
    if (!m) caption = "machine · gone";
    else {
      const svc = m.labels?.["snowglobe.service"];
      caption = `machine of ${m.template}${svc ? `, a replica of ${svc}` : ""}${m.snapshot ? `, from snapshot ${m.snapshot}` : ""}`;
      figures = [["Memory", memory[m.name] ? mb(memory[m.name]) : "–"], ["Up for", since(m.created)],
        ["Ports", (m.ports || []).map((p) => `${p.host}→${p.guest}`).join(" ") || "none"], ["Stops", m.expires ? `in ${since(Date.now() * 2 - new Date(m.expires))}` : "when asked"]];
      buttons = [
        ["Terminal", () => actions.openTerminal(m.name)],
        ["Snapshot", () => run(() => actions.api(`/v1/machines/${m.name}/snapshots`, { method: "POST", body: {} }), `Saved a snapshot of ${m.name}`)],
        ["Stop", () => confirm(`Stop ${m.name}? What it wrote goes with it.`) && run(() => actions.api(`/v1/machines/${m.name}`, { method: "DELETE" }), `Stopped ${m.name}`)],
      ];
      linking = { kind: "machine", name: m.name };
    }
  } else if (sel.kind === "template") {
    const t = state.templates.find((v) => v.name === sel.name);
    if (!t) caption = "template · removed";
    else {
      const ms = state.machines.filter((m) => m.template === t.name);
      caption = `template of ${t.site.split("/").filter(Boolean).at(-1) || t.site}${t.snapshot ? `, snapshot ${t.snapshot}` : ""}`;
      figures = [["Machines", ms.length], ["Memory", mb(ms.reduce((a, m) => a + (memory[m.name] || 0), memory["template/" + t.name] || 0))],
        ["Server", t.asleep ? "asleep" : "awake"], ["Sleeps", t.idle ? `after ${dur(t.idle)}` : "never"]];
      buttons = [
        ["Up a machine", () => run(() => actions.api("/v1/machines", { method: "POST", body: { template: t.name } }), `Up from ${t.name}`)],
        ["Run on a fork", () => actions.runOn(t.name)],
        ["Remove", () => confirm(`Remove template ${t.name} and its ${ms.length} machines?`) && run(() => actions.api(`/v1/templates/${t.name}`, { method: "DELETE" }), `Removed ${t.name}`)],
      ];
      linking = { kind: "template", name: t.name };
    }
  } else if (sel.kind === "service") {
    const s = state.services.find((v) => v.name === sel.name);
    if (!s) caption = "service · removed";
    else {
      caption = `service of ${s.template}`;
      figures = [["Replicas", `${s.replicas?.length || 0} of ${s.min}–${s.max}`], ["Ports", (s.ports || []).map((p) => `${p.host}→${p.guest}`).join(" ") || "none"],
        ["Idle after", dur(s.idle)], ["State", s.state]];
      buttons = [["Remove", () => confirm(`Remove service ${s.name} and its replicas?`) && run(() => actions.api(`/v1/services/${s.name}`, { method: "DELETE" }), `Removed ${s.name}`)]];
    }
  } else if (sel.kind === "link") {
    const l = (state.links || []).find((v) => v.name === sel.name);
    title = `Link ${sel.name}`;
    if (!l) caption = "link · removed";
    else {
      caption = `${l.from_kind} ${l.from} reaches ${l.to_kind} ${l.to}`;
      figures = [["Its guests connect to", `${l.as}:${l.as_port}`], ["And get", `${l.to}:${l.port}`]];
      buttons = [["Unlink", () => run(() => actions.api(`/v1/links/${l.name}`, { method: "DELETE" }), `Removed link ${l.name}`)]];
    }
  }
  // What it really reaches, and what reaches it (the graph's reach edges: a template's links too)
  const nid = `${sel.kind}:${sel.name}`;
  const edges = state.graph?.edges || [];
  const out = edges.filter((e) => (e.kind === "reach" || (e.kind === "link" && sel.kind === "template")) && e.from === nid);
  const into = edges.filter((e) => e.kind === "reach" && e.to === nid);
  const unlink = (name) => run(() => actions.api(`/v1/links/${name}`, { method: "DELETE" }), `Removed link ${name}`);

  return html`<div class="selection" aria-live="polite">
    <div class="selection-head"><h3>${title}</h3><button class="link" type="button" onClick=${close}>Close</button></div>
    <p class="caption">${caption}</p>
    ${figures.length > 0 && html`<dl class="figures">${figures.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>`}
    ${buttons.length > 0 && html`<div class="actions">${buttons.map(([label, fn]) => html`<button class="btn" type="button" onClick=${fn}>${label}</button>`)}</div>`}
    ${(out.length > 0 || into.length > 0) && html`<ul class="link-list">
      ${out.map((e) => html`<li><span>reaches <b>${e.to.split(":")[1]}</b> as <code>${e.label}</code> <small>link ${e.link}</small></span>
        <button class="link" type="button" onClick=${() => unlink(e.link)}>Unlink</button></li>`)}
      ${into.map((e) => html`<li><span><b>${e.from.split(":")[1]}</b> reaches it as <code>${e.label}</code> <small>link ${e.link}</small></span>
        <button class="link" type="button" onClick=${() => unlink(e.link)}>Unlink</button></li>`)}
    </ul>`}
    ${linking && html`<${LinkForm} from=${linking} to=${sel.linkTo} onDone=${(text) => { say({ ok: true, text }); actions.refresh(); }} onError=${(text) => say({ ok: false, text })} />`}
    ${said && html`<p class=${"said" + (said.ok ? "" : " bad")} role=${said.ok ? "status" : "alert"}>${said.text}</p>`}
  </div>`;
}

// Link the selection to a machine or service: its guests reach it as a name and port
export function LinkForm({ from, to, onDone, onError }) {
  const { state, actions } = useStore();
  const targets = [
    ...state.machines.filter((m) => !(from.kind === "machine" && m.name === from.name)).map((m) => ({ kind: "machine", name: m.name })),
    ...state.services.map((s) => ({ kind: "service", name: s.name })),
    ...state.templates.map((t) => ({ kind: "template", name: t.name })),
  ];
  const [target, setTarget] = useState(to ? `${to.kind}:${to.name}` : "");
  const [port, setPort] = useState("");
  const [as, setAs] = useState("");
  const portRef = useRef(null);
  useEffect(() => {
    if (to) {
      setTarget(`${to.kind}:${to.name}`);
      portRef.current?.focus();
    }
  }, [to?.kind, to?.name]);
  const [kind, name] = target.split(/:(.*)/);
  // The target's known guest ports, offered first
  const known = kind === "service" ? (state.services.find((s) => s.name === name)?.ports || []).map((p) => p.guest)
    : kind === "machine" ? (state.machines.find((m) => m.name === name)?.ports || []).map((p) => p.guest) : [];
  const submit = async (e) => {
    e.preventDefault();
    const [asName, asPort] = as.trim().split(/:(\d+)$/);
    try {
      const l = await actions.api("/v1/links", { method: "POST", body: { from: from.name, from_kind: from.kind, to: name, to_kind: kind,
        port: +port, as: asName || undefined, as_port: asPort ? +asPort : undefined } });
      setPort(""); setAs("");
      onDone(`${from.name} reaches ${l.to}:${l.port} as ${l.as}:${l.as_port}`);
    } catch (err) { onError(err.message); }
  };
  if (!targets.length) return html`<p class="caption link-none">Up another machine or add a service to link ${from.name} to it.</p>`;
  return html`<form class="link-form" onSubmit=${submit}>
    <h4>Link ${from.kind === "template" ? `every machine of ${from.name}` : from.name} to</h4>
    <label>Machine or service <select required value=${target} onChange=${(e) => setTarget(e.target.value)}>
      <option value="" disabled>Choose…</option>
      ${targets.map((t) => html`<option value=${`${t.kind}:${t.name}`}>${t.name} (${t.kind === "template" ? "any machine of it" : t.kind})</option>`)}
    </select></label>
    <label>Its port <input ref=${portRef} type="number" min="1" max="65535" required value=${port} onInput=${(e) => setPort(e.target.value)}
      placeholder=${known[0] || "5432"} list="link-ports" /></label>
    <datalist id="link-ports">${known.map((p) => html`<option value=${p} />`)}</datalist>
    <label>Reached as <input value=${as} onInput=${(e) => setAs(e.target.value)} placeholder=${`${name || "name"}:${port || "port"}`} autocomplete="off" spellcheck="false" /></label>
    <button class="btn" type="submit" disabled=${!target || !port}>Link</button>
  </form>`;
}
