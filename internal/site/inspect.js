// What an agent sees of the agent page's preview, and how it uses it: preview_snapshot and
// preview_interact. The preview's frame is this site's (same origin), so the page reads its
// document directly: its address and title, its visible text, an outline of its landmarks,
// headings and controls (each control with a short ref, e.g. e3, that stays the same element's
// for as long as the page is not reloaded), and what the page in it logged: console errors and
// warnings, uncaught errors, rejected promises, failed requests (preview-hook.js, which the
// service worker puts in every page of the preview, posts them here).
//
// preview_interact runs actions in that document with real DOM events: a click as pointer and
// mouse events then click(), typing through the input's own value setter (so React and other
// frameworks that track the value see it) and input and change events, a key as keydown and
// keyup (Enter in a form's field submits it), an option selected, a box checked, a scroll, or a
// wait for text or a control to appear or go. After each action it waits for the page to settle
// (no DOM changes for a moment, a navigation loaded), stops at the first that fails, and returns
// a fresh, shorter snapshot.
//
// Nothing here touches a machine: the build line comes from the page (the server's /__build).
(function (root) {
  "use strict";

  const LOG_MAX = 200; // entries kept, across loads
  const LOG_SHOWN = 30; // entries a snapshot shows, at most
  const ENTRY_CHARS = 600;
  const OUTLINE_MAX = 400; // lines
  const NAME_CHARS = 80;
  const SETTLE_QUIET_MS = 150;
  const SETTLE_MAX_MS = 1500;
  const NAV_MS = 8000;
  const WAIT_DEFAULT_MS = 5000;
  const WAIT_MAX_MS = 30000;

  const LANDMARK = { header: "banner", nav: "navigation", main: "main", aside: "complementary", footer: "contentinfo", dialog: "dialog", form: "form" };
  const SKIP = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "title", "svg", "iframe", "object", "canvas"]);
  const ROLE_CONTROL = new Set(["button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "textbox", "searchbox", "combobox", "slider", "spinbutton"]);
  const ROLE_LANDMARK = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "dialog", "alertdialog", "form", "region", "search"]);
  const ROLE_LIVE = new Set(["alert", "status"]);
  const TEXT_INPUT = new Set(["text", "email", "password", "search", "tel", "url", "number", "date", "datetime-local", "month", "time", "week", ""]);

  const squash = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  const cut = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
  const q = (s) => JSON.stringify(s);
  const tag = (el) => String(el.tagName ?? "").toLowerCase();
  const attr = (el, n) => (typeof el.getAttribute === "function" ? el.getAttribute(n) : null);
  const kids = (el) => [...(el.children ?? [])];

  function walk(el, fn) {
    for (const c of kids(el)) if (fn(c) !== false) walk(c, fn);
  }

  /** Is the element shown (not hidden, not display: none, not aria-hidden)? Its subtree is skipped when not. */
  function shown(el, win) {
    if (SKIP.has(tag(el))) return false;
    if (el.hidden === true || attr(el, "aria-hidden") === "true" || el.inert === true) return false;
    if (tag(el) === "dialog" && !el.open && attr(el, "open") === null) return false;
    if (tag(el) === "input" && String(el.type ?? attr(el, "type") ?? "").toLowerCase() === "hidden") return false;
    if (win && typeof win.getComputedStyle === "function") {
      try {
        const cs = win.getComputedStyle(el);
        if (cs && (cs.display === "none" || cs.visibility === "hidden" || cs.contentVisibility === "hidden")) return false;
      } catch {}
    }
    return true;
  }

  const BLOCK = new Set(["address", "article", "aside", "blockquote", "br", "dd", "details", "dialog", "div", "dl", "dt", "fieldset", "figcaption", "figure",
    "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tr", "ul"]);

  /** The text a person sees in an element: shown elements only, a line per block. (Not
   *  innerText: in a frame that isn't displayed, as when the Code tab is shown, it is the raw
   *  textContent, scripts and all.) */
  function visibleText(el, win) {
    const out = [];
    const go = (n) => {
      if (n.nodeType === 3) { out.push(n.textContent ?? ""); return; }
      if (n.nodeType !== 1 || !shown(n, win)) return;
      const t = tag(n);
      const block = BLOCK.has(t);
      if (block) out.push("\n");
      if (t === "input" || t === "textarea" || t === "select") return;
      for (const c of n.childNodes ?? []) go(c);
      if (block) out.push("\n");
      else if (t === "td" || t === "th") out.push("\t");
    };
    for (const c of el.childNodes ?? []) go(c);
    return out.join("").split("\n").map((l) => l.replace(/[ \t\r\f\v\u00a0]+/g, " ").trim()).filter(Boolean).join("\n");
  }

  function textOf(el) {
    return squash(visibleText(el, el.ownerDocument?.defaultView ?? null));
  }

  /** What a control is: its role, or null for an element that isn't one. */
  function roleOf(el) {
    const role = attr(el, "role");
    if (role && (ROLE_CONTROL.has(role) || ROLE_LANDMARK.has(role) || ROLE_LIVE.has(role))) return role;
    const t = tag(el);
    switch (t) {
      case "a": return attr(el, "href") !== null ? "link" : null;
      case "button": return "button";
      case "summary": return "button";
      case "select": return el.multiple ? "listbox" : "combobox";
      case "textarea": return "textbox";
      case "input": {
        const type = String(el.type ?? attr(el, "type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "range") return "slider";
        if (type === "file") return "button";
        return type === "search" ? "searchbox" : "textbox";
      }
      case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": return "heading";
      case "img": return attr(el, "alt") ? "img" : null;
      case "section": return attr(el, "aria-label") || attr(el, "aria-labelledby") ? "region" : null;
      default: break;
    }
    if (LANDMARK[t]) return LANDMARK[t];
    if (attr(el, "contenteditable") === "true" || attr(el, "contenteditable") === "") return "textbox";
    return null;
  }

  const isControl = (role) => ROLE_CONTROL.has(role) || role === "listbox";

  /** A control's accessible name, as a person reads it: its label, else its text. */
  function nameOf(el, doc) {
    const byIds = attr(el, "aria-labelledby");
    if (byIds) {
      const t = byIds.split(/\s+/).map((id) => doc.getElementById?.(id)).filter(Boolean).map(textOf).join(" ");
      if (squash(t)) return cut(squash(t), NAME_CHARS);
    }
    const label = attr(el, "aria-label");
    if (squash(label)) return cut(squash(label), NAME_CHARS);
    const t = tag(el);
    if (t === "input" || t === "select" || t === "textarea") {
      const type = String(el.type ?? attr(el, "type") ?? "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return cut(squash(el.value ?? attr(el, "value")) || (type === "reset" ? "Reset" : "Submit"), NAME_CHARS);
      const id = attr(el, "id");
      let lab = null;
      const esc = doc.defaultView?.CSS?.escape;
      if (id && esc) { try { lab = doc.querySelector(`label[for="${esc(id)}"]`); } catch {} }
      else if (id) walk(doc.body ?? doc.documentElement ?? doc, (x) => { if (!lab && tag(x) === "label" && attr(x, "for") === id) lab = x; return !lab; });
      if (!lab) for (let p = el.parentElement; p; p = p.parentElement) if (tag(p) === "label") { lab = p; break; }
      if (lab) {
        // The label's own words, without a select's options or another control's text
        const words = squash(labelText(lab));
        if (words) return cut(words, NAME_CHARS);
      }
      const other = attr(el, "title") || attr(el, "placeholder");
      return other ? cut(squash(other), NAME_CHARS) : "";
    }
    if (t === "img") return cut(squash(attr(el, "alt")), NAME_CHARS);
    const own = textOf(el);
    if (own) return cut(own, NAME_CHARS);
    // An icon button: its title, or the label of an image or svg in it
    let alt = attr(el, "title");
    if (!alt) walk(el, (x) => { if (!alt) alt = attr(x, "aria-label") || attr(x, "alt") || (tag(x) === "title" ? squash(x.textContent) : null); return !alt; });
    return cut(squash(alt), NAME_CHARS);
  }

  function labelText(lab) {
    let s = "";
    const go = (el) => {
      for (const n of el.childNodes ?? []) {
        if (n.nodeType === 3) s += " " + n.textContent;
        else if (n.nodeType === 1 && !["select", "input", "textarea", "button"].includes(tag(n))) go(n);
      }
    };
    go(lab);
    return s || lab.textContent || "";
  }

  /** One control (or landmark, heading) as a line of the outline. */
  function describe(el, role, name, ref) {
    const parts = [role];
    if (name) parts.push(q(name));
    if (role === "heading") parts.push(`[level ${tag(el).slice(1) || attr(el, "aria-level") || "?"}]`);
    if (ref) parts.push(`[${ref}]`);
    const t = tag(el);
    if (role === "textbox" || role === "searchbox" || role === "slider" || role === "spinbutton") {
      const type = String(el.type ?? attr(el, "type") ?? "").toLowerCase();
      const v = t === "input" || t === "textarea" ? String(el.value ?? "") : textOf(el);
      parts.push(type === "password" ? (v ? "value=(hidden)" : 'value=""') : `value=${q(cut(v, 120))}`);
      const ph = attr(el, "placeholder");
      if (ph && ph !== name) parts.push(`placeholder=${q(cut(ph, 60))}`);
      if (type && type !== "text" && t === "input") parts.push(`type=${type}`);
    }
    if (role === "checkbox" || role === "radio" || role === "switch") {
      const on = t === "input" ? !!el.checked : attr(el, "aria-checked") === "true";
      parts.push(on ? "checked" : "unchecked");
    }
    if (role === "combobox" || role === "listbox") {
      if (t === "select") {
        const opts = [...(el.options ?? [])].map((o) => squash(o.label ?? o.textContent ?? o.value));
        const sel = [...(el.options ?? [])].find((o) => o.selected);
        parts.push(`value=${q(sel ? squash(sel.label ?? sel.textContent) : String(el.value ?? ""))}`);
        if (opts.length) parts.push(`options: ${cut(opts.join(" | "), 200)}`);
      }
    }
    if (role === "link") {
      const href = attr(el, "href");
      if (href && !href.startsWith("javascript:")) parts.push(`-> ${cut(href, 100)}`);
    }
    if (el.disabled === true || attr(el, "aria-disabled") === "true") parts.push("disabled");
    if (attr(el, "aria-expanded")) parts.push(`expanded=${attr(el, "aria-expanded")}`);
    if (attr(el, "aria-pressed")) parts.push(`pressed=${attr(el, "aria-pressed")}`);
    if (attr(el, "aria-selected") === "true") parts.push("selected");
    if (attr(el, "aria-invalid") === "true") parts.push("invalid");
    if (el.required === true) parts.push("required");
    return parts.join(" ");
  }

  /** "3 s ago", "2 min ago" */
  function ago(ms) {
    if (ms < 1000) return "just now";
    if (ms < 60000) return `${Math.round(ms / 1000)} s ago`;
    return `${Math.round(ms / 60000)} min ago`;
  }

  /**
   * The preview's state for the agent: `get()` gives { frame (the iframe), url (the preview's
   * base, for the path) } or null when no preview is open. Keeps the refs it gave out and what
   * the page in the preview logged.
   */
  class Inspector {
    constructor({ now = () => Date.now(), timers = root } = {}) {
      this.now = now;
      this.timers = timers;
      this.doc = null;
      this.refs = new Map(); // ref -> element
      this.ids = new WeakMap(); // element -> ref
      this.next = 1;
      this.logs = [];
      this.loadAt = 0; // when the page in the preview last loaded (its hook said so)
      this.loads = 0;
      this.dropped = 0;
    }

    /** An entry from the preview's hook: { level, text, url?, at? }; level "load" starts a page load. */
    log(entry) {
      if (!entry || typeof entry !== "object") return;
      const level = String(entry.level ?? "log");
      const at = typeof entry.at === "number" && Math.abs(entry.at - this.now()) < 60000 ? entry.at : this.now();
      if (level === "load") {
        this.loadAt = at;
        this.loads++;
      }
      this.logs.push({ level, text: cut(String(entry.text ?? ""), ENTRY_CHARS), url: typeof entry.url === "string" ? entry.url : "", at });
      if (this.logs.length > LOG_MAX) {
        this.logs.shift();
        this.dropped++;
      }
    }

    clearLogs() {
      this.logs = [];
      this.dropped = 0;
    }

    /** The document in the frame, refs reset when it is another one than before (a reload). */
    _doc(frame) {
      let doc = null;
      try { doc = frame?.contentDocument ?? frame?.contentWindow?.document ?? null; } catch { doc = null; }
      if (doc !== this.doc) {
        this.doc = doc;
        this.refs = new Map();
        this.ids = new WeakMap();
        this.next = 1;
      }
      return doc;
    }

    _ref(el) {
      let r = this.ids.get(el);
      if (!r) {
        r = `e${this.next++}`;
        this.ids.set(el, r);
      }
      this.refs.set(r, el);
      return r;
    }

    /**
     * The page as an agent reads it: { url, title, outline: [lines], text, console: [lines],
     * counts, truncated }. `maxChars` bounds outline and text together.
     */
    read(frame, { maxChars = 12000, text: withText = true } = {}) {
      const doc = this._doc(frame);
      if (!doc) throw new Error("the preview's page can't be read (it is still loading, or isn't this site's)");
      const win = doc.defaultView ?? null;
      const body = doc.body ?? doc.documentElement;
      // Refs of elements gone from the page are forgotten
      for (const [r, el] of this.refs) if (el.isConnected === false) this.refs.delete(r);
      const outline = [];
      let more = 0;
      const visit = (el, depth) => {
        if (!shown(el, win)) return;
        const role = roleOf(el);
        let d = depth;
        if (role) {
          if (outline.length >= OUTLINE_MAX) more++;
          else if (isControl(role)) outline.push("  ".repeat(depth) + "- " + describe(el, role, nameOf(el, doc), this._ref(el)));
          else if (role === "heading" || role === "img") outline.push("  ".repeat(depth) + "- " + describe(el, role, role === "img" ? nameOf(el, doc) : textOf(el).slice(0, NAME_CHARS)));
          else if (ROLE_LIVE.has(role)) {
            const t = textOf(el);
            if (t) outline.push("  ".repeat(depth) + `- ${role} ${q(cut(t, 300))}`);
          } else {
            const n = attr(el, "aria-label") || (attr(el, "aria-labelledby") ? nameOf(el, doc) : "");
            outline.push("  ".repeat(depth) + "- " + role + (n ? " " + q(cut(squash(n), NAME_CHARS)) : ""));
            d = depth + 1;
          }
          // A control's insides aren't listed again (a button's icon, a link's text)
          if (isControl(role) && tag(el) !== "label") return;
        }
        for (const c of kids(el)) visit(c, d);
      };
      if (body) for (const c of kids(body)) visit(c, 0);
      if (more) outline.push(`[${more} more elements not listed]`);

      let text = withText && body ? visibleText(body, win) : "";
      let outlineText = outline.join("\n");
      let truncated = false;
      const budget = Math.max(500, maxChars | 0);
      if (outlineText.length > budget) {
        outlineText = outlineText.slice(0, budget);
        outlineText = outlineText.slice(0, outlineText.lastIndexOf("\n") + 1 || budget) + `[outline cut at ${budget} characters]`;
        text = "";
        truncated = true;
      } else if (text.length > budget - outlineText.length) {
        const room = Math.max(0, budget - outlineText.length);
        if (text.length > room) {
          text = text.slice(0, room) + (room ? "…" : "");
          truncated = true;
        }
      }

      let url = "";
      try { url = String(win?.location?.href ?? doc.URL ?? ""); } catch {}
      return { url, title: squash(doc.title), outline: outlineText, text, truncated, ready: doc.readyState ?? "complete" };
    }

    /** The console of the page shown now (since its last load), the newest last, at most LOG_SHOWN. */
    consoleSince(since = this.loadAt) {
      const list = this.logs.filter((e) => e.at >= since && e.level !== "load");
      const counts = { error: 0, warn: 0, network: 0, log: 0 };
      for (const e of list) counts[e.level === "error" || e.level === "warn" || e.level === "network" ? e.level : "log"]++;
      // Errors and failed requests are kept first when there are too many to show
      let shownList = list;
      if (list.length > LOG_SHOWN) {
        const quiet = (e) => e.level === "log" || e.level === "info" || e.level === "debug";
        const keep = new Set(list.filter((e) => !quiet(e)).slice(-LOG_SHOWN));
        for (const e of list.filter(quiet).reverse()) { if (keep.size >= LOG_SHOWN) break; keep.add(e); }
        shownList = list.filter((e) => keep.has(e));
      }
      const now = this.now();
      return { counts, total: list.length, lines: shownList.map((e) => `[${e.level} ${ago(now - e.at)}] ${e.text}`) };
    }

    /** Resolve an action's target: a ref from the last snapshot, a CSS selector, or (click, check) its visible text. */
    target(doc, a, { required = true } = {}) {
      const win = doc.defaultView ?? null;
      if (a.ref !== undefined) {
        if (typeof a.ref !== "string" || !/^e\d+$/.test(a.ref)) throw new Error(`ref: a ref from preview_snapshot, e.g. "e3" (got ${q(a.ref)})`);
        const el = this.refs.get(a.ref);
        if (!el) throw new Error(`ref ${a.ref} is not in the latest snapshot of this page (it reloaded, or the ref is from before): call preview_snapshot for fresh refs`);
        if (el.isConnected === false || (el.ownerDocument && el.ownerDocument !== doc)) {
          this.refs.delete(a.ref);
          throw new Error(`ref ${a.ref} is stale: the page re-rendered and that element is gone; call preview_snapshot for fresh refs`);
        }
        return el;
      }
      if (a.selector !== undefined) {
        if (typeof a.selector !== "string" || !a.selector.trim()) throw new Error("selector: a CSS selector");
        let el;
        try { el = doc.querySelector(a.selector); } catch (e) { throw new Error(`selector ${q(a.selector)}: not a valid CSS selector`); }
        if (!el) throw new Error(`nothing in the page matches ${q(a.selector)}`);
        return el;
      }
      if (typeof a.text === "string" && a.text.trim() && a.type !== "wait_for" && a.type !== "type") {
        const want = squash(a.text).toLowerCase();
        let exact = null;
        let partial = null;
        const visit = (el) => {
          if (exact || !shown(el, win)) return false;
          const role = roleOf(el);
          if (role && isControl(role)) {
            const n = nameOf(el, doc).toLowerCase();
            if (n === want) exact = el;
            else if (!partial && n.includes(want)) partial = el;
            return false;
          }
          return true;
        };
        walk(doc.body ?? doc, visit);
        const el = exact ?? partial;
        if (!el) throw new Error(`no button, link or field labelled ${q(a.text)} in the page: use a ref from preview_snapshot`);
        return el;
      }
      if (required) throw new Error(`${a.type}: give ref (from preview_snapshot) or selector`);
      return null;
    }
  }

  // ---------------------------------------------------------------- events

  function ctor(win, name, fallback = "Event") {
    return win?.[name] ?? win?.[fallback] ?? root[name] ?? root[fallback];
  }

  function fire(win, el, type, Kind, init = {}) {
    const C = ctor(win, Kind);
    let ev;
    try { ev = new C(type, { bubbles: true, cancelable: true, composed: true, view: win ?? undefined, ...init }); } catch {
      const E = ctor(win, "Event");
      ev = new E(type, { bubbles: true, cancelable: true });
    }
    return el.dispatchEvent(ev);
  }

  /** Set a field's value as typing would: through the element's own prototype setter, so a
   *  framework that wraps the instance's value property (React) notices the change. */
  function setValue(win, el, value) {
    const t = tag(el);
    const proto = t === "textarea" ? win?.HTMLTextAreaElement?.prototype : t === "select" ? win?.HTMLSelectElement?.prototype : win?.HTMLInputElement?.prototype;
    const setter = proto ? Object.getOwnPropertyDescriptor(proto, "value")?.set : null;
    if (setter) setter.call(el, value);
    else el.value = value;
  }

  const describeTarget = (el, doc) => {
    const role = roleOf(el) ?? tag(el);
    const n = nameOf(el, doc);
    return n ? `${role} ${q(n)}` : role;
  };

  /**
   * Run `actions` in the frame's document, in order: each { type, ref?, selector?, text?, value?,
   * key?, gone?, timeoutMs? }. Resolves { done: [what each did], error?: message at the first that
   * failed (the rest not run) }. `settle(action, { before, leaving })` waits for the page after each.
   */
  async function run(inspector, frame, actions, { settle, pause, signal } = {}) {
    if (!Array.isArray(actions) || !actions.length) throw new Error("actions: a list of actions, e.g. [{type: \"click\", ref: \"e3\"}]");
    if (actions.length > 30) throw new Error("actions: at most 30 in one call");
    const done = [];
    for (let i = 0; i < actions.length; i++) {
      const a = actions[i] ?? {};
      if (signal?.aborted) return { done, error: `stopped before action ${i + 1}: the call was cancelled` };
      const doc = inspector._doc(frame);
      if (!doc) return { done, error: `action ${i + 1} (${a.type}): the preview's page isn't loaded` };
      // An action that leaves the page (a link, a form's submit) is waited for to its next one
      let leaving = false;
      const leave = () => { leaving = true; };
      const win = doc.defaultView;
      try { win?.addEventListener?.("beforeunload", leave); win?.addEventListener?.("pagehide", leave); } catch {}
      try {
        const said = await act(inspector, frame, doc, a, { pause });
        done.push(said);
        if (settle) await settle(a, { before: doc, leaving: () => leaving });
      } catch (e) {
        return { done, error: `action ${i + 1} (${a.type ?? "?"}): ${e?.message ?? e}` };
      } finally {
        try { win?.removeEventListener?.("beforeunload", leave); win?.removeEventListener?.("pagehide", leave); } catch {}
      }
    }
    return { done };
  }

  async function act(inspector, frame, doc, a, { pause = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
    const win = doc.defaultView ?? null;
    const usable = (el) => {
      if (el.disabled === true || attr(el, "aria-disabled") === "true") throw new Error(`${describeTarget(el, doc)} is disabled`);
      if (!shown(el, win)) throw new Error(`${describeTarget(el, doc)} is hidden`);
    };
    switch (a.type) {
      case "click": {
        const el = inspector.target(doc, a);
        usable(el);
        try { el.scrollIntoView?.({ block: "center", inline: "nearest" }); } catch {}
        const opts = { button: 0, buttons: 1, clientX: 0, clientY: 0 };
        fire(win, el, "pointerdown", "PointerEvent", { ...opts, pointerType: "mouse", isPrimary: true });
        fire(win, el, "mousedown", "MouseEvent", opts);
        try { el.focus?.({ preventScroll: true }); } catch {}
        fire(win, el, "pointerup", "PointerEvent", { ...opts, buttons: 0, pointerType: "mouse", isPrimary: true });
        fire(win, el, "mouseup", "MouseEvent", { ...opts, buttons: 0 });
        el.click();
        return `clicked ${describeTarget(el, doc)}`;
      }
      case "type": {
        const value = typeof a.value === "string" ? a.value : typeof a.text === "string" && (a.ref !== undefined || a.selector !== undefined) ? a.text : null;
        if (value === null) throw new Error("type: value, the text to type");
        const el = inspector.target(doc, { ...a, text: undefined });
        usable(el);
        const t = tag(el);
        const editable = attr(el, "contenteditable") === "true" || attr(el, "contenteditable") === "";
        if (t === "input") {
          const type = String(el.type ?? attr(el, "type") ?? "text").toLowerCase();
          if (!TEXT_INPUT.has(type)) throw new Error(`${describeTarget(el, doc)} is a ${type} input, not one to type in`);
        } else if (t !== "textarea" && !editable) throw new Error(`${describeTarget(el, doc)} is not a text field`);
        if (el.readOnly === true) throw new Error(`${describeTarget(el, doc)} is read-only`);
        try { el.focus?.({ preventScroll: false }); } catch {}
        if (editable) {
          el.textContent = value;
          fire(win, el, "input", "InputEvent", { inputType: "insertText", data: value });
        } else {
          setValue(win, el, a.append === true ? String(el.value ?? "") + value : value);
          fire(win, el, "input", "InputEvent", { inputType: "insertText", data: value });
          fire(win, el, "change", "Event");
        }
        return `typed ${q(cut(value, 60))} in ${describeTarget(el, doc)}`;
      }
      case "press": {
        const key = typeof a.key === "string" && a.key ? a.key : null;
        if (!key) throw new Error('press: key, e.g. "Enter", "Escape", "Tab", "ArrowDown", "a"');
        const el = inspector.target(doc, a, { required: false }) ?? doc.activeElement ?? doc.body;
        const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, keyCode: { Enter: 13, Escape: 27, Tab: 9, " ": 32 }[key] ?? 0 };
        const go = fire(win, el, "keydown", "KeyboardEvent", init);
        if (key.length === 1 || key === "Enter") fire(win, el, "keypress", "KeyboardEvent", init);
        fire(win, el, "keyup", "KeyboardEvent", init);
        // A synthetic Enter doesn't submit a form: done here, as the browser would, unless the page stopped it
        if (go && key === "Enter" && tag(el) === "input" && el.form) {
          if (typeof el.form.requestSubmit === "function") el.form.requestSubmit();
          else el.form.submit?.();
        }
        return `pressed ${key}${el && el !== doc.body ? ` in ${describeTarget(el, doc)}` : ""}`;
      }
      case "select": {
        const el = inspector.target(doc, a);
        usable(el);
        if (tag(el) !== "select") throw new Error(`${describeTarget(el, doc)} is not a select`);
        const want = String(a.value ?? a.text ?? "");
        const opt = [...(el.options ?? [])].find((o) => o.value === want) ?? [...(el.options ?? [])].find((o) => squash(o.label ?? o.textContent).toLowerCase() === want.toLowerCase());
        if (!opt) throw new Error(`${describeTarget(el, doc)} has no option ${q(want)}`);
        setValue(win, el, opt.value);
        fire(win, el, "input", "Event");
        fire(win, el, "change", "Event");
        return `selected ${q(squash(opt.label ?? opt.textContent ?? opt.value))} in ${describeTarget(el, doc)}`;
      }
      case "check": {
        const el = inspector.target(doc, a);
        usable(el);
        const want = a.value === false || a.value === "false" ? false : true;
        const t = tag(el);
        const isBox = t === "input" && ["checkbox", "radio"].includes(String(el.type ?? attr(el, "type")).toLowerCase());
        const now = isBox ? !!el.checked : attr(el, "aria-checked") === "true";
        if (!isBox && !["checkbox", "switch", "radio", "menuitemcheckbox"].includes(attr(el, "role"))) throw new Error(`${describeTarget(el, doc)} is not a checkbox, radio or switch`);
        if (now !== want) el.click();
        // A controlled box may be put back at once and set only once the app's own work is done
        // (a request, then a re-render): its state is polled until it matches, within the limit.
        // Matching at any poll counts; the settle after the action waits for the DOM to be quiet
        const limit = Math.min(WAIT_MAX_MS, Math.max(0, Number.isFinite(a.timeoutMs) ? a.timeoutMs : WAIT_DEFAULT_MS));
        const state = () => {
          const live = el.isConnected === false ? inspector.refs.get(a.ref) ?? el : el;
          return isBox ? !!live.checked : attr(live, "aria-checked") === "true";
        };
        const t0 = Date.now();
        while (state() !== want) {
          if (Date.now() - t0 >= limit) {
            throw new Error(`${describeTarget(el, doc)} never became ${want ? "checked" : "unchecked"} within ${limit} ms ` +
              "(the app may still be saving it, or put it back): call preview_snapshot to see its state");
          }
          await pause(100);
        }
        return `${want ? "checked" : "unchecked"} ${describeTarget(el, doc)}${now === want ? " (it already was)" : Date.now() - t0 > 150 ? ` (after ${Date.now() - t0} ms)` : ""}`;
      }
      case "scroll": {
        const el = inspector.target(doc, a, { required: false });
        if (el) {
          el.scrollIntoView?.({ block: "center" });
          return `scrolled to ${describeTarget(el, doc)}`;
        }
        const v = a.value;
        if (v === "top" || v === "bottom") {
          win?.scrollTo?.(0, v === "top" ? 0 : (doc.documentElement?.scrollHeight ?? 1e6));
          return `scrolled to the ${v}`;
        }
        const dy = typeof v === "number" && Number.isFinite(v) ? v : Math.round((win?.innerHeight ?? 600) * 0.8);
        win?.scrollBy?.(0, dy);
        return `scrolled ${dy >= 0 ? "down" : "up"} ${Math.abs(dy)} px`;
      }
      case "wait_for": {
        const limit = Math.min(WAIT_MAX_MS, Math.max(0, Number.isFinite(a.timeoutMs) ? a.timeoutMs : WAIT_DEFAULT_MS));
        const gone = a.gone === true;
        const hasText = typeof a.text === "string" && a.text.trim();
        if (!hasText && a.ref === undefined && a.selector === undefined) throw new Error("wait_for: text, ref or selector to wait for (gone: true to wait for it to go)");
        const t0 = Date.now();
        const present = () => {
          const d = inspector._doc(frame);
          if (!d) return false;
          if (hasText) return textOf(d.body ?? d).toLowerCase().includes(squash(a.text).toLowerCase());
          try { const el = inspector.target(d, { ...a, text: undefined }); return shown(el, d.defaultView); } catch { return false; }
        };
        for (;;) {
          if (present() !== gone) {
            const what = hasText ? q(cut(squash(a.text), 60)) : a.ref ?? q(a.selector);
            return `${what} ${gone ? "went" : "appeared"} after ${Date.now() - t0} ms`;
          }
          if (Date.now() - t0 >= limit) {
            const what = hasText ? `the text ${q(cut(squash(a.text), 60))}` : a.ref ?? q(a.selector);
            throw new Error(`${what} did not ${gone ? "go" : "appear"} within ${limit} ms`);
          }
          await pause(100);
        }
      }
      default:
        throw new Error(`type: one of click, type, press, select, check, scroll, wait_for (got ${q(a.type)})`);
    }
  }

  /**
   * Wait for the page in `frame` to settle after an action: a navigation it started loaded (up to
   * NAV_MS), then no DOM change for SETTLE_QUIET_MS (at most SETTLE_MAX_MS).
   */
  async function settle(frame, { before = null, leaving = () => false, pause = (ms) => new Promise((r) => setTimeout(r, ms)), quietMs = SETTLE_QUIET_MS, maxMs = SETTLE_MAX_MS, navMs = NAV_MS } = {}) {
    const docNow = () => { try { return frame?.contentDocument ?? null; } catch { return null; } };
    await pause(30);
    const t0 = Date.now();
    // A navigation: the next document, loaded (the old one stays until the answer comes)
    while (Date.now() - t0 < navMs) {
      const d = docNow();
      if (d && d.readyState === "complete" && d.URL !== "about:blank" && !(leaving() && d === before)) break;
      await pause(50);
    }
    const doc = docNow();
    const MO = doc?.defaultView?.MutationObserver;
    if (!doc || typeof MO !== "function") return pause(quietMs);
    await new Promise((resolve) => {
      let last = Date.now();
      const start = Date.now();
      const mo = new MO(() => { last = Date.now(); });
      try { mo.observe(doc.documentElement ?? doc, { subtree: true, childList: true, attributes: true, characterData: true }); } catch { resolve(); return; }
      const tick = () => {
        if (Date.now() - last >= quietMs || Date.now() - start >= maxMs) {
          mo.disconnect();
          resolve();
        } else setTimeout(tick, 40);
      };
      setTimeout(tick, 40);
    });
  }

  /** The build line of a snapshot: what the preview shows against the server's last build. */
  function buildText(b, shownVersion) {
    if (!b || typeof b.version !== "number") return "no build information (the server has no /__build: it isn't serve --watch)";
    const first = String(b.error ?? "").split("\n").find((l) => l.trim()) ?? "";
    switch (b.state) {
      case "building": return `build ${b.version + 1} under way: what is shown is from an earlier build; snapshot again once it is done`;
      case "error": return `build ${b.version} FAILED (${cut(first.trim(), 200)}): the preview shows the last build that worked; build_status has the whole error`;
      case "ok":
        if (shownVersion != null && shownVersion < b.version) return `build ${b.version} ok, but the preview has not reloaded with it yet: snapshot again in a moment`;
        return `build ${b.version} ok${b.ms != null ? ` (${(b.ms / 1000).toFixed(1)} s)` : ""}: the preview shows the latest build`;
      default: return `build ${b.version}: ${b.state}`;
    }
  }

  /** A snapshot as the text an agent gets. */
  function snapshotText(s, { build, consoleInfo, path, done, error } = {}) {
    const out = [];
    if (done?.length || error) {
      for (const d of done ?? []) out.push(`done: ${d}`);
      if (error) out.push(`FAILED: ${error}`);
      out.push("");
    }
    out.push(`page: ${path ?? s.url}${s.title ? `  (title ${q(s.title)})` : ""}${s.ready && s.ready !== "complete" ? `  [${s.ready}]` : ""}`);
    if (build !== undefined) out.push(`build: ${build}`);
    out.push("", "outline (refs like [e3] are for preview_interact):", s.outline || "(nothing shown: an empty page, or it is still rendering)");
    if (s.text) out.push("", "visible text:", s.text);
    if (consoleInfo) {
      const c = consoleInfo.counts;
      const sum = [c.error && `${c.error} error${c.error === 1 ? "" : "s"}`, c.warn && `${c.warn} warning${c.warn === 1 ? "" : "s"}`,
        c.network && `${c.network} failed request${c.network === 1 ? "" : "s"}`, c.log && `${c.log} other`].filter(Boolean).join(", ");
      out.push("", `console since the page loaded: ${sum || "nothing"}`);
      if (consoleInfo.lines.length) out.push(...consoleInfo.lines);
      if (consoleInfo.total > consoleInfo.lines.length) out.push(`[${consoleInfo.total - consoleInfo.lines.length} earlier entries not shown]`);
    }
    if (s.truncated) out.push("", "[cut short: call preview_snapshot with a larger maxChars to see more]");
    return out.join("\n");
  }

  /** The timeline's words for what preview_interact did: "Clicked "Add", typed "Buy milk"…" */
  function stepsTitle(done, error) {
    const words = done.map((d) => d.replace(/ in (textbox|searchbox|combobox) "[^"]*"$/, "").replace(/ (button|link|checkbox|textbox|radio|switch|combobox|tab|menuitem) (".*")$/, " $2"));
    let t = words.length ? words.join(", ") : "Tried to use the preview";
    t = t.charAt(0).toUpperCase() + t.slice(1);
    if (t.length > 140) t = t.slice(0, 139) + "…";
    return error ? `${t}${done.length ? "; then" : ":"} failed` : t;
  }

  const SnowglobeInspect = { Inspector, run, act, settle, buildText, snapshotText, stepsTitle, roleOf, nameOf, describe, shown, visibleText,
    limits: { LOG_MAX, LOG_SHOWN, OUTLINE_MAX, WAIT_MAX_MS } };
  if (typeof module === "object" && module.exports) module.exports = SnowglobeInspect;
  else root.SnowglobeInspect = SnowglobeInspect;
})(typeof window !== "undefined" ? window : globalThis);
