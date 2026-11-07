// Workspace controls shared by every generated page. Storage is local; no server receives checkpoints.
(function (root) {
  "use strict";
  const S = root.SnowglobeSessions;
  const newID = () => crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)),
    b => b.toString(16).padStart(2, "0")).join("");
  const intervals = [60000, 300000, 900000];
  // Let the pause notice paint before the synchronous WASM serializer blocks this thread.
  // The fallback also permits completion if the user backgrounds the tab between frames.
  const paint = () => new Promise(resolve => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
  class SnowglobeSessionUI {
    constructor(config) {
      this.config = config;
      // Saves, the one-tab lock and the folder name are per scope: the page's directory, unless the
      // page names its own (the agent page keeps its saves apart from the terminal page's)
      this.scope = config.scope ?? new URL("./", location.href).pathname;
      this.records = [];
      this.revision = 0;
      this.settings = {};
      this.busy = false;
      this.captureBusy = false;
      this.blocked = false;
      this.timer = null;
      this.panel = document.getElementById("sessions");
      this.status = document.getElementById("session-status");
      this.hint = document.getElementById("session-hint");
      this.lastSave = document.getElementById("session-last-save");
      this.changes = document.getElementById("session-changes");
      this.pauseNotice = document.getElementById("session-paused");
      this.help = document.getElementById("session-help");
      this.detail = document.getElementById("session-detail");
      this.select = document.getElementById("session-list");
      this.method = document.getElementById("session-method");
      this.autosave = document.getElementById("session-autosave");
      this.filename = document.getElementById("session-filename");
      this.buttons = Array.from(document.getElementById("workspace-bar").querySelectorAll("button, select, input"));
      const folderOption = this.method.querySelector('[value="folder"]');
      folderOption.disabled = typeof showDirectoryPicker !== "function";
      if (folderOption.disabled) folderOption.textContent = "Folder — unavailable in this browser";
      this.method.value = "browser";
      this.method.onchange = () => this.controls();
      this.autosave.onchange = () => {
        const value = this.autosave.value;
        return this.operation(() => this.setAutosave(value), "Autosave not changed");
      };
      document.getElementById("session-save").onclick = () => {
        this.panel.open = false;
        this.term?.focus?.();
        this.operation(() => this.save());
      };
      document.getElementById("session-fresh").onclick = () => this.operation(() => this.startFresh(), "Workspace not changed");
      document.getElementById("session-new").onclick = () => this.operation(() => this.newSession(), "Workspace not changed");
      document.getElementById("session-delete").onclick = () => this.operation(() => this.deleteSession(), "Workspace not deleted");
      document.getElementById("session-export").onclick = () => this.operation(() => this.exportSession(), "Backup not created");
      document.getElementById("session-import").onchange = e => {
        const file = e.target.files[0];
        e.target.value = "";
        if (file) this.operation(() => this.importSession(file), "Backup not restored");
      };
      document.getElementById("session-folder").onclick = () => {
        // Call the picker directly in the click handler, before any awaits lose user activation.
        const picked = showDirectoryPicker({ mode: "readwrite" });
        this.operation(async () => this.useFolder(await picked), "Folder not changed");
      };
      document.getElementById("session-reconnect").onclick = () => {
        const permission = this.settings.folderHandle.requestPermission({ mode: "readwrite" });
        this.operation(async () => {
          if (await permission !== "granted") throw new Error("Folder permission was not granted");
          this.reload();
        }, "Folder needs access");
      };
      document.getElementById("session-browser").onclick = () => this.operation(() => this.useBrowser(), "Storage not changed");
      this.select.onchange = () => this.controls();
      document.getElementById("session-open").onclick = () => this.operation(async () => {
        if (this.select.value === this.active?.id || !confirm("Open this workspace? Changes since the last save will be lost.")) return;
        this.progress("Opening workspace…", "Please wait. Your saved workspaces are kept.");
        await this.setActive(this.select.value);
        this.reload();
      }, "Workspace not opened");
      // A popover must not take terminal space or remain over it while the user works.
      document.addEventListener("pointerdown", e => {
        if (!this.panel.contains(e.target)) this.panel.open = false;
      });
      document.addEventListener("keydown", e => {
        // Disabling a busy action can move focus to the body. Handle Escape there too,
        // before xterm consumes it, but leave terminal keys alone when the menu is closed.
        if (!this.closed && e.key === "Escape" && this.panel.open) {
          this.panel.open = false;
          this.panel.querySelector("summary")?.focus();
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);
      addEventListener("pagehide", () => {
        this.closed = true;
        clearTimeout(this.timer);
        if (this.initialState) URL.revokeObjectURL(this.initialState);
        // No unload-time save. Keep the lock until document destruction: releasing it here
        // could let another tab write while a bfcache-suspended checkpoint is still in flight.
        this.vm?.stop().catch(() => {});
      });
      addEventListener("pageshow", e => { if (e.persisted) this.reload(); });
      this.controls();
    }
    reload() { location.reload(); }
    idleHint() {
      if (!this.store || this.blocked) return "Automatic saving unavailable. Open Save / restore for recovery or a backup.";
      return this.settings.autosave
        ? "Autosave on. Refresh returns to the last completed save."
        : "Autosave off — use Save now before leaving.";
    }
    workHint() {
      return this.vm?.running ? "You can keep working. Keep this tab open until finished."
        : "The terminal is stopped. Keep this tab open until finished.";
    }
    message(text, error = false, help = "", detail = "") {
      this.working = false;
      this.status.textContent = text;
      this.status.dataset.error = String(error);
      this.status.dataset.working = "false";
      this.status.title = this.lastSaveInfo ?? help;
      this.hint.textContent = help || this.idleHint();
      this.help.textContent = help;
      this.help.hidden = !help;
      this.detail.textContent = detail || this.lastSaveInfo || "No saved version yet.";
      this.activity();
      if (error) this.panel.open = true;
    }
    progress(text, hint) {
      this.message(text);
      this.working = true;
      this.status.dataset.working = "true";
      this.hint.textContent = hint;
    }
    activity() {
      const dirty = this.revision > (this.savedRevision ?? 0);
      this.changes.hidden = !dirty || this.status.textContent === "Unsaved changes";
      this.changes.textContent = "Unsaved changes";
    }
    controls() {
      for (const el of this.buttons) el.disabled = this.busy || this.closed;
      const unavailable = !this.store || this.blocked;
      document.getElementById("session-save").disabled ||= unavailable || !this.vm;
      this.autosave.disabled ||= unavailable || !this.vm;
      this.autosave.value = this.settings.autosave === false ? "off" : String(this.settings.autosaveInterval ?? 60000);
      for (const id of ["session-fresh", "session-new", "session-delete", "session-import", "session-list", "session-folder", "session-browser"]) {
        document.getElementById(id).disabled ||= !this.browser;
      }
      document.getElementById("session-open").disabled ||= !this.store || !this.select.value || this.select.value === this.active?.id;
      document.getElementById("session-export").disabled ||= !crypto.subtle || !this.active || (!this.vm && !this.active.savedAt);
      document.getElementById("session-delete").disabled ||= !this.store || !this.active?.savedAt;
      document.getElementById("session-reconnect").hidden = !this.needsPermission;
      document.getElementById("session-browser").hidden = !this.settings.folderHandle;
      document.getElementById("session-browser").textContent = !this.blocked && (this.vm || this.active?.savedAt)
        ? "Switch automatic saves to this browser…" : "Start in this browser instead…";
      document.getElementById("session-folder").textContent = this.settings.folderHandle ? "Change folder…" : "Choose folder…";
      const folder = this.settings.folderHandle;
      const path = folder ? [folder.name || "Chosen folder", this.store?.directory?.name].filter(Boolean).join(" / ") : "";
      document.getElementById("session-location").textContent = !this.browser && this.active ? "Temporary run — not saving"
        : folder ? `Save location: ${path}${this.needsPermission ? " (needs access)" : ""}` : "Save location: This browser";
      document.getElementById("session-folder-location").textContent = folder ? `Current folder: ${path}` : "No folder selected.";
      for (const method of ["browser", "backup", "folder"]) {
        document.getElementById(`session-${method}-options`).hidden = this.method.value !== method;
      }
    }
    pauseInput(paused) {
      const terminal = document.getElementById("terminal");
      if (paused) this.terminalFocused = terminal.contains(document.activeElement);
      this.captureBusy = paused;
      this.pauseNotice.hidden = !paused;
      terminal.inert = paused;
      document.getElementById("keys").inert = paused;
      if (this.term?.options) {
        if (paused) this.stdinDisabled = this.term.options.disableStdin;
        this.term.options.disableStdin = paused ? true : this.stdinDisabled;
      }
      // inert blurs xterm; restore typing unless the user moved focus elsewhere.
      if (!paused && this.terminalFocused && !this.closed && document.activeElement === document.body) this.term?.focus?.();
    }
    async operation(fn, failure = "Not saved") {
      if (this.busy || this.closed) return;
      this.busy = true;
      this.controls();
      try { await fn(); }
      catch (e) {
        if (e instanceof WebAssembly.RuntimeError) {
          this.blocked = true; // a trapped serializer may have leaked allocations; do not retry automatically
          this.message("Saving paused", true,
            "The workspace could not be captured, possibly because memory is low. Reload to try again. Your previous save is kept.", e.message);
        } else if (e.name !== "AbortError") {
          this.message(failure, true, e.name === "QuotaExceededError"
            ? "Storage is full. Download a backup or choose a folder. Your previous save is kept."
            : `${e.message}. Your previous saves are kept.`);
        }
      }
      finally {
        this.busy = false;
        if (this.working && !this.closed) this.savedMessage();
        this.controls();
      }
    }
    async prepare() {
      this.progress("Opening workspace…", "Please wait while saved work is checked.");
      try {
        this.release = await S.acquireLock(this.scope);
        this.browser = await S.BrowserStore.open(this.scope);
        this.settings = await this.browser.settings();
      } catch (e) {
        this.release?.();
        this.browser = null;
        this.active = { version: 1, id: newID(), name: "Temporary", config: this.config };
        this.message("Not saving in this tab", true, crypto.subtle
          ? "Your work stays in this tab only. Download a backup before leaving, or close other tabs and reload to try saving again."
          : "Open this demo on HTTPS or localhost to save your work.", e.message);
        this.controls();
        return true;
      }
      this.settings.autosave ??= true;
      if (!intervals.includes(this.settings.autosaveInterval)) this.settings.autosaveInterval = 60000;
      this.method.value = this.settings.folderHandle ? "folder" : "browser";
      this.store = this.browser;
      try {
        if (this.settings.folderHandle) {
          this.store = null; // folder failures must never redirect writes into browser storage
          this.needsPermission = await this.settings.folderHandle.queryPermission({ mode: "readwrite" }) !== "granted";
          if (this.needsPermission) {
            this.blocked = true;
            this.message("Folder needs access", true,
              "Reconnect your folder to reopen saved work, or use this browser instead. Your folder files are kept.");
            this.controls();
            return false;
          }
          const directory = await this.folderDirectory(this.settings.folderHandle);
          this.store = new S.FolderStore(directory);
        }
        const saved = this.settings.active ? await this.store.get(this.settings.active) : null;
        this.active = saved ?? { version: 1, id: this.settings.active ?? newID(), name: this.settings.pendingName ?? "Workspace", config: this.config };
        this.showLastSave();
        await this.setActive(this.active.id);
        await this.refreshList();
        if (saved && !S.compatible(saved, this.config)) {
          this.blocked = true;
          this.message("Saved work needs its original demo", true,
            "This demo has changed. Download your previous backup or start fresh. Your saved work is kept.");
          this.controls();
          return false;
        }
        if (saved) {
          this.progress("Restoring workspace…", "Please wait while your saved machine and terminal are restored.");
          this.initialState = URL.createObjectURL(await S.stateBlob(saved));
          this.savedRevision = this.revision = saved.revision ?? 0;
          this.records = [saved.console];
          this.replay = S.consoleEvents(await saved.console.arrayBuffer());
          this.showLastSave();
        } else this.message("Not saved yet");
        this.controls();
        return true;
      } catch (e) {
        if (this.initialState) URL.revokeObjectURL(this.initialState);
        this.blocked = true;
        this.message("Workspace needs attention", true,
          "Your saved work could not be opened. Try reconnecting your folder, use this browser instead, or start fresh. Existing saves are kept.", e.message);
        this.controls();
        return false;
      }
    }
    async setActive(id) {
      const settings = { ...this.settings, active: id };
      await this.browser.settings(settings);
      this.settings = settings;
    }
    async refreshList() {
      const entries = await this.store.list();
      if (this.active && !entries.some(e => e.id === this.active.id)) entries.push(this.active);
      this.select.replaceChildren(...entries.map(c => {
        const option = document.createElement("option");
        option.value = c.id;
        option.textContent = c.name + (c.unreadable ? " (unreadable; kept)" : S.compatible(c, this.config) ? "" : " (needs original demo)");
        return option;
      }));
      this.select.value = this.active?.id;
    }
    attach(vm, term, applyResize) {
      this.vm = vm;
      this.applyResize = applyResize;
      if (this.initialState) URL.revokeObjectURL(this.initialState);
      this.initialState = null;
      this.replay = null;
      this.term = term;
      this.controls();
      if (this.store && !this.blocked) this.savedMessage();
      this.schedule();
    }
    // Suspended (from its capture to the wake), nothing goes on the tape: the woken machine records
    // its own size as it starts
    record(bytes) { if (this.asleep) return; this.records.push(S.consoleRecord(bytes)); this.revision++; this.changed(); }
    resize(cols, rows) { if (!this.asleep) this.records.push(S.resizeRecord(cols, rows)); }
    changed() {
      this.activity();
      if (this.vm && this.store && !this.busy && !this.blocked && this.status.dataset.error !== "true" && this.status.textContent !== "Unsaved changes") this.savedMessage();
    }
    input() {
      if (this.captureBusy || this.closed) return false;
      this.revision++;
      this.changed();
      return true;
    }
    showLastSave() {
      if (!this.active?.savedAt) { this.lastSave.textContent = "No save yet"; return; }
      const date = new Date(this.active.savedAt);
      this.lastSaveInfo = `Last saved ${date.toLocaleString()} · ${(this.active.state.size / (1 << 20)).toFixed(1)} MB`;
      this.lastSave.textContent = `Last saved ${date.toLocaleTimeString()}`;
      this.lastSave.title = this.lastSaveInfo;
    }
    savedMessage() {
      this.showLastSave();
      this.message(this.revision > (this.savedRevision ?? 0) ? "Unsaved changes" : this.active?.savedAt ? "Saved" : "Not saved yet");
    }
    async setAutosave(value) {
      if (value !== "off" && !intervals.includes(Number(value))) throw new Error("Choose a supported autosave interval");
      const settings = { ...this.settings, autosave: value !== "off",
        autosaveInterval: value === "off" ? this.settings.autosaveInterval : Number(value) };
      await this.browser.settings(settings);
      this.settings = settings;
      this.schedule();
      this.savedMessage();
      this.controls();
    }
    schedule(delay = this.settings.autosaveInterval ?? 60000) {
      clearTimeout(this.timer);
      this.timer = null;
      if (this.closed || !this.store || this.blocked || !this.settings.autosave || !this.vm) return;
      this.timer = setTimeout(async () => {
        const started = performance.now();
        if (!this.blocked && !this.busy && this.vm.running && !document.hidden) {
          await this.operation(() => this.save());
        }
        // Never spend most of the session serializing a large machine.
        this.schedule(Math.max(this.settings.autosaveInterval, (performance.now() - started) * 10));
      }, delay);
    }
    async checkpoint(label = "Saving", captured) {
      this.progress(`${label}… Copying workspace`, "Terminal briefly paused while a consistent copy is captured.");
      let console, revision, bytes;
      this.pauseInput(true);
      try {
        await paint();
        if (this.closed) throw new DOMException("The page is closing", "AbortError");
        bytes = await S.capture(this.vm, () => {
          console = new Blob(this.records); revision = this.revision;
          this.records = [console]; // compact the tape's record list without dropping bytes
          captured?.();
        });
      }
      finally { this.pauseInput(false); this.applyResize?.(); }
      if (this.closed) await this.vm.stop();
      this.progress(`${label}… Preparing data`, this.workHint());
      const packed = await S.packState(bytes);
      return { version: 1, id: this.active.id, name: this.active.name, config: this.config,
        savedAt: Math.max(Date.now(), (this.active.savedAt ?? 0) + 1), console, revision, ...packed };
    }
    async save() {
      if (!this.store || this.blocked || !this.vm) throw new Error("Workspace storage is unavailable");
      const c = await this.checkpoint();
      this.progress(this.settings.folderHandle ? "Saving… Writing to folder" : "Saving… Writing to browser", this.workHint());
      await this.store.put(c);
      this.active = c;
      this.savedRevision = c.revision;
      delete this.settings.pendingName;
      this.savedMessage();
      // The checkpoint is already committed. Failure of ancillary settings/list updates
      // must not claim the user's machine state was lost.
      try { await this.browser.settings(this.settings); }
      catch (e) { this.message("Saved with a warning", true, "Your work is saved, but workspace settings could not be updated.", e.message); }
      try { await this.refreshList(); }
      catch (e) { this.message("Saved with a warning", true, "Your work is saved, but other saved workspaces could not be listed.", e.message); }
    }
    /**
     * Suspend: capture the stopped machine, save it as the workspace where saves go (so a reload
     * restores it too), and let go of the machine. Returns the checkpoint a wake restores, read
     * back from storage when it was saved there, so this page holds no copy of its own.
     */
    async suspend() {
      if (this.busy || this.closed || !this.vm) throw new Error("the workspace is busy");
      this.busy = true;
      this.controls();
      try {
        // From the moment it is captured, what the old machine prints or the terminal does is
        // not on the tape: the state saved has none of it
        let c = await this.checkpoint("Suspending", () => { this.asleep = true; });
        let stored = false;
        if (this.store && !this.blocked) {
          try {
            this.progress(this.settings.folderHandle ? "Suspending… Writing to folder" : "Suspending… Writing to browser", "");
            await this.store.put(c);
            this.savedRevision = c.revision;
            delete this.settings.pendingName;
            stored = true;
            // The copy in storage, read back: the one just captured (its state in this page's
            // memory) is let go, kept neither here nor as this.active
            try { c = (await this.store.get(c.id)) ?? c; } catch {}
            this.active = c;
            this.showLastSave();
            try { await this.browser.settings(this.settings); } catch {}
          } catch {
            // Kept in this page instead: the wake still has it
          }
        }
        clearTimeout(this.timer);
        this.timer = null;
        this.vm = null;
        this.message("Suspended", false, stored
          ? "Saved, and the machine's memory freed. The next command wakes it."
          : "The machine's memory is freed; its state is kept in this tab only. The next command wakes it.");
        return c;
      } catch (e) {
        // Not suspended: the machine runs on, and its tape with it
        this.asleep = false;
        throw e;
      } finally {
        this.busy = false;
        this.controls();
      }
    }
    /** Woken: the new machine takes the old one's place. */
    resume(vm) {
      this.asleep = false;
      this.vm = vm;
      this.controls();
      if (this.store && !this.blocked) this.savedMessage();
      this.schedule();
    }
    startFresh() { return this.newSession(`Workspace ${new Date().toLocaleString()}`); }
    async newSession(name) {
      const named = name === undefined;
      if (named) name = prompt("Workspace name (up to 100 characters):", "My workspace");
      if (name === null) return;
      if (!name.trim() || name.trim().length > 100) throw new Error("Choose a name between 1 and 100 characters");
      if ((this.vm || this.active?.savedAt || !named) && !confirm("Start a fresh workspace? Unsaved changes will be lost. Your saved work is kept under Saved workspaces.")) return;
      this.progress("Starting fresh workspace…", "Please wait. Previous saved workspaces are kept.");
      // Save the name independently until its first checkpoint exists.
      const settings = { ...this.settings, active: newID(), pendingName: name.trim() };
      await this.browser.settings(settings);
      this.settings = settings;
      this.reload();
    }
    async deleteSession() {
      if (!confirm(`Delete the saved workspace “${this.active.name}”? This cannot be undone. Other workspaces are kept.`)) return;
      this.progress("Deleting saved workspace…", "Please wait. Other saved workspaces are kept.");
      await this.store.remove(this.active.id);
      delete this.settings.active;
      delete this.settings.pendingName;
      await this.browser.settings(this.settings);
      this.reload();
    }
    async exportSession() {
      let filename = this.filename.value.trim();
      if (!filename || filename.length > 120 || /[<>:"/\\|?*\x00-\x1f]/.test(filename)) throw new Error("Choose a filename without slashes or special characters");
      if (!filename.toLowerCase().endsWith(".snowglobe")) filename += ".snowglobe";
      this.progress("Preparing backup…", this.workHint());
      const c = this.vm && !this.blocked ? await this.checkpoint("Preparing backup") : await this.store.get(this.active.id);
      if (!c) throw new Error("No saved version to download");
      this.progress("Preparing backup file…", this.workHint());
      const url = URL.createObjectURL(await S.encodeBackup(c));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      this.message("Backup download started", false, "Complete the download in your browser. This is an extra copy; your automatic-save location is unchanged.");
    }
    async importSession(file) {
      this.progress("Checking backup file…", this.workHint());
      const c = await S.decodeBackup(file);
      if (!S.compatible(c, this.config)) throw new Error("This backup needs the original compatible demo to restore it");
      if (!this.store) throw new Error("Reconnect your folder or use this browser first");
      if (!confirm("Restore this backup? Unsaved changes will be lost. Existing saved workspaces are kept.")) return;
      this.progress("Restoring backup…", "Keep this tab open. Existing saved workspaces are kept.");
      const imported = { ...c, id: newID(), name: c.name };
      await this.store.put(imported);
      await this.setActive(imported.id);
      this.reload();
    }
    async folderDirectory(handle) {
      const hash = await S.digest(new Blob([location.origin, this.scope]));
      return handle.getDirectoryHandle(`snowglobe-${hash.slice(0, 24)}`, { create: true });
    }
    async useBrowser() {
      const canKeep = !this.blocked && (this.vm || this.active?.savedAt);
      if (!confirm(canKeep ? "Save in this browser instead? Your folder saves are kept."
        : "Start in this browser instead? Changes since the last save will be lost. Your folder saves are kept.")) return;
      const settings = { autosave: this.settings.autosave, autosaveInterval: this.settings.autosaveInterval };
      if (canKeep) {
        const current = this.vm ? await this.checkpoint() : await this.store.get(this.active.id);
        const c = { ...current, id: newID() };
        this.progress("Saving… Writing to browser", this.workHint());
        await this.browser.put(c);
        settings.active = c.id;
      }
      await this.browser.settings(settings);
      this.settings = settings;
      this.reload();
    }
    async useFolder(handle) {
      const store = new S.FolderStore(await this.folderDirectory(handle));
      // Import the current session into its own UUID; never overwrite an existing folder session.
      const current = this.blocked ? null : this.vm ? await this.checkpoint()
        : this.active?.savedAt ? await this.store.get(this.active.id) : null;
      const settings = { ...this.settings, folderHandle: handle };
      if (current) {
        const c = { ...current, id: newID() };
        this.progress("Saving… Writing to selected folder", this.workHint());
        await store.put(c);
        settings.active = c.id;
      } else delete settings.active;
      delete settings.pendingName;
      await this.browser.settings(settings);
      this.settings = settings;
      this.reload();
    }
  }
  root.SnowglobeSessionUI = SnowglobeSessionUI;
})(globalThis);
