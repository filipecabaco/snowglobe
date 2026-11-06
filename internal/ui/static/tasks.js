// One control per task: add a template, up a machine, add a service, or link two of them. Each
// is its own small form; one shows at a time. Fleets have a view of their own (fleets.js).

import { html, useEffect, useRef, useState } from "./vendor/preact/index.js";
import { useStore } from "./store.js";
import { LinkForm } from "./inspect.js";

const NAME = "[A-Za-z0-9][A-Za-z0-9_-]{0,62}";
const TASKS = [
  ["template", "Add a template"],
  ["machine", "Up a machine"],
  ["service", "Add a service"],
  ["link", "Link"],
];

export function Tasks() {
  const { state } = useStore();
  const [task, setTask] = useState("template");
  const [said, say] = useState(null);
  useEffect(() => say(null), [task]);
  // The graph asks for a task (an empty fleet, "Link" from the inspector...)
  useEffect(() => {
    const on = (e) => setTask(e.detail);
    addEventListener("snowglobe:task", on);
    return () => removeEventListener("snowglobe:task", on);
  }, []);
  if (!state) return null;
  const done = (text) => say({ ok: true, text });
  const failed = (text) => say({ ok: false, text });
  return html`<div class="tasks">
    <div class="task-tabs" role="tablist" aria-label="Tasks">
      ${TASKS.map(([k, label]) => html`<button type="button" role="tab" id=${"task-" + k} aria-selected=${task === k ? "true" : "false"}
        aria-controls="task-panel" class="task-tab" onClick=${() => setTask(k)}>${label}</button>`)}
    </div>
    <div class="task-panel" id="task-panel" role="tabpanel" aria-labelledby=${"task-" + task}>
      ${task === "template" && html`<${AddTemplate} done=${done} failed=${failed} />`}
      ${task === "machine" && html`<${UpMachine} done=${done} failed=${failed} />`}
      ${task === "service" && html`<${AddService} done=${done} failed=${failed} />`}
      ${task === "link" && html`<${Link} done=${done} failed=${failed} />`}
      ${said && html`<p class=${"said" + (said.ok ? "" : " bad")} role=${said.ok ? "status" : "alert"}>${said.text}</p>`}
    </div>
  </div>`;
}

// A form's fields by name, and a submit that says how it went
function useForm(fn, done, failed) {
  const [busy, setBusy] = useState(false);
  const { actions } = useStore();
  const onSubmit = async (e) => {
    e.preventDefault();
    const form = e.currentTarget;
    setBusy(true);
    try {
      done(await fn(form.elements, actions));
      form.reset();
    } catch (err) {
      failed(err.message);
    }
    setBusy(false);
    actions.refresh();
  };
  return { onSubmit, busy };
}

function TemplateSelect({ name = "template" }) {
  const { state } = useStore();
  if (!state.templates.length) return html`<select name=${name} disabled><option>No templates yet</option></select>`;
  return html`<select name=${name} required>${state.templates.map((t) => html`<option value=${t.name}>${t.name}</option>`)}</select>`;
}

function AddTemplate({ done, failed }) {
  const { onSubmit, busy } = useForm(async (f, a) => {
    const t = await a.api("/v1/templates", { method: "POST", body: { site: f.site.value.trim(), name: f.name.value || undefined, idle: f.idle.value || undefined } });
    return `Template ${t.name} restored: machines fork from it now`;
  }, done, failed);
  return html`<form class="inline-form" onSubmit=${onSubmit}>
    <p class="task-intro">A built site restored once, for machines to fork from in milliseconds.</p>
    <label class="grow">Built site <input name="site" required placeholder="/path/to/dist/python or a site's URL" autocomplete="off" spellcheck="false" /></label>
    <label>Name <input name="name" placeholder="py" autocomplete="off" pattern=${NAME} /></label>
    <label>Sleep when idle <input name="idle" placeholder="30m" autocomplete="off" /></label>
    <button class="btn" type="submit" disabled=${busy}>${busy ? "Restoring…" : "Add template"}</button>
  </form>`;
}

// What holds the host ports typed in a Ports field, said as they are typed
function PortsHint({ value }) {
  const { actions } = useStore();
  const [said, setSaid] = useState([]);
  useEffect(() => {
    const timer = setTimeout(async () => {
      const out = [];
      for (const spec of value.split(/[\s,]+/).filter(Boolean)) {
        const parts = spec.split(":");
        const host = parts.at(-2), ip = parts.length > 2 ? parts.slice(0, -2).join(":") : "";
        if (parts.length < 2 || !+host) { out.push(`${spec}: the system picks a free host port`); continue; }
        try {
          const c = await actions.api(`/v1/ports/check?port=${encodeURIComponent(host)}&ip=${encodeURIComponent(ip)}`);
          out.push(`${c.ip}:${c.port} ${c.free ? "is free" : `is taken by ${c.by}`}`);
        } catch (err) { out.push(`${spec}: ${err.message}`); }
      }
      setSaid(out);
    }, 300);
    return () => clearTimeout(timer);
  }, [value]);
  return html`<p class="check-result" aria-live="polite">${said.join("; ")}</p>`;
}

function UpMachine({ done, failed }) {
  const [ports, setPorts] = useState("");
  const { actions } = useStore();
  const { onSubmit, busy } = useForm(async (f, a) => {
    const m = await a.api("/v1/machines", { method: "POST", body: { template: f.template.value, name: f.name.value || undefined,
      ports: f.ports.value.split(/[\s,]+/).filter(Boolean), ttl: f.ttl.value || undefined } });
    setPorts("");
    actions.select("machine", m.name, "graph");
    return `${m.name} is up${m.ports?.length ? `, on ${m.ports.map((p) => `${p.ip}:${p.host}`).join(" ")}` : ""}`;
  }, done, failed);
  return html`<form class="inline-form" onSubmit=${onSubmit}>
    <p class="task-intro">A fork of a template that lasts until it is stopped, with its ports open on this host.</p>
    <label>Template <${TemplateSelect} /></label>
    <label>Name <input name="name" placeholder="made up when empty" autocomplete="off" pattern=${NAME} /></label>
    <label>Ports <input name="ports" placeholder="8080:8000" autocomplete="off" value=${ports} onInput=${(e) => setPorts(e.target.value)} /></label>
    <label>Time to live <input name="ttl" placeholder="1h" autocomplete="off" /></label>
    <button class="btn" type="submit" disabled=${busy}>${busy ? "Forking…" : "Up a machine"}</button>
    <${PortsHint} value=${ports} />
  </form>`;
}

function AddService({ done, failed }) {
  const [ports, setPorts] = useState("");
  const { onSubmit, busy } = useForm(async (f, a) => {
    const list = f.ports.value.split(/[\s,]+/).filter(Boolean).map((p) => {
      const parts = p.split(":");
      const guest = +parts.pop(), host = +parts.pop() || 0, ip = parts.join(":") || undefined;
      return { ip, host, guest };
    });
    const s = await a.api("/v1/services", { method: "POST", body: { name: f.name.value, template: f.template.value, ports: list,
      min: +f.min.value, max: +f.max.value, idle: f.idle.value || undefined, state: f.state.value } });
    setPorts("");
    return `Service ${s.name} holds ${(s.ports || []).map((p) => `${p.ip}:${p.host}`).join(" ") || "no port"}`;
  }, done, failed);
  return html`<form class="inline-form" onSubmit=${onSubmit}>
    <p class="task-intro">A template's machines behind host ports: each connection goes to a replica, started on demand, and at zero none runs.</p>
    <label>Name <input name="name" required placeholder="web" autocomplete="off" pattern=${NAME} /></label>
    <label>Template <${TemplateSelect} /></label>
    <label>Ports <input name="ports" placeholder="8080:8000" autocomplete="off" value=${ports} onInput=${(e) => setPorts(e.target.value)} /></label>
    <label>Replicas <span class="pair"><input name="min" type="number" min="0" value="0" aria-label="Fewest" /> to <input name="max" type="number" min="1" value="1" aria-label="Most" /></span></label>
    <label>Idle <input name="idle" value="5m" autocomplete="off" /></label>
    <label>State <select name="state"><option value="discard">discard</option><option value="keep">keep</option></select></label>
    <button class="btn" type="submit" disabled=${busy}>${busy ? "Adding…" : "Add service"}</button>
    <${PortsHint} value=${ports} />
  </form>`;
}

function Link({ done, failed }) {
  const { state } = useStore();
  const sources = [...state.machines.map((m) => ({ kind: "machine", name: m.name })), ...state.templates.map((t) => ({ kind: "template", name: t.name }))];
  const [from, setFrom] = useState("");
  const chosen = sources.find((s) => `${s.kind}:${s.name}` === from);
  if (!sources.length) return html`<p class="task-intro">Up a machine first: a link lets one machine (or every machine of a template) reach another machine or a service by a name.</p>`;
  return html`<div>
    <p class="task-intro">One machine, or every machine of a template, reaches another machine or a service by a name, at once, while they run. Or drag from a node's handle onto another in the graph.</p>
    <div class="inline-form">
      <label>From <select value=${from} onChange=${(e) => setFrom(e.target.value)}>
        <option value="" disabled>Choose…</option>
        ${sources.map((s) => html`<option value=${`${s.kind}:${s.name}`}>${s.name} (${s.kind === "template" ? "every machine of it" : "machine"})</option>`)}
      </select></label>
    </div>
    ${chosen && html`<${LinkForm} from=${chosen} onDone=${done} onError=${failed} />`}
  </div>`;
}
