// Fleets, like compose projects: each a snowglobe.toml (added from where it is, or written here),
// run as instances. The list on the left; the selected fleet on the right: its instances, the
// steps its plan would take in the one shown (each its own Apply), and its file.

import { html, useEffect, useState } from "./vendor/preact/index.js";
import { useStore } from "./store.js";

const STARTER = `# What the fleet is made of, and what reaches what. Nothing reaches anything
# but what a link says; mode says whether each instance keeps to itself.
[network]
mode = "exclusive"      # exclusive | inclusive | all

[templates.app]
site = "/path/to/dist/app"   # a built site (or build = "./app", a Dockerfile directory)
egress = "internet"          # none (the default) | internet | private

[services.app]
template = "app"
ports = ["8080:8000"]
`;

const MARK = { create: "+", replace: "~", remove: "−" };

export function Fleets() {
  const { state, actions } = useStore();
  const fleets = state?.fleets || [];
  const chosen = state?.fleet;
  const [adding, setAdding] = useState(null);
  useEffect(() => {
    if (!chosen && fleets.length && !adding) actions.showFleet(fleets[0].name, true);
  }, [fleets.length, chosen]);
  if (!state) return null;
  return html`<div class="fleets">
    <nav class="fleet-list" aria-label="Fleets">
      <ol>${fleets.map((f) => html`<li>
        <button type="button" class="fleet-item" aria-current=${chosen === f.name && !adding ? "true" : null} onClick=${() => { setAdding(null); actions.showFleet(f.name); }}>
          <span class=${"dot " + (f.objects ? "live" : "idle")}></span>
          <b>${f.name}</b>
          <small>${f.error ? "its file doesn't plan" : [
            f.instances?.length ? `${f.instances.length} instance${f.instances.length > 1 ? "s" : ""}` : "not running",
            f.pending ? `${f.pending} step${f.pending > 1 ? "s" : ""} to apply` : f.file ? "as its file says" : "no file"].join(" · ")}</small>
        </button></li>`)}
      </ol>
      ${!fleets.length && html`<p class="caption">No fleets yet.</p>`}
      <div class="fleet-new">
        <button type="button" class="btn" aria-pressed=${adding === "new" ? "true" : "false"} onClick=${() => setAdding("new")}>New fleet</button>
        <button type="button" class="link" onClick=${() => setAdding("file")}>Add a file</button>
      </div>
    </nav>
    <div class="fleet-detail">
      ${adding === "new" && html`<${NewFleet} done=${(name) => { setAdding(null); actions.showFleet(name); }} />`}
      ${adding === "file" && html`<${AddFile} done=${(name) => { setAdding(null); actions.showFleet(name); }} />`}
      ${!adding && chosen && html`<${Fleet} name=${chosen} />`}
      ${!adding && !chosen && html`<p class="empty">A fleet is a snowglobe.toml: templates, the services and machines made of
        them, and the links between them. Start one with New fleet, or add a file you have.</p>`}
    </div>
  </div>`;
}

function NewFleet({ done }) {
  const { actions } = useStore();
  const [name, setName] = useState("");
  const [text, setText] = useState(STARTER);
  const [error, setError] = useState(null);
  const save = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      await actions.api("/v1/fleets", { method: "POST", body: { name, text } });
      await actions.refreshFleets();
      done(name);
    } catch (err) { setError(err.message); }
  };
  return html`<form class="fleet-form" onSubmit=${save}>
    <h3>New fleet</h3>
    <p class="caption">Its file is kept by the daemon. It is checked before it is saved; nothing starts until you apply it.</p>
    <label>Name <input required pattern="[A-Za-z0-9][A-Za-z0-9_-]{0,62}" value=${name} onInput=${(e) => setName(e.target.value)} placeholder="todo" autocomplete="off" /></label>
    <label>snowglobe.toml <textarea rows="16" spellcheck="false" value=${text} onInput=${(e) => setText(e.target.value)}></textarea></label>
    ${error && html`<p class="said bad" role="alert">${error}</p>`}
    <div class="form-end"><button class="btn" type="submit">Save the fleet</button></div>
  </form>`;
}

function AddFile({ done }) {
  const { actions } = useStore();
  const [path, setPath] = useState("");
  const [error, setError] = useState(null);
  const add = async (e) => {
    e.preventDefault();
    setError(null);
    try {
      const f = await actions.api("/v1/fleets", { method: "POST", body: { file: path.trim() } });
      await actions.refreshFleets();
      done(f.name);
    } catch (err) { setError(err.message); }
  };
  return html`<form class="fleet-form" onSubmit=${add}>
    <h3>Add a fleet file</h3>
    <p class="caption">A snowglobe.toml on this host stays where it is: its relative paths are from its directory, and changes made here are written to it.</p>
    <label>Its full path <input required value=${path} onInput=${(e) => setPath(e.target.value)} placeholder="/Users/you/code/app/snowglobe.toml" autocomplete="off" spellcheck="false" /></label>
    ${error && html`<p class="said bad" role="alert">${error}</p>`}
    <div class="form-end"><button class="btn" type="submit">Add</button></div>
  </form>`;
}

function Fleet({ name }) {
  const { state, actions } = useStore();
  const view = state.fleetView;
  const [busy, setBusy] = useState(null);
  const [log, setLog] = useState([]);
  const [error, setError] = useState(null);
  const [text, setText] = useState(null);
  const [editing, setEditing] = useState(false);
  useEffect(() => { setLog([]); setError(null); setText(null); setEditing(false); }, [name]);
  if (!view || view.name !== name) return html`<p class="caption">Planning ${name}…</p>`;
  const inst = view.plan?.instance || "main";
  const instances = view.instances?.length ? view.instances : [];
  const plan = view.plan;
  const run = async (what, fn) => {
    setBusy(what); setError(null);
    try {
      const res = await fn();
      setLog(res?.log || []);
      if (res?.error) setError(res.error);
    } catch (e) { setError(e.message); }
    await actions.showFleet(name, true, inst);
    setBusy(null);
  };
  const apply = (step) => run(step || "all", () => actions.applyStep(step, inst));
  const start = () => run("start", async () => {
    const res = await actions.post(`/v1/fleets/${name}/instances`, {});
    if (res.instance) await actions.showFleet(name, true, res.instance);
    return res;
  });
  const stop = () => confirm(`Remove instance ${inst} of ${name}? Its machines and what they wrote go; the templates stay.`)
    && run("stop", () => actions.api(`/v1/fleets/${name}/instances/${inst}`, { method: "DELETE" }));
  const forget = () => confirm(`Forget fleet ${name}${view.owned ? " and its file" : ""}, after removing everything it made?`)
    && run("forget", async () => { const r = await actions.api(`/v1/fleets/${name}?down=1`, { method: "DELETE" }); await actions.refreshFleets(); actions.showFleet(null); return r; });
  const save = () => run("save", async () => { await actions.api(`/v1/fleets/${name}`, { method: "PUT", body: { text } }); setEditing(false); setText(null); return {}; });
  const shown = instances.includes(inst) ? instances : [...instances, inst];
  return html`<div class="fleet">
    <div class="fleet-head">
      <h3>${name}</h3>
      ${view.file && html`<code class="fleet-file" title=${view.file}>${view.file}</code>`}
      <span class="fleet-actions">
        <button type="button" class="link" disabled=${!!busy} onClick=${forget}>${busy === "forget" ? "Removing…" : "Remove the fleet"}</button>
      </span>
    </div>
    ${view.error && html`<p class="said bad" role="alert">${view.error}</p>`}
    ${view.file && html`<div class="instances" role="tablist" aria-label="Instances">
      ${shown.map((i) => html`<button type="button" role="tab" class="instance" aria-selected=${i === inst ? "true" : "false"}
          onClick=${() => actions.showFleet(name, true, i)}>${i}${instances.includes(i) ? "" : html` <small>not running</small>`}</button>`)}
      <button type="button" class="link start" disabled=${!!busy} onClick=${start}>${busy === "start" ? "Starting…" : "Start another instance"}</button>
    </div>`}
    ${plan && html`<section class="plan" aria-label=${`Instance ${inst}`}>
      <div class="plan-head">
        <span class="caption">${plan.steps.length ? `${plan.steps.length} step${plan.steps.length > 1 ? "s" : ""} to apply in ${inst}` : `${inst} is as the file says`}${plan.unchanged ? ` · ${plan.unchanged} as the file says` : ""}</span>
        <span class="plan-actions">
          ${plan.steps.length > 0 && html`<button class="btn" type="button" disabled=${!!busy} onClick=${() => apply(null)}>${busy === "all" ? "Applying…" : "Apply all"}</button>`}
          ${instances.includes(inst) && html`<button class="link" type="button" disabled=${!!busy} onClick=${stop}>${busy === "stop" ? "Removing…" : `Remove instance ${inst}`}</button>`}
        </span>
      </div>
      ${plan.steps.length > 0 && html`<ol class="steps">${plan.steps.map((s) => html`<li class=${s.ready ? "" : "waits"}>
        <span class="mark" aria-label=${s.action}>${MARK[s.action]}</span>
        <span class="what"><b>${s.kind} ${s.name}</b><small title=${s.detail}>${s.detail}${s.per_instance ? "" : " · shared"}</small></span>
        <span class="when">${s.ready ? "ready" : `after ${(s.deps || []).join(", ")}`}</span>
        <button class="btn" type="button" disabled=${!s.ready || !!busy} onClick=${() => apply(s.key)}>${busy === s.key ? "Applying…" : s.action === "remove" ? "Remove" : "Apply"}</button>
      </li>`)}</ol>`}
    </section>`}
    ${error && html`<p class="said bad" role="alert">${error}</p>`}
    ${log.length > 0 && html`<pre class="plan-log">${log.join("\n")}</pre>`}
    ${view.file && html`<details class="fleet-text" open=${editing} onToggle=${(e) => setEditing(e.currentTarget.open)}>
      <summary>The file</summary>
      <textarea rows="18" spellcheck="false" value=${text ?? view.text} onInput=${(e) => setText(e.target.value)} aria-label="snowglobe.toml"></textarea>
      <div class="form-end">
        <button class="btn" type="button" disabled=${text === null || text === view.text || !!busy} onClick=${save}>${busy === "save" ? "Checking…" : "Save"}</button>
        ${text !== null && text !== view.text && html`<button class="link" type="button" onClick=${() => setText(null)}>Discard changes</button>`}
      </div>
    </details>`}
  </div>`;
}
