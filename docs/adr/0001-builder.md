# Builder development slice

Baseline commit: `434a3d3173be212434aaa04454fd849ac21e7a91` on `add-conduit-supabase-demo`; implementation branch: `feat/snowglobe-builder-pi`.

Builder is a separately bundled local development app at `/builder/`. It owns a VM and never synchronizes a local folder. This checkout predates/differs from the implementation plan's SvelteKit baseline: `examples/fullstack-supabase-svelte`, `working-folder.js`, and its runtime RPC are absent. The available React/Vite `web` image is the initial template. SvelteKit, other templates, database tools, extensions and public deployment remain gated.

Reuse the existing worker-backed machine orchestrator and command job transport. A versioned guest operation dispatcher is installed once per page session through a job input, then invoked with small JSON requests inside the VM. Builder uses one acknowledged upload line at a time and a two-minute shell-transfer inactivity timeout to tolerate slower devices; it validates workspace paths and symlinks in the guest. `/workspace` is initialized once from `/root/app`. No generic shell tool is exposed to Pi. The transport can later move to port 8092 without changing the operation contract.

For the static development slice, preview output is a self-contained HTML document in an opaque sandbox (`allow-scripts`, without `allow-same-origin`). Assets are inlined in the guest. CSP forbids network calls and frames. This intentionally excludes Supabase Auth, routing and external assets until a dedicated preview origin is tested. Never use the existing same-origin agent preview for Builder.

Pi core runs in the host page. A separately run local gateway uses Pi's streamProxy wire protocol with API keys held in server memory, an HttpOnly session cookie, strict Origin checks and bounded requests. The gateway is development-only and binds loopback. No subscription sign-in is advertised. Public authentication, encrypted custody, abuse controls and production origin isolation remain release blockers.

Source export is a ZIP source archive, separate from VM Save. Save suspends and checkpoints the actual VM using the existing IndexedDB mechanism. Source-only history is not database rollback. No automatic claim of completed M0–M6: see packages/builder/README.md for measured status.

## November 9: client-side form handlers

The preview sandbox now includes `allow-forms` alongside `allow-scripts`, without
`allow-same-origin`, popup or top-navigation permissions. The HTML submission
algorithm checks the sandboxed-forms flag before firing the submit event, so the
previous setting prevented React/DOM form handlers from running at all:
[HTML form submission algorithm](https://html.spec.whatwg.org/multipage/form-control-infrastructure.html#form-submission-algorithm).
The preview retains CSP `form-action 'none'`. Chromium and WebKit regressions
verify that client-side submit handlers can use the explicit backend bridge,
while native form network/navigation, popup creation and parent/storage access
remain denied. This does not close the broader adversarial release matrix.

## November 9: multiple provider connections

The initial memory-only OpenAI connection is superseded in the Builder UI by
Pi's built-in provider/auth catalog. Each remembered browser profile can keep
independent API-key and OAuth credentials for several providers, and both methods
for one provider. Pi's native auth interactions provide the setup flow; its model
metadata supplies supported thinking levels. Provider/model selection travels
with each request and is remembered per project. Account-specific catalogs are
cached; switching preserves portable chat context and never silently substitutes
another provider after a failure.

Pi credentials are serialized into a private AES-GCM gateway vault and accessed
through an HttpOnly profile cookie. The operator retains access to the encryption
key. Official Codex retains its own protected credential files and now preserves
remembered authorization on shutdown. Explicit Forget removes the corresponding
saved credential. Host credential chains, key commands, credential file paths and
native extensions are unavailable to browser users. See
[provider support](../builder-providers.md) for the matrix, boundaries and tests.
This does not close the remaining public-release and live-provider acceptance gates.
