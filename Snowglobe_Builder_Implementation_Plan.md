# Snowglobe Builder — Detailed Implementation Plan

**Project:** Snowglobe Builder
**Repository:** https://github.com/burggraf/snowglobe
**Proposed working branch:** `feat/snowglobe-builder-pi` (created; no implementation changes committed when this plan was prepared)
**Planning baseline:** November 8, 2026
**Revision:** v1.1 — framework chooser, on-demand toolchains, AI connection matrix, Pi skills/extensions
**Status:** Architecture and implementation handoff; implementation and remaining gates are tracked in [docs/builder-progress.md](docs/builder-progress.md). The full plan is not yet complete.
**First-release scope decision (November 9):** Private on Tailscale; see [private release acceptance](docs/builder-private-release.md). Public-service work remains a later roadmap phase.
**Primary AI runtime:** Pi's embeddable `@earendil-works/pi-agent-core`, with `@earendil-works/pi-ai`
**Product goal:** Open a website, connect an AI provider, choose (or let AI choose) an application framework, describe an app, and watch it be built inside a browser-hosted Snowglobe VM with a ready-to-use Supabase development backend where needed.

---

## 1. Executive decision

**Build Snowglobe Builder inside the existing `burggraf/snowglobe` repository as a separately bundled, feature-gated application.** Do not fork Snowglobe or start an independent Builder repository yet. Isolate Builder's code in `packages/builder/` and keep the core VM integration behind a small interface, so splitting it into a new repository remains possible later.

**Use Pi's embeddable agent core in the hosting browser page** for agent state, streaming, tool invocation, cancellation, and conversation management. Do **not** require that novices install the Pi CLI, Node, a local daemon, Claude Code, Codex, Docker, Postgres, or the Supabase CLI.

**Run real project operations in Snowglobe's guest VM**, which already has a working Svelte/Supabase example. Expose its project filesystem, controlled command execution, diagnostics, database operations, and preview builds through a new guest RPC service. The agent does not run *inside* the VM; it uses tools that operate on that specific running VM instance.

**Make browser-owned `/workspace` the authoritative source of truth in Builder mode.** The existing folder-sync flow is designed for local editors, so do not bolt AI edits onto it without changing the ownership model. Local folder import/export remains optional for advanced users.

**Build the project environment around a template registry and on-demand provisioning.** The image should contain the Linux/Node/npm baseline and preinstalled supported Supabase services, while framework/application dependencies are selected by project and installed or restored from compatible caches only as needed. Start with the proven SvelteKit stack; support Svelte + Vite, React + Vite, and vanilla TypeScript + Vite as early first-release choices. Treat Next.js (static and especially SSR) as separate compatibility gates; do not promise any arbitrary npm/native tool can run in the emulated guest.

**Make Pi skills a first-class Builder feature, but be precise about Pi extension compatibility.** Import project-local Agent Skills (`SKILL.md`) and present their names/descriptions to the browser-side agent, loading instructions on demand. Pi coding-agent extensions are executable Node/Bun modules, not automatically supported by `pi-agent-core` in the browser. Provide a permissioned Builder tool-extension API and document an optional native Pi companion for full Pi extension support.

**For a public, zero-install product, include a small authenticated model gateway.** A static-only website may execute the VM, UI, and Pi loop, but cannot safely handle production API credentials or guarantee direct cross-origin access to every model provider. The gateway handles model calls and credential management; it does **not** host the development VM or hold a durable copy of the project by default.

**Do not ship as a public novice-facing service until application preview isolation is fixed.** The current Svelte preview runs on the Snowglobe page origin and is explicitly *not* an untrusted-code security boundary. Generated applications can contain JavaScript, and the Builder will eventually handle sensitive access tokens. This is a release blocker, not an optional polish item.

### The target experience

1. Open `builder.example.com` or the Snowglobe Builder demo.
2. Choose **Let AI decide** (default) or a framework (for example Svelte + Vite, React + Vite, SvelteKit; Next.js if the compatibility gate has passed). Choose **Supabase: Automatic** by default.
3. Select **Connect AI**. The simplest supported flow is a provider-approved sign-in; API-key setup is an acceptable alternative with clear instructions. Never imply that a normal ChatGPT/Claude subscription automatically includes API access.
4. Enter: **“Make a customer management application with user accounts.”**
5. See understandable progress: **Preparing your environment**, **Creating database**, **Building pages**, **Testing your app**, **Ready to preview**.
6. See a working live app alongside chat; request changes in plain English.
7. Click **Undo** to return to a recoverable version, **Save** to preserve work, **Export** to download source, and eventually **Publish** to deploy (publishing is a later milestone).

**Product principle:** The novice never sees a terminal, package-manager command, or local directory picker unless they explicitly open Advanced mode. Framework selection is optional: **Let AI choose** remains the first and easiest option.

---

## 2. Verified Snowglobe baseline and integration points

These findings were checked against the repository on November 8, 2026. Recheck line numbers and behavior before coding because upstream changes may land.

| Existing capability | Location | Current behavior | Builder implication |
|---|---|---|---|
| Browser VM and HTML shell | `internal/site/index.html.tmpl` | Starts Armless VM; conditionally loads project UI | Add a distinct `Builder` flag/UI rather than replacing the terminal for other demos |
| Site generation | `internal/site/site.go` | Embeds assets, generates page and service worker based on flags | Add Builder assets and flag with focused Go tests |
| Guest TCP JSON bridge | `internal/site/working-folder.js`, `GuestBridge` | Host page calls guest on virtual TCP; default port **8090** | Reuse the transport concept; extend protocol under a separate Builder port |
| Guest filesystem bridge | `examples/fullstack-supabase-svelte/bridge.mjs` | `reset`, `write`, `remove`, `mkdir`, `rmdir`; per-file bounds, path checks | **Does not currently provide** agent-friendly read/list/edit operations |
| Svelte/Supabase runtime bridge | `examples/fullstack-supabase-svelte/runtime.mjs` | Guest RPC on **8091** handles starter, manifests, builds, preview HTTP | Reuse build/preview functions; avoid duplicating the stack |
| Existing project interface | `internal/site/project-ui.js` | Select local folder, explicit sync into `/workspace`, build and preview | Builder must not invoke destructive local-folder sync during agent edits |
| Preview routing | `internal/site/preview-worker.js` | Service-worker requests routed to owning VM tab | Reuse concept, but redesign origin isolation before untrusted code/keys |
| Project example | `examples/fullstack-supabase-svelte/` | Native Postgres, PostgREST, Auth, Svelte 5, SvelteKit, Tailwind and shadcn-svelte; desktop-oriented 2-CPU VM | Proven bootstrap for Builder; **not** evidence that Vite-only, Next.js, SSR or all Supabase services are currently supported |
| VM snapshots / autosave | `internal/site/sessions.js` | Browser checkpoints of VM state, browser/file backup mechanisms | Integrate task-level saves, recovery, and explicit checkpoints |
| Build orchestration | `mise.toml`, `.github/workflows/pages.yml` | Demo builds, pooling, PWA assembly, tests | Add Builder bundle/build/test jobs and isolated deployment route |

### Constraints from the existing example

- **The existing working-folder sync is not bidirectional** and is intentionally *disk authoritative*. It overwrites `/workspace` on sync. Builder needs a separate **VM-authoritative mode**.
- The Svelte example uses a static SPA preview and manually triggers builds. Do not promise Vite HMR until implemented; Next.js server-rendering and route handlers require a separate guest HTTP/process/streaming compatibility project.
- The native Supabase example currently validates Postgres, PostgREST and Auth, **not** automatic parity for Storage, Realtime, Edge Functions, or every hosted Supabase service. Preinstall the supported backend in the Builder image, auto-enable as needed, and label unsupported services clearly.
- A framework template is **not** just a package name: it needs a tested initializer, dependency manager, build/check commands, routing model, preview adapter, export manifest, and compatibility tests.
- The guest image is desktop-oriented: approximately **1,280 MiB guest memory on 2 virtual CPUs**, plus browser overhead. Real builds may be slow; show truthful progress and preserve the last successful preview.
- The current guest package-manager wrapper and dependency cache have compatibility constraints. Reuse their installation path rather than blindly running host-style `npm` workflows.
- Preview JavaScript currently shares the origin with the host page. This is a serious trust boundary issue for a consumer AI builder.
- Session checkpoints are VM snapshots, **not** guaranteed continuous database durability or a transactional undo system. Backups can contain secrets and must be treated as sensitive.

### Specific Pi packages and APIs to use

The current Pi monorepo at `https://github.com/earendil-works/pi` documents:

- `@earendil-works/pi-agent-core`: `Agent`, streaming events (`message_update`, `tool_execution_*`, `agent_end`), custom `AgentTool` definitions, event subscriptions, and `streamProxy` for browser-to-backend model access.
- `@earendil-works/pi-ai`: model/provider collection, model selection, model streaming; browser builds supported, but browser OAuth login is Node-only, and the documentation explicitly warns about putting API keys in front-end code.
- `@earendil-works/pi-schema`: schema builders for strongly typed tool parameters.
- `@earendil-works/pi-coding-agent`: higher-level **Node/Bun** SDK suitable for an optional future native companion, **not** the zero-install browser implementation.

**Dependency note:** Pi is actively evolving. Pin exact tested package versions and lockfiles; do not assume a later package or API is compatible. Validate browser bundling at the start of the project.

---

## 3. Product requirements

### Must have for the first usable MVP

- Open Builder without installing development tools or selecting a local folder.
- A browser VM boots with the verified Supabase-capable Linux base already available; the initial prototype starts from the existing SvelteKit starter. Supabase use is automatic/opt-in, not mandatory for static projects.
- Before the novice-facing beta, offer **Let AI choose** plus tested SvelteKit, Svelte + Vite, React + Vite, and vanilla TypeScript + Vite template choices; install or restore framework dependencies on demand, not all frameworks in every new project.
- One AI provider can be connected securely through the approved model gateway and an API key flow.
- Project-level Agent Skills are discoverable and loadable from `SKILL.md` in the browser-owned workspace, with a simple Import skill control and review of any bundled scripts.
- A prompt produces streamed assistant text and tool progress.
- Pi can read/list/write/edit project files inside the **active** VM and build the current app.
- The UI provides **Preview**, **Stop**, **Retry**, **Save**, **Export project**, and clear error messages.
- Repeated prompts operate on the same project and conversation.
- The agent automatically attempts reasonable fixes when compilation or tests fail, with bounded retries and an explicit failure state.
- A normal crash/reload preserves the last completed checkpoint and gives a clear unsaved-work warning.
- Preview code cannot access the model gateway's credentials or the Builder's session storage.

### Important next milestone

- Database migrations, schema introspection, and validation as first-class Pi tools.
- A framework/template registry with version-pinned manifests, compatibility diagnostics, install progress, caching and multi-framework previews; Next.js static-export support behind explicit compatibility proof.
- A permissioned Builder tool-extension format and an extension manager for advanced users. Full arbitrary native Pi extensions are **not** implied by this feature.
- Reversible task versions for source files and validated database recovery checkpoints.
- Model selection; OpenAI and Anthropic API keys; budget controls and token/cost display.
- Multiple projects, per-project conversation context, project rename/duplicate.
- Visual inspection and screenshot feedback to the agent (requires a secure screenshot mechanism; avoid assuming cross-origin DOM access).
- Better rebuild speed and incremental compilation.

### Later additions (not MVP blockers)

- Subscription sign-in where a provider officially supports and approves third-party use (particularly evaluate OpenAI Sign in with ChatGPT for eligible open-source/approved clients); do not conflate sign-in identity with permission to consume plan usage. Do not use Claude subscription tokens as a third-party browser inference gateway.
- Native Pi/Claude Code/Codex companion, for advanced workflows and existing subscription credentials.
- GitHub import/export and project commit/push workflows.
- Publishing to hosted Supabase and static hosting, with explicit schema/data migration and secrets handling.
- Shared collaborative projects, hosted durable storage/sync, mobile-friendly editing.
- More template adapters after the first SvelteKit/Vite family; Next.js dynamic SSR, Remix/React Router, Nuxt, Vue, Astro and custom package.json projects depend on actual browser-guest build/preview compatibility, not merely npm install success.
- Full native Pi coding-agent extension execution, via an opt-in native or guest-resident runtime with explicit permission boundaries and provider-compliant authentication.

### Non-goals for v1

- Recreating the whole Pi coding-agent CLI inside WASM Linux for the default experience. A separately evaluated guest-resident or local companion mode may support full native extensions later.
- Running third-party local harnesses automatically from a browser without a companion.
- Automatically using arbitrary consumer AI subscription cookies or private authorization endpoints.
- Promising production-like support for server-rendered Next.js, SvelteKit SSR, arbitrary long-lived servers, binary native dependencies, Vite HMR, or any arbitrary package without end-to-end runtime proof.
- Guaranteed SQL rollback for every database mutation without a validated restore mechanism.
- Quietly publishing an application or transmitting private database contents off the machine.

---

## 4. Proposed architecture

```mermaid
flowchart TB
    U[Novice user] --> UI[Builder host page: Chat + Preview + History]
    UI --> AGENT[Pi agent-core in browser JavaScript]
    AGENT -->|Model stream| GW[Authenticated AI gateway]
    GW --> PROVIDER[OpenAI / Anthropic / other approved APIs]
    AGENT -->|Controlled tool calls| RPC[Browser-owned VM tool adapter]
    RPC -->|Armless virtual TCP / JSON RPC| GUEST[Agent bridge inside Snowglobe guest]
    GUEST --> FS[/workspace filesystem]
    GUEST --> BUILD[Template-specific compiler / controlled npm]
    GUEST --> DB[Optional project Supabase usage: Postgres + Auth + PostgREST]
    BUILD --> PREVIEW[Preview server]
    PREVIEW --> ISOLATION[Isolated preview origin + service-worker relay]
    ISOLATION --> UI
    UI --> STORAGE[Browser project metadata + VM checkpoints]
```

### A. Browser host page

Responsible for rendering chat, framework/template picker, skill manager, previews, tool progress, settings, save/export UI, task history, and the VM lifecycle. It owns the Pi instance and the active VM reference. Never put the Pi controller inside generated application code or the guest VM.

### B. Pi controller

A browser-compatible adapter around Pi's `Agent`, with a small declarative tool catalog, a project-specific system prompt describing the selected framework, files, migrations, and test/build commands, and an Agent Skills registry populated from reviewed project files. It streams reasoning **summaries and tool results**, not secret scratchpads; mark tool calls as queued/running/succeeded/failed.

Use a session/turn ID so that an old delayed result cannot modify a new project. Only one mutating agent task should own a project at a time. Run reads concurrently if safe; serialize writes, builds, migrations, saves, and destructive steps.

### C. Model gateway

A separate minimal HTTPS service (or approved managed edge backend) responsible for:

- user authentication/session exchange;
- securely holding or temporarily brokering provider credentials;
- streaming model requests and responses using the Pi-compatible proxy protocol;
- rate limits, spend limits, cancellation, request IDs, and abuse prevention;
- preventing disclosure of provider tokens to the generated app or browser VM.

**The AI provider necessarily receives prompts and selected project context/tool results** when the agent uses that provider. Do not promise that all project data stays local. The gateway should avoid storing transcripts or project files by default, with a transparent privacy policy.

Do not implement an unrestricted proxy endpoint or send a long-lived provider API key to the browser on every request. For a controlled demo, ephemeral browser-supplied keys are possible only with a documented risk model; they are **not** the recommended public implementation.

### D. Guest agent bridge

Add a **separate, private, in-guest RPC listener** (proposed port **8092**) reachable only through the owning browser VM transport. Its operations are implemented inside the emulated Linux guest, with filesystem and process boundaries checked there as well as in the browser.

Do not expose the port onto a user's physical localhost, public network, or another tab. In particular, the existing preview-service-worker HTTP path must not allow preview code to reach this privileged RPC interface.

### E. Isolated application preview

Move generated app preview to a distinct, isolated origin (for example `preview.builder.example.com`) or a rigorously sandboxed opaque origin, with an intentional authenticated messaging bridge. Retain the ability to proxy its runtime calls back to **the owning** browser VM and existing Supabase services. Preserve cross-origin isolation requirements for multi-CPU WASM execution.

Do **not** assume simply adding an iframe `sandbox` attribute is sufficient: SPA routing, Auth storage, service-worker ownership, fetch CORS, headers, iframe permissions, and owner-tab routing all need real-browser verification. A dedicated preview origin with explicit origin/nonce checks is the recommended target architecture.

### F. Persistence

- Guest `/workspace` and running database live inside the browser VM.
- Pi conversation metadata is stored separately from the VM snapshot and indexed by stable project ID + snapshot generation.
- The project's last completed checkpoint is restorable on reload.
- Never store AI API keys, OAuth refresh tokens, or gateway tokens in the VM image, `/workspace`, preview storage, exported source bundle, or unencrypted `.snowglobe` backup.
- Provide source export distinct from whole-VM backup; optional database export must warn that dumps contain user data.

---

## 5. Repository layout and build strategy

Keep all code in the current repository, but make the Builder package independent of demo-specific HTML.

```text
snowglobe/
├── cmd/snowglobe/                       # existing CLI
├── internal/
│   └── site/
│       ├── site.go                     # add Builder build/asset switch
│       ├── index.html.tmpl             # include Builder host shell when enabled
│       ├── project-ui.js               # preserve existing external-editor mode
│       ├── preview-worker.js           # revise for isolated preview routing
│       └── ...
├── examples/
│   ├── fullstack-supabase-svelte/       # baseline image/toolchain
│   └── builder/                        # dedicated Builder example/config when needed
│       ├── Dockerfile                  # share existing base instead of copying services
│       ├── start.sh
│       ├── guest-agent-rpc.mjs          # VM-bound file, shell, database tools
│       └── README.md
├── packages/
│   └── builder/
│       ├── package.json
│       ├── package-lock.json
│       ├── src/
│       │   ├── main.ts                 # app bootstrap
│       │   ├── ui/                     # chat, settings, preview, recovery
│       │   ├── agent/pi-controller.ts  # Pi integration
│       │   ├── agent/system-prompt.ts
│       │   ├── frameworks/             # framework registry/manifests and preview adapters
│       │   ├── skills/                 # SKILL.md discovery, import and on-demand read
│       │   ├── extensions/             # permissioned browser-safe Builder extensions
│       │   ├── agent/permissions.ts
│       │   ├── tools/                  # browser-side tool schemas/adapters
│       │   ├── vm/                     # owning-VM RPC client
│       │   ├── providers/              # gateway client / model selection
│       │   ├── projects/               # metadata, versions, exports
│       │   └── security/               # origin and session capabilities
│       └── test/
├── services/
│   └── builder-gateway/                # minimal deployable proxy service, if self-hosted
├── site/                                # link Builder in existing site
├── mise.toml                            # Builder build/test targets
└── .github/workflows/                  # CI, browser e2e tests
```

**Important staging choice:** Avoid copying the entire `fullstack-supabase-svelte` Dockerfile and Supabase assets if possible. Start by making a **small Builder-mode patch on the existing example** for proof of concept; then extract a shared image/base or parameterized build to serve `examples/builder` independently. Preserve the existing demo's behavior and tests. Only take a large Dockerfile duplication as a short-lived prototype with a removal ticket.

Use a distinct URL/deployment artifact such as `/builder/` rather than silently replacing `/fullstack-supabase-svelte/`. A feature flag lets the repo continue to ship older demos unchanged.

**Do not use a Git submodule.** There is no need for cross-repository version pinning until the Builder contract stabilizes.

---

## 6. Concrete browser ↔ guest tool contract

Provide a narrow, versioned JSON-RPC style contract with request IDs, structured success/error payloads, bounded outputs, timeouts, cancellation, and the active project/VM generation. Every request must be dispatched by the Builder host to its owned VM.

### Tool catalog (proposed)

| Pi tool | Guest operation | Limits / policy | MVP? |
|---|---|---|---|
| `list_files` | `fs.list` | `/workspace` only, bounded depth/results, exclude generated caches by default | Yes |
| `read_file` | `fs.read` | Regular UTF-8 text file, bounded bytes, no symlinks | Yes |
| `write_file` | `fs.write` | Atomic replacement, relative path validation, size cap, save diff | Yes |
| `edit_file` | `fs.patch` | Exact-match patch with optimistic hash/version checks | Next, strongly recommended |
| `make_directory` | `fs.mkdir` | Workspace-only, no path traversal | Yes |
| `remove_file` | `fs.remove` | Preview change, user approval on risky changes | Yes |
| `run_command` | `process.run` | Guest-only; cwd `/workspace`; timeout, output cap, process cancellation | Restricted MVP |
| `build_preview` | `preview.build` | Select template adapter; reuse package/compile lock, stream status, retain prior good build | Yes |
| `list_frameworks` | `project.templates` | Signed/versioned manifests and compatibility status | First beta |
| `initialize_framework` | `project.initialize` | Project creation only; locked template versions; no silent overwrite | First beta |
| `install_dependencies` | `project.dependencies` | Bounded npm installs, vetted registries and lifecycle controls; show progress | First beta |
| `list_skills` / `read_skill` | `agent.skills` + `fs.read` | Discover SKILL.md and lazily load scoped content; block untrusted scripts until reviewed | First beta |
| `get_diagnostics` | `project.diagnostics` | Build errors, check results, runtime logs | Yes |
| `inspect_schema` | `db.schema` | Read-only schema metadata | Next |
| `execute_sql` | `db.query` | Read-only default; explicit approval for schema/data mutations | Next |
| `create_checkpoint` | `project.checkpoint` | Host-driven VM capture; wait for confirmed completion | Next |
| `export_project` | `project.export` | Source + migration files, no provider credentials | Yes |

Do not expose generic `bash -c` with unconstrained access in the novice default until its guest-only boundary, resource limits, confirmation behavior, and output sanitization have been tested. It is still possible to make a powerful builder using restricted commands and explicit build/database tools.

### Example protocol

```json
{
  "id": "req-102",
  "protocol": "snowglobe-builder-rpc-v1",
  "projectId": "project-local-id",
  "vmGeneration": 7,
  "op": "fs.read",
  "params": { "path": "src/routes/+page.svelte" }
}
```

```json
{
  "id": "req-102",
  "ok": true,
  "result": {
    "path": "src/routes/+page.svelte",
    "text": "<h1>Hello</h1>",
    "version": "sha256:..."
  }
}
```

### Required invariants

- Paths are **relative** to `/workspace` and must not escape through `..`, absolute paths, symlinks, or races.
- Validate lengths and types *inside the guest* and in the browser-side adapter; enforce a practical maximum for messages and tool output.
- A tool response belongs to its request ID, project ID, and VM generation. Ignore late responses after a reset/project switch.
- Mutating commands are serialized with project builds/checkpoints; reads can run concurrently when safe.
- Edits preserve a before-image and produce a diff; never overwrite a file changed after it was read without an explicit conflict result.
- Use a process group (or equivalent) for spawned guest commands so cancellation terminates child processes.
- Do not expose raw database/service-role credentials in tool responses or browser project settings.
- A tool may report **success** only after the operation has completed; a build is not complete when it merely starts.

### Suggested implementation mechanism

Extend/refactor the existing `GuestBridge` and `runtime.mjs` patterns, but keep agent operations separate from the existing port 8090 folder-reset bridge and port 8091 preview bridge. Introduce tests for `fs.read`, listing, path traversal, symlinks, size limits, command timeout, concurrent writes, and broken pipes.

---

## 7. Pi agent integration design

### First-choice runtime

Use `@earendil-works/pi-agent-core`'s `Agent` in browser JS and `@earendil-works/pi-ai` providers/model metadata. Implement tools as Pi `AgentTool` objects that invoke `SnowglobeVmClient`. Keep the Pi runtime as a dependency, **not** a fork, and pin a known compatible version.

### Pi controller responsibilities

1. Create a session for the selected project and model.
2. Install a concise system prompt describing available tools, project conventions, allowed operations, and what counts as a successful build.
3. Attach `AgentTool`s (`read_file`, `write_file`, `build_preview`, etc.) with schema validation.
4. Subscribe to Pi events to render assistant text deltas, tool status, token use, errors, cancellation, and completion.
5. Serialize filesystem mutations; capture task start/end project versions.
6. Implement pause/stop and prevent tool execution after a VM reset or tab ownership loss.
7. Preserve conversation state across project reloads with a separate, versioned metadata store.
8. Include bounded retry/repair logic: diagnostics → read relevant files → fix → rebuild, with a visible stop condition.
9. Enforce authorization and approvals **outside** the system prompt; model instructions are not a security boundary.

### Agent conversation policy

Provide a good starter prompt such as:

> You are building an application using **{selectedFramework}** and the **{backendMode}** backend setting in this Snowglobe VM. The template manifest provides the current source layout, package manager, check command, build command, and preview adapter; use those instead of assuming SvelteKit paths. Make changes only through the provided tools. Use `/workspace` as the source tree. Before saying a feature is complete, run the appropriate checks and verify the preview. If a command or build fails, attempt a bounded repair. Ask permission before destructive schema/data changes, skill-script execution, credential use, or external network actions. Do not claim success without a completed tool result.

System prompts should be versioned and tested against a small benchmark suite. They should include app-specific facts retrieved from the live VM, not stale hard-coded assumptions about model package versions.

### Browser bundle check (first spike)

Create a minimal bundled page that imports Pi core, sets a fake/in-memory model stream, registers a fake `AgentTool`, and verifies:

- successful browser bundle on target browsers;
- streaming events and cancellation;
- no accidental Node built-ins in client chunks;
- model gateway streaming protocol matches the pinned Pi version;
- no provider API key appears in bundled JS or guest files;
- predictable memory consumption during longer conversations.

**Do not use `@earendil-works/pi-coding-agent` in the browser bundle.** Its documented SDK targets Node.js/Bun; it can be used later for an optional desktop/guest companion. Its `.pi/extensions` TypeScript runtime, hooks, extension UI and arbitrary npm imports are **not automatically present** in the browser `pi-agent-core` integration. The skill loader and permissioned browser tool extensions are Builder features we must explicitly implement.

---

## 8. AI provider onboarding and credentials

### Recommended onboarding flow

**Connect AI** → choose supported provider → use an officially supported sign-in path if available for this product, otherwise follow short instructions to create and paste an API key → choose recommended model automatically → send first prompt.

Initially support **one well-tested API-key provider** end to end, then add the second. Avoid a confusing screen with 20 models/providers in MVP. Put provider choice in Settings, with an understandable default and estimated spending information.

### Credential rules

- A consumer ChatGPT or Claude subscription does **not** automatically entitle a third-party application to use an API or subscription OAuth tokens. Verify provider licensing and auth eligibility before enabling sign-in.
- **Never** put a user API key in the VM, generated app, exported project, shared preview, or model context.
- Prefer a server-side encrypted credential vault scoped to user/project; offer a **session-only key** alternative that is held only for the active session if feasible.
- Gateway credentials are exchanged only over HTTPS and protected by account/session authorization, CSRF controls, origin checks, and rate limits.
- Keep credential persistence **separate** from IndexedDB VM checkpoint storage.
- Include disconnect, rotate key, delete credential, request budget, and clear confirmation of charges being billed by the provider.
- Limit gateway requests to approved model endpoints and the authenticated user's allowed models. Never implement an arbitrary-URL proxy.

### Gateway protocol and deployment

Use Pi's documented `streamProxy` protocol when implementing the relay, rather than inventing an incompatible streaming format. Validate request bodies, model IDs, authentication, size limits, and cancellation. Make the gateway independently deployable and optional for local development, but a **requirement for a polished public zero-install experience**.

For BYOK, a temporary HTTPS gateway still receives the key for a session. Be transparent about this and use a reputable secrets store with encryption at rest only if users request saved credentials.

---

## 8A. Framework and environment selection — a first-release product requirement

**Goal:** A novice chooses **Let AI choose** and starts prompting; an advanced user can choose the frontend framework and backend before creation. Every project has one explicit, versioned framework manifest. Supabase is available in the image, but a static-only project need not configure or use it.

### Supported and planned framework matrix

| Framework choice | Source in VM | How preview works | Gate / expected status |
|---|---|---|---|
| **SvelteKit SPA** (current baseline) | Existing pinned Svelte 5/SvelteKit/Tailwind/shadcn-svelte assets | Existing static build and service-worker preview | **Proven baseline for first coding slice** |
| **Svelte + Vite** | Small versioned template, npm packages installed/restored on demand | Vite production build served through a generic static preview adapter | **First novice beta**, after real-VM compatibility tests |
| **React + Vite** | Versioned React/TypeScript/Tailwind template; optional shadcn/ui after validation | Same generic static preview adapter | **First novice beta**, after compatibility tests |
| **Vanilla TypeScript + Vite** | Minimal template without framework | Generic static preview | **First novice beta**, after tests |
| **Next.js static export** | Version-pinned Next/React starter, `output: 'export'` | Static output served from guest build results; feature-limited | **Experimental** until ARM/musl compiler, memory, time and routing verified |
| **Next.js full-stack SSR / route handlers** | Next Node process in guest; separate process/HTTP adapter | Persistent guest HTTP proxy; streaming, headers, cookies, and perhaps WebSockets | **Research track**, not initial compatibility promise |
| **Other frameworks / custom project** | Import template manifest or vetted `package.json`; npm install inside guest | Explicit adapter contract; reject unsupported runtime assumptions | **Advanced only until proven** |

A framework chooser must distinguish **frontend framework** from **backend**. Backend choices: `Automatic / Supabase / None` initially; do not silently claim other backend services are installed. For Supabase-backed projects, install/provision the current validated native Postgres, PostgREST and Auth stack once in the image, keep its VM state local, and generate migrations for schema. Implement additional Supabase services only after individual tests.

### Template manifest contract (proposal)

```json
{
  "id": "svelte-vite",
  "displayName": "Svelte + Vite",
  "version": "tested-template-revision",
  "runtime": "node",
  "toolchain": { "node": "image-pinned", "packageManager": "npm" },
  "templateArchive": "content-addressed-source-bundle",
  "install": { "strategy": "npm-ci-from-lockfile", "network": "browser-fetch" },
  "scripts": { "check": "npm run check", "build": "npm run build" },
  "preview": { "kind": "static", "outputDirectory": "dist" },
  "backend": { "supabase": "optional" },
  "capabilities": ["typescript", "static-preview"]
}
```

The example above is **a proposed contract**, not implemented support. Validate all paths and commands against an explicit allowlist and version-pinned manifest; do not execute arbitrary untrusted manifest shell strings silently. The builder runs a capability probe before claiming a template is ready.

### Initialization and package flow

1. Choose **Let AI choose** or a framework; set Supabase to Automatic/On/Off.
2. Bootstrap only a minimal trusted source template in `/workspace`; set project manifest/version and starter instructions.
3. Check compatible dependency caches first; install remaining npm packages **inside the VM** only when necessary. A pinned Node/npm baseline and reusable compiler caches belong in the image, not all framework dependencies.
4. Explain progress as **Preparing Svelte / Installing packages / Building preview**, show an advanced log, and offer cancel/retry.
5. Run the template's check/build; serve last successful preview. Select the adapter by template rather than hard-coded SvelteKit paths.
6. Save the lockfile, manifest and source into the project export; include setup/deployment instructions and Supabase migrations if used.

**Important constraints:** The current npm adapter has CORS and package limitations, disables package lifecycle scripts, and is not a general-purpose Linux npm environment. Native Node add-ons, postinstall scripts, Git dependencies, nonpublic registries, non-ARM binaries, Next SWC/Turbopack binaries, resource-heavy builds, HMR sockets, dynamic SSR, and custom servers require separate tests or adapters. A failed install must not destroy the last usable project. Framework and package versions must be explicitly pinned/tested before being offered to novices. Benchmarks are needed for first and warm creation times, RAM, snapshot sizes, and offline/warm reuse.

**Acceptance tests:** A fresh browser can independently create SvelteKit SPA, Svelte + Vite, React + Vite and vanilla + Vite apps with zero terminal commands; each renders, accepts a Pi edit, rebuilds, and reloads. Next.js does not appear as generally supported until it passes its own static/export or server-runtime acceptance tests.

---

## 8B. Pi Skills and extension support — explicit capability boundaries

**Skills (first novice beta):** Support portable Agent Skills as directories containing `SKILL.md` plus optional references/assets/scripts. Provide **Add skill** (file/folder/approved catalog/import archive) and **Manage skills** controls; avoid requiring a novice to know Pi filesystem paths. The Builder host discovers the project-local skills through the guest file API, advertises only name/description to Pi, and loads the full instructions lazily via a browser-safe tool. Store project-specific content under `/workspace/.agents/skills/<name>/` (portable path), accepting legacy `.pi/skills/` imports where appropriate. Do not assume the browser `Agent` automatically scans or parses these locations. Explicitly implement metadata/frontmatter validation, collisions, version pinning, persistence and inclusion/exclusion on export.

A skill can contain helper scripts; executing those scripts uses the **guest VM's restricted command tool** and requires permissions just like any other code. Treat uploaded skill instructions as untrusted, do not allow them to override tool policy, and show requested actions before enabling privileged tools.

**Extensions (two tiers):**

- **Browser-safe Builder extensions:** First-party or explicitly approved custom tool manifests registered with the Pi browser agent; capabilities are scoped (e.g., project files, schema read, preview, approved external HTTP). Load in a separate isolated worker or equivalent reviewed boundary; never eval untrusted TypeScript in the privileged Builder host. Provide install/enable/disable/revoke UI and capability prompts. Build a small example extension to verify the API.
- **Full native Pi extensions:** Arbitrary `.pi/extensions/*.ts`, extension lifecycle hooks, terminal UI, Node/Bun built-ins and executable Pi packages depend on the full `@earendil-works/pi-coding-agent` runtime. **They cannot simply be mounted into the browser's `pi-agent-core`.** Provide a future advanced optional companion or separately reviewed guest-hosted Pi extension worker; do not promise compatibility until validated. If added, ensure the native runtime still operates on the *same* Snowglobe project via the VM tool contract, not an unsynchronized local directory.

**MCP/WebMCP:** Keep the tool protocol transport-neutral. Remote/browser-compatible MCP servers may be supported when transport/auth/CORS are workable; stdio/native MCP servers require a native or guest process, approvals and additional isolation. This is orthogonal to Skills and should not be misrepresented as extension parity.

**Acceptance tests:** A user imports a `SKILL.md` recipe skill, sees it listed and enabled, asks Pi to apply it, and the agent loads its instructions only when needed; a malicious skill cannot read provider tokens or gain host capabilities. A basic Builder extension adds a controlled custom tool with explicit user permission. Unsupported native Pi extensions return an intelligible compatibility message and never silently execute.

---

## 8C. AI subscription vs API key authentication — provider-compliant options

| Connection type | Zero-install browser Builder | Requirement / caveat |
|---|---|---|
| **OpenAI API key** | Yes, with authenticated gateway | Usage-billed API account; does not automatically consume a ChatGPT subscription |
| **Anthropic API key** | Yes, with authenticated gateway | Anthropic Console/API billing; not interchangeable with Claude Pro/Max consumer credentials |
| **Other Pi-supported API providers** | Add as tested adapters | OpenRouter and other verified API-key providers; validate model tool calling and gateway protocol separately |
| **ChatGPT subscription** | **Possible where approved/eligible**, not automatically enabled | OpenAI's Sign in with ChatGPT can authorize eligible Responses API plan usage in participating open-source/approved applications; verify app eligibility, registration, OAuth scopes, callback type and model/proxy contract before shipping |
| **Claude Pro/Max subscription** | **Not through a custom third-party web gateway** | Anthropic's current policy disallows offering Claude.ai login or proxying subscription tokens in a third-party app; use an API key or a compliant, unmodified Claude Code runtime with the user's own sign-in and required commercial terms |
| **Existing native Pi / Codex / Claude Code sign-in** | Only via optional authorized companion/runtime | Native process can expose a protocol to Builder if provider terms allow it; do not copy OAuth tokens, reuse browser cookies, or imply subscription authentication is a generic model API |

**UI requirements:** Present **Connect OpenAI API**, **Connect Anthropic API**, and eligible **Continue with ChatGPT** only after that path is verified. Mark each as **uses API billing** or **uses eligible plan access**, not merely a brand name. Include **test connection**, **change model**, **disconnect**, **revoke access**, **cost/usage estimate** and clear provider errors. Account/sign-in identity alone does not grant inference rights. Never send API keys to the guest or generated preview; use scoped, server-side credential custody and isolated origins. If supporting BYOK ephemeral sessions, disclose that the gateway receives a key, even if the server does not persist it.

**Source references:** https://developers.openai.com/siwc/quickstart ; https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt ; https://code.claude.com/docs/en/legal-and-compliance ; https://github.com/earendil-works/pi/blob/main/packages/ai/README.md ; https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md ; https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md ; https://nextjs.org/docs/app/getting-started/deploying . These are time-sensitive and must be rechecked before launch.

---

## 9. Core UX design

### Default screen (desktop)

- **Left:** application preview (largest pane), with clear loading/build/error/ready states.
- **Right:** chat history, prompt composer, suggested starter prompts, inline tool progress.
- **Top:** project name, **Framework** (with Let AI decide default), **Supabase: Auto/On/Off**, save status, model/provider indicator, Undo, Export.
- **Settings:** Manage AI connections, **Skills**, browser-safe **Extensions**, and project dependencies; hide technical details unless requested.
- **Advanced drawer (hidden):** terminal, raw tool output, filesystem explorer, SQL/schema view, performance diagnostics.

### Golden-path interaction

1. New workspace picks a validated framework template automatically or from the chooser; Supabase is available but used only if needed.
2. Framework packages are prepared on demand inside the VM with visible progress; no folder picker or local npm setup.
3. AI provider connection is tested with a small request; failures have helpful explanations.
4. User prompts: “Make me a recipe app.”
5. Pi streams human-readable progress while inspecting source, writing code, and building.
6. On successful build, preview refreshes and user sees the result.
7. On failure, Pi sees compiler errors and makes a bounded repair attempt.
8. App checkpoint is made after successful task completion; the UI shows the last completed save rather than optimistic status.
9. User can ask for a change and continue from the same project state.

### Progressive disclosure

| Beginner label | Underlying function |
|---|---|
| “Building your pages” | Pi file writes / code generation |
| “Setting up your data” | Database migrations or schema updates |
| “Checking your app” | Framework-specific checks and build diagnostics |
| “Getting your tools ready” | Selected framework template, pinned dependencies and cache warmup |
| “Add a skill” | Import/review a project-scoped SKILL.md capability |
| “Saved” | Confirmed durable browser checkpoint |
| “Go back” | Restore a tested checkpoint/version |
| “Download your project” | Export code, manifests, migrations, optional data |

Avoid showing internal process names, line-number errors, or token dumps unless a user opens Details. Keep cancellation and retry visible at all times.

### Error messages to design intentionally

- Browser does not support required WASM/SharedArrayBuffer / cross-origin-isolation setup.
- VM tab background throttling prevents a long-running build.
- Provider key invalid, quota exceeded, billing not configured, provider unavailable, or request cancelled.
- Build failed; show what the agent tried and a retry button.
- Work cannot be saved because storage is full or permissions changed.
- VM was restored from an earlier version; conversation and files may be out of sync.
- Project deleted or reset while an agent task was active.

---

## 10. Security and trust boundaries — release blockers

### Threat model

Assume generated code and dependencies are **untrusted**. Even when an AI creates them, they may contain malicious or accidental logic. The attacker may control HTML/JS in the preview, package scripts, network requests, and text seen by the model (prompt injection). User provider credentials, conversation history, other workspaces, and access to the privileged VM tools must be protected.

### Required protections

**S1. Preview-origin isolation** — Generated preview code must not share an effective origin with Builder storage or model tokens. Verify with real browser tests that a malicious app cannot read Builder IndexedDB/localStorage, intercept gateway requests, or post unauthorized `MessageChannel` messages. The current same-origin preview design is not sufficient for this purpose.

**S2. VM tool boundary** — Only the owning Builder host tab can invoke privileged agent RPC. Preview frames and service-worker preview URLs must not reach the tool endpoint. Bind every tool to a per-VM capability plus a generation counter; reject stale and cross-project requests.

**S3. Guest sandboxing** — Commands run within Snowglobe's emulated guest, not on the user's native OS. Enforce time/memory/output limits, workspace path rules, and deny access to host data. Respect the guest's browser-network constraints; do not accidentally open a host network tunnel.

**S4. Credential isolation** — Provider keys/tokens never enter the guest, source files, snapshots, backups, previews, or tool messages. Redact likely credentials in logs and errors. Never print a key after entry.

**S5. Approval policies** — The model is not trusted to self-authorize. For novice mode, read/code-edit/build operations are normal; destructive deletes, raw SQL mutations, external API integrations, and publishing require explicit permissions. An advanced “allow more” mode must be opt-in.

**S6. Prompt-injection resistance** — Treat repository content, web pages, compilation logs, and tool output as untrusted data. They cannot change tool policies or cause secrets to be sent to unapproved endpoints. Enforce this in code rather than in prompt text alone.

**S7. Checkpoint integrity** — VM capture and rollback must be coordinated with writes/builds. Clearly distinguish a completed checkpoint from an in-flight save. Never promise exact SQL rollback without a verified, consistent restore.

**S8. Supply chain** — Pin Pi dependencies, build images, selected framework template manifests, and generated starter dependencies. Check licenses. Disable or constrain untrusted npm install lifecycle scripts by default. Add vulnerability scanning and dependency-update tests.

**S9. Browser isolation and headers** — Test COOP/COEP, CSP, service worker scope, CORS, iframe restrictions, and application Auth flows together. Cross-origin isolation required for a multi-CPU VM must be preserved while separating the app preview origin.

**S10. Privacy** — Tell users that prompts, selected source files, and diagnostic context are transmitted to the chosen AI model provider. Offer clear data export/deletion and minimize logging at the gateway.

**Public launch rule:** If S1 or S2 is unverified, keep Builder behind a local/demo feature flag and do not handle real persistent user credentials.

---

## 11. Persistence, versions, and export

### Two distinct persistence layers

1. **Runtime checkpoint:** Snowglobe VM memory/files/process state, including local Postgres, captured with its existing mechanism. This captures the running environment, but has size and consistency implications.
2. **Project metadata:** title, project ID, chat history, model choice, task status, file-change journal, checkpoint pointers, export manifest; stored separately in browser IndexedDB and not accessible from preview code.

Use a stable `projectId` and `vmGeneration` in both stores. After restore, verify the restored VM state, source hash, and last recorded task before resuming the agent. If they differ, present a recovery choice rather than blindly replaying edits.

### Undo design

The first MVP can reliably support **file-change history**: before-images and after-images for each agent task, excluding generated caches. This does **not** guarantee DB undo.

To earn the label **Undo last change** for a full-stack project, coordinate file changes with a verified VM checkpoint taken before the task (and optionally after success); then test full restore of Postgres/Auth and the app preview. An operation that modifies external systems must be labeled non-reversible.

Because VM snapshots can be large, implement checkpoint frequency/configuration deliberately and test both speed and storage quota behavior. Do not trigger full VM capture for every individual file write.

### Export formats

- **Project ZIP:** source code, `package.json`, lockfile, `supabase/migrations`, README with local run/deploy instructions, and an export manifest. Exclude `node_modules`, VM blobs, and provider secrets.
- **VM backup:** existing `.snowglobe` snapshot, explicitly labeled potentially sensitive and potentially tied to the exact base VM build.
- **Optional SQL data export:** separate action, with warnings about private rows, passwords/auth content, and deployment compatibility. Schema-only migrations should be the default portable artifact.

The user should never have to understand the distinction to avoid data loss: the UI should clearly say what each option contains.

---

## 12. Implementation milestones and acceptance criteria

These milestones are **dependency ordered**, not calendar estimates. Start the next only after the exit criteria are met.

### M0 — Baseline, scope, and compatibility spike

**Deliverables**

- Work on `feat/snowglobe-builder-pi`; leave `main` stable.
- Record current tested Snowglobe commit and tested Pi package versions in `packages/builder/README.md`.
- Create a technical decision record (ADR) for same-repo, browser Pi core, model gateway, VM-owned `/workspace`, and isolated preview.
- Make Pi agent-core bundle in a real browser using a mocked model stream; test streaming, tool execution, and cancellation.
- Confirm how the current VM preview loads, how the guest RPC handles requests, and how the autosave lifecycle interacts with writes.
- Record build time, memory use, and known CI target browsers; no performance promises yet.
- Write the first framework manifest schema and define the support gate for SvelteKit, Svelte + Vite, React + Vite, vanilla + Vite, and separate Next.js static/SSR experiments.
- Prototype browser-side `SKILL.md` discovery without assuming full native Pi extensions.
- Document API-key versus provider-approved subscription authentication and the Anthropic policy restriction.

**Exit criteria**

- Pi browser proof of concept passes in Chrome/Edge, with basic Firefox/Safari capability checks.
- Existing Snowglobe tests pass unchanged.
- Team agrees on preview isolation design and credential flow.

### M1 — VM-owned project tools

**Deliverables**

- Add feature-gated Builder mode to generated Snowglobe UI.
- Add in-guest Builder RPC service and browser adapter.
- Implement `list_files`, `read_file`, `write_file`, `make_directory`, `remove_file`, restricted `run_command`, and `get_diagnostics`.
- Refactor/reuse existing build function without requiring disk folder import or its `reset` operation.
- Add request IDs, generation checks, cancellation, error normalization, caps, and a mutation lock.
- Initialize the starter project directly from guest image assets or a guest-local template; keep the initial proof on known-good SvelteKit.
- Define template-specific builder operations without permanently hard-coding Svelte paths or outputs.

**Exit criteria**

- A browser-origin tool call can edit `/workspace/src/routes/+page.svelte`, rebuild, and display the changed preview with **no local folder selection**.
- A malicious path and symlink cannot escape `/workspace`.
- Current external-editor mode still functions as before.

### M2 — Pi-powered AI chat (first end-to-end vertical slice)

**Deliverables**

- Browser Pi Agent + basic text/chat UI.
- Authenticated model gateway with **one** verified provider and streaming responses.
- Map Pi tool schemas to the VM tool adapter; wire event stream to UI progress.
- Implement Stop, Retry, and task completion states.
- Add a bounded repair cycle using build diagnostics.
- Single project/session with conversation persistence.

**Exit criteria**

- A fresh user session sends “Add a counter button,” Pi edits a real Svelte component inside the VM, the build succeeds, and the preview displays the new behavior.
- The user installs no native coding software and uses no terminal.
- Broken build produces a visible failure/retry path, never a false success.

### M3 — Secure preview + credential safety

**Deliverables**

- Distinct preview origin or equivalent thoroughly validated isolation architecture.
- Gateway key custody, authentication, session security, rate limits, redaction, disconnect/revoke.
- Explicit approval policy for destructive/privileged tools.
- Browser CSP/COOP/COEP/CORS/message-passing hardening and malicious-preview tests.
- Cross-tab / cross-project capability revocation on VM restart.

**Exit criteria**

- Malicious preview cannot access Builder tokens, provider keys, other projects, or privileged agent RPC, confirmed by automated browser tests.
- Cross-origin isolation and Supabase Auth/Data API preview remain functional.
- No provider secret appears in any `.snowglobe` backup or project export.

### M4 — Novice-quality project experience, templates, and skills

**Deliverables**

- First-run connection wizard with clear billing/permission explanation.
- Add framework/template chooser with **Let AI decide** default; implement validated Svelte + Vite, React + Vite and vanilla + Vite template manifests and generic static preview adapter; keep SvelteKit path working.
- Add on-demand dependency install/cache/progress/cancel/retry and source/export lockfile consistency.
- Implement project-local Agent Skills discovery, import, metadata display, on-demand read and trust review.
- Show Next.js as experimental only after separate static-export compatibility proof; do not promise SSR in this milestone.
- Project list, create, rename, delete, duplicate, reopen.
- Autosave state, manual Save, storage quota warnings, recovery prompts.
- File history, diff review and source rollback. Full-stack undo only after verified snapshot restore.
- Project ZIP export with migrations and a README.
- Responsive three-state UI: chat, app preview, advanced tools.

**Exit criteria**

- A user with no programming knowledge can choose Let AI decide or a verified Vite/SvelteKit framework, build/modify an app, import a safe SKILL.md, close/reopen the page, and export source without using a command line.
- Each advertised framework passes actual browser VM initialization, AI edit, build, preview and restore tests.
- Failed saves are visibly reported; no unverified “Saved” status.

### M5 — Full Supabase workflow and validation

**Deliverables**

- Read-only schema inspection, migration planning, approved SQL execution.
- Auth, RLS, REST API validation and data-aware checks.
- Migrations written as portable files and applied with a reproducible version history.
- Compile/check/test orchestration, error repair and visual status.
- Data-safe checkpoint/restore verification.

**Exit criteria**

- Prompt “Create accounts, profiles, and an editable profile screen” generates schema migrations and working app behavior, with correctly tested RLS for at least two users.
- Destructive schema changes require explicit user consent.
- Local Postgres state persists across a verified checkpoint restore.

### M6 — Release readiness and extension points

**Deliverables**

- Browser performance/regression testing; guardrails for slow builds and storage quota.
- Audit licenses, keys, logs, network policies and build provenance.
- Telemetry opt-in and privacy documentation.
- User documentation, recovery guide, and maintainers' architecture docs.
- Stable tool API contract allowing future external MCP and native Pi integrations.
- Deliver a permissioned browser-safe Builder extension registration/management path with one example extension, if its isolation and threat-model tests pass. Full third-party native Pi extensions remain a separately gated future feature.
- Record an explicit status matrix for API key providers, eligible ChatGPT plan sign-in (if available/approved), and non-supported Claude subscription login in the custom web app.
- Public release checklist and rollback plan.

**Exit criteria**

- Nontechnical acceptance walkthrough passes on supported browsers with no developer assistance.
- Security release blockers are closed.
- Existing Snowglobe demos still pass CI.

---

## 13. Prioritized issue backlog (copy into GitHub)

Use one issue per item; the suggested ordering captures dependencies. Prefer small PRs rather than one giant Builder PR.

| ID | Title | Depends on | Priority | Definition of done |
|---|---|---|---|---|
| SG-B01 | ADR: Builder architecture + threat model | — | P0 | Decision, boundaries, release blockers documented |
| SG-B02 | Pi core browser bundle + fake model test | B01 | P0 | Runs/cancels fake tool calls in browser |
| SG-B03 | Feature-gated Builder page and assets | B01 | P0 | Existing demos unchanged, own `/builder/` route |
| SG-B04 | VM-owned workspace bootstrap | B03 | P0 | Starter opens with no disk picker |
| SG-B05 | Guest RPC v1: file list/read/write/mkdir/remove | B04 | P0 | Paths, symlinks, caps, concurrency tested |
| SG-B06 | Guest command runner + diagnostics | B05 | P0 | Bounded commands, cancellation, structured errors |
| SG-B07 | Reusable build/preview API | B05 | P0 | Agent edit → build → preview without folder reset |
| SG-B08 | Secure AI gateway, auth and streaming | B02 | P0 | One provider works; credentials not leaked |
| SG-B09 | Pi adapter: tools, events, policies | B02, B05, B08 | P0 | Real streamed agent can invoke VM tools |
| SG-B10 | Chat and task-status UI | B03, B09 | P0 | Send/Stop/Retry/results understandable |
| SG-B11 | Preview-origin isolation | B07 | P0 | Malicious-preview tests pass |
| SG-B12 | Credential custody, approvals and limits | B08, B11 | P0 | No keys in VM/storage/exports; safe destructive flow |
| SG-B13 | Browser workspace metadata + recovery | B04, B09 | P1 | Reload resumes completed saved state |
| SG-B14 | Project ZIP export and manifest | B05, B13 | P1 | Portable source download, no secrets |
| SG-B15 | Task-version file diffs + rollback | B05, B13 | P1 | Controlled file rollback, clear DB caveat |
| SG-B16 | Supabase schema/migration tools | B06, B12 | P1 | Migration approval + testable RLS |
| SG-B17 | Build/test/fix loop | B07, B09 | P1 | Bounded repair with truthful final result |
| SG-B18 | Multi-project UX + model preferences | B10, B13 | P1 | Project isolation verified |
| SG-B19 | Full-stack checkpoint/restore proof | B13, B16 | P1 | Files + DB recover consistently in tests |
| SG-B20 | E2E security and novice UX suite | B10–B19 | P0 for release | End-to-end and security gates green |
| SG-B21 | Advanced MCP/WebMCP adapter | B09, B12 | P2 | Same tool contract usable by external agent |
| SG-B22 | Optional native Pi companion | B21 | P2 | Uses official native integration, no change to default path |
| SG-B23 | Hosted Supabase migration/publish | B16, B20 | P2 | Schema/data auth/migration workflow separately verified |
| SG-B24 | Framework template manifest and support matrix | B01, B04 | P1 / beta gate | Versioned starter, scripts, preview, capability contract |
| SG-B25 | Vite template adapters: Svelte, React, vanilla TS | B24, B07 | P1 / beta gate | Each clean browser VM template installs/builds/previews |
| SG-B26 | On-demand npm package provisioning and cache | B24, B06 | P1 / beta gate | Bounded installs with progress, safe rollback and lockfile export |
| SG-B27 | Framework-specific preview adapter contract | B24, B07 | P1 / beta gate | No Svelte-only assumptions in generic static preview |
| SG-B28 | Project Agent Skills import/discovery/review | B05, B09 | P1 / beta gate | SKILL.md loaded on demand; scripts do not bypass permissions |
| SG-B29 | Browser-safe Builder extension format and example | B09, B12 | P1 / public gate | Scopes, revocation, isolated execution, tests |
| SG-B30 | OpenAI plan sign-in eligibility feasibility | B08, B12 | P2 / conditional | Document approved OAuth integration and token handling; do not misrepresent account sign-in |
| SG-B31 | Next.js static build compatibility spike | B24, B26, B27 | P2 / experimental | ARM/musl Next compiler, export, memory and routing measured in real browser |
| SG-B32 | Next.js guest SSR and dynamic preview feasibility | B31 | P2 / research | Guest HTTP process/streaming/cookies/headers tested; no default user promise |
| SG-B33 | Native Pi extension compatibility architecture | B21, B29 | P2 / optional | Full Node/Bun runtime and permissions verified without duplicating VM state |
| SG-B34 | Multi-framework and skills E2E release suite | B20, B25-B28 | P0 for beta | One-prompt build and restored preview for every advertised framework |

---

## 14. Test strategy

### Unit tests

- JSON-RPC schema/type validation, request ID matching, generation rejection.
- Workspace path traversal, absolute path, backslash/control bytes, symlink and race cases.
- File size and tool-output caps; binary-file rejection or explicit handling.
- File edit conflict detection; atomic writes; rollback journal correctness.
- Process timeout/cancel/child cleanup; request cancellation between turns.
- Agent prompt lifecycle: streaming events, tool successes/failures, bounded repair, Stop.
- Template manifest validation, dependency install policy/cache correctness, framework version mismatch and preview adapter selection.
- SKILL.md frontmatter and path validation; skill prompt-injection/host-secret defenses; extension permission enforcement.
- Credential redaction, proxy request validation and provider error mapping.
- Checkpoint state machines: saving, saved, dirty, quota failure, reset.

### Integration tests

- `go test ./...` for site/CLI changes.
- Existing `node --test internal/site/*.test.cjs examples/editor/bridge.test.mjs examples/fullstack-supabase-svelte/*.test.mjs` remains green; extend for Builder runtime.
- `packages/builder` unit tests and browser bundling checks.
- Guest RPC tests run in the actual image, not only mocked filesystem APIs.
- Build a modified SvelteKit app in a real VM; preview returns updated output after mutation.
- Repeat clean-boot / cached-boot package installs, Pi-driven edits, compile, preview, export and restore for each advertised Vite framework.
- Verify Supabase Auto/On/Off behavior and backend-not-used case; assert no blanket claims about unimplemented Supabase services.
- Supabase Auth + PostgREST + RLS tests with two different test users.
- Autosave/reload and backup restore with database writes.

### Browser end-to-end tests

- Chrome/Edge desktop as primary target; assess Firefox/Safari and document unsupported cases gracefully.
- WASM multi-CPU isolation with production-like headers and HTTPS.
- Preview origin isolation, service-worker restarts, tab close, cross-tab messages and stale IDs.
- Simulate malicious app JavaScript trying to read Builder credentials or call privileged tools.
- Provider offline/quota/invalid key cases.
- Slow and aborted builds; last-good preview must remain uncorrupted.
- Storage quota exhaustion, cleared site data, old checkpoint format.
- Large projects near configured file caps and at least one realistic multi-turn app build.

### Novice acceptance scripts

**Script A — Create:** Open fresh → connect provider → “Create a recipe app with categories” → see working preview → refresh → restore.

**Script B — Change:** “Make the list searchable” → agent edits → build succeeds → live preview updates → repeat with changed requirement.

**Script C — Break and recover:** Ask for a feature that causes a build failure → agent shows diagnosis/tries bounded repair → user can Stop/Retry → last good version remains accessible.

**Script D — Export:** Download ZIP → open its `README.md` → verify source/manifests/migrations included and no keys or VM cache included.

**Script E — Permission safety:** Ask to delete all profiles → confirmation required → deny action → verify data intact.

**Script F — Security:** Attempt a malicious preview script → verify host token/private project/privileged RPC cannot be read or invoked.

---

## 15. Performance and reliability goals

These are **measurable design targets**, not verified current performance claims.

- The UI remains responsive while the VM boots, a build runs, or Pi streams model output.
- On long builds, show completed stages and actual tool status; never fabricate percentages.
- Preserve and offer the **last successful preview** even if a new build fails.
- Do not run multiple Svelte builds or npm reconciliations concurrently against one `/workspace`.
- Keep agent transcripts bounded through Pi's context/compaction facilities; warn before expensive model requests.
- Use explicit timeouts and structured retry rules; avoid indefinite retry loops.
- Capture metrics (locally by default) for VM startup, prompt-to-first-token, build, checkpoint, and restoration. Publish observed values after testing on representative machines.
- Provide a “your browser is low on memory / storage” recovery path. Do not silently discard work.

### Suggested instrumentation

| Signal | Meaning |
|---|---|
| `vm_boot_ready` | VM ready to accept requests |
| `agent_turn_started / settled` | Prompt lifecycle |
| `tool_started / completed / errored` | Per-tool task state |
| `build_started / completed / failed` | Compiler workflow |
| `preview_ready` | Last successful compiled app is available |
| `checkpoint_started / committed / failed` | Durable-save truth |
| `provider_request / cancelled / quota_error` | Provider availability and cost issues |

Telemetry from real users must be opt-in and must not contain code, prompts, keys, or database records by default.

---

## 16. Key design decisions to settle during M0

1. **Preview isolation implementation:** Dedicated subdomain with secure channel vs opaque-origin iframe. Choose with real browser tests, not theoretical assumptions; include Supabase Auth behavior and service-worker constraints.
2. **Gateway deployment:** Hosted minimal service vs user-hosted optional relay. Zero-install browser experience requires someone to operate the safe server component for credentials/model requests.
3. **Guest command permissions:** Small allowlist for novice mode vs more permissive commands behind approvals. Verify that limiting shell commands doesn't cripple build/repair.
4. **Image reuse:** Build `examples/builder` from a shared Svelte/Supabase base, or initially feature-gate the existing image. Preserve test coverage and avoid long-term duplicated Dockerfiles.
5. **Workspace persistence:** Use VM state as canonical runtime source plus a separate file-change journal, or additionally export a durable workspace archive on every successful task. Evaluate quotas, recovery, and consistency.
6. **Version semantics:** A code diff is not full-stack Undo. Decide whether to offer “Restore saved version” first and add universal Undo only when data restoration is verified.
7. **Initial provider:** Choose **one** provider and tested model with robust tool calling; defer a huge model catalog.
8. **Browser support:** Desktop Chromium likely provides the strongest initial experience; define exact support based on tests and show a clear fallback for others.
9. **Framework matrix:** Keep SvelteKit as prototype baseline; ship validated Vite families as novice choices. Treat Next static/SSR as separate adapters and feature flags.
10. **Supabase scope:** Preinstall current supported Postgres/Auth/PostgREST services; backend usage Auto/On/Off. Verify Storage/Realtime/Edge separately before exposing as supported.
11. **Pi extensibility:** Agent Skills in browser host, permissioned Builder extensions, optional native full-Pi parity; avoid presenting three mechanisms as identical.
12. **Provider sign-in:** Select an initial API-key provider; pursue OpenAI approved plan usage where eligible; do not accept Claude subscription OAuth into a third-party web gateway.

---

## 17. First coding session — exact recommended sequence

This is the fastest safe path to a genuine working vertical slice, without trying to solve publishing and multi-user collaboration first.

1. Checkout `feat/snowglobe-builder-pi`; record the main/branch commit SHA and run the existing suite.
2. Add an ADR and minimal `packages/builder` package with pinned `pi-agent-core`, `pi-ai`, and `pi-schema` dependencies.
3. Prove Pi `Agent` can run in a browser with a mocked model stream and mocked tool; show its streaming events in a basic chat panel.
4. Add `Builder` feature flag to Snowglobe site generator and render the panel next to the existing preview.
5. Add a guest bridge for `fs.list`, `fs.read`, `fs.write` and `project.diagnostics`, scoped to `/workspace`, with native guest tests.
6. Bootstrap `/workspace` automatically from the initial proven SvelteKit guest starter (no folder selection), avoiding `project-ui.js` reset/sync. Put framework manifest plumbing in place but do not block the first vertical slice on Next.js or multi-template release.
7. Reuse guest preview build functionality through a safe Builder operation.
8. Prove manually in browser that changing `src/routes/+page.svelte` from a test action updates the preview.
9. Connect Pi tools to that VM adapter. With a mock model, automatically generate and build a change.
10. Stand up an authenticated gateway in development mode and connect one real API-key provider via Pi streaming; prohibit storing the key inside VM or page origin accessible to preview.
11. Demonstrate the end-to-end prompt **“Add a counter button to the home page”**.
12. Implement the preview-origin isolation and secret/capability regression tests **before inviting novice testers with real credentials**.
13. Commit the thin vertical slice and tests; then begin the project/save/export UX milestones.

### First vertical-slice demo acceptance

> On a clean desktop browser, a user opens Builder, connects the supported model provider, asks for a counter button, sees Pi editing a file inside the actual browser VM, watches the app build, and interacts with that button in the preview. No terminal commands, no desktop agent installation, and no folder picker are involved. A failed build doesn't claim success. The user can Stop the action and can save/export source. Credential separation and privileged bridge isolation are verified before broader distribution.

---

## 18. Release checklist

- [ ] Existing Snowglobe demos and tests pass.
- [ ] Builder runs from its own deployed route and doesn't change other demos by default.
- [ ] One nontechnical user can complete fresh project → prompt → preview without development tools.
- [ ] Let AI decide / verified framework chooser works; each advertised template initializes and previews from a clean VM with dependencies installed/cached on demand.
- [ ] Supabase backend scope is honest: verified Postgres/Auth/PostgREST ready where needed; unimplemented services clearly marked.
- [ ] Project SKILL.md import and lazy loading work without exposing host credentials; unsupported native Pi extensions are not silently executed.
- [ ] Provider credentials never enter VM, project export or unencrypted backup.
- [ ] Generated app preview is isolated from Builder origin, credential storage, and privileged tool RPC.
- [ ] All privileged RPC operations bind to the owning VM/project and reject stale generations.
- [ ] Dangerous database operations ask for approval; denied operations do not execute.
- [ ] Tool errors are surfaced accurately; build success means the build actually completed.
- [ ] Interrupted builds keep a usable previous preview.
- [ ] Save/recovery works and quota failures are visible.
- [ ] Restore tested against source and Postgres state.
- [ ] Export includes source and migrations, excludes secrets/caches.
- [ ] Credential lifecycle: connect, disconnect, rotate, revoke.
- [ ] Browser support and limitations documented.
- [ ] Clear privacy disclosure about sending selected project context to the chosen model provider.
- [ ] Dependences and licenses verified and pinned.
- [ ] No claim of subscription authentication without approved provider integration; provider-specific terms (including Claude restrictions) are respected.

---

## 19. Primary source links

These URLs are included so a coding agent on the development system can inspect the authoritative current sources, rather than relying only on this handoff.

### Snowglobe

- Repository: https://github.com/burggraf/snowglobe
- README: https://github.com/burggraf/snowglobe/blob/main/README.md
- Existing Svelte/Supabase example: https://github.com/burggraf/snowglobe/tree/main/examples/fullstack-supabase-svelte
- Example guide: https://github.com/burggraf/snowglobe/blob/main/examples/fullstack-supabase-svelte/README.md
- Guest runtime: https://github.com/burggraf/snowglobe/blob/main/examples/fullstack-supabase-svelte/runtime.mjs
- Guest file bridge: https://github.com/burggraf/snowglobe/blob/main/examples/fullstack-supabase-svelte/bridge.mjs
- Browser project UI: https://github.com/burggraf/snowglobe/blob/main/internal/site/project-ui.js
- Browser guest transport: https://github.com/burggraf/snowglobe/blob/main/internal/site/working-folder.js
- Browser preview worker: https://github.com/burggraf/snowglobe/blob/main/internal/site/preview-worker.js
- VM checkpoints: https://github.com/burggraf/snowglobe/blob/main/internal/site/sessions.js
- Site template: https://github.com/burggraf/snowglobe/blob/main/internal/site/index.html.tmpl
- Site generator: https://github.com/burggraf/snowglobe/blob/main/internal/site/site.go

### Pi

- Monorepo: https://github.com/earendil-works/pi
- Embeddable core: https://github.com/earendil-works/pi/tree/main/packages/agent
- Agent API docs: https://github.com/earendil-works/pi/blob/main/packages/agent/README.md
- Model APIs / browser usage: https://github.com/earendil-works/pi/blob/main/packages/ai/README.md
- Skills format: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
- Native extensions: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md
- Node/Bun coding-agent SDK (advanced/optional): https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md

---

## 20. Handoff instructions for an AI coding agent

Copy this `.md` file to your development system and hand it to Pi (or another coding agent) with the following instruction:

> Read `Snowglobe_Builder_Implementation_Plan.md` (v1.1). Inspect the current `burggraf/snowglobe` repository and the pinned Pi documentation. Implement **M0 first**, followed by a thin vertical slice of **M1 and M2**, on `feat/snowglobe-builder-pi`. Keep the baseline SvelteKit example for the first coding slice, but design the framework manifest/preview adapter boundaries immediately; make the Vite framework chooser and portable SKILL.md support beta gates, with Next.js separately validated. Keep the existing examples working. Prioritize VM-owned `/workspace`, Pi in the browser host, a typed guest RPC, and a working preview. Do not expose real API credentials in the guest or same-origin preview. Treat preview isolation and authenticated gateway safety as public-release blockers. Run appropriate tests after each change, document decisions, and do not claim completion based only on a mock response.

**End of plan.**
