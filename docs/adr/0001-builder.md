# Builder development slice

Baseline commit: `434a3d3173be212434aaa04454fd849ac21e7a91` on `add-conduit-supabase-demo`; implementation branch: `feat/snowglobe-builder-pi`.

Builder is a separately bundled local development app at `/builder/`. It owns a VM and never synchronizes a local folder. This checkout predates/differs from the implementation plan's SvelteKit baseline: `examples/fullstack-supabase-svelte`, `working-folder.js`, and its runtime RPC are absent. The available React/Vite `web` image is the initial template. SvelteKit, other templates, database tools, extensions and public deployment remain gated.

Reuse the existing worker-backed machine orchestrator and command job transport. A versioned guest operation dispatcher is installed once per page session through a job input, then invoked with small JSON requests inside the VM. Builder uses one acknowledged upload line at a time and a two-minute shell-transfer inactivity timeout to tolerate slower devices; it validates workspace paths and symlinks in the guest. `/workspace` is initialized once from `/root/app`. No generic shell tool is exposed to Pi. The transport can later move to port 8092 without changing the operation contract.

For the static development slice, preview output is a self-contained HTML document in an opaque sandbox (`allow-scripts`, without `allow-same-origin`). Assets are inlined in the guest. CSP forbids network calls and frames. This intentionally excludes Supabase Auth, routing and external assets until a dedicated preview origin is tested. Never use the existing same-origin agent preview for Builder.

Pi core runs in the host page. A separately run local gateway uses Pi's streamProxy wire protocol with API keys held in server memory, an HttpOnly session cookie, strict Origin checks and bounded requests. The gateway is development-only and binds loopback. No subscription sign-in is advertised. Public authentication, encrypted custody, abuse controls and production origin isolation remain release blockers.

Source export is a ZIP source archive, separate from VM Save. Save suspends and checkpoints the actual VM using the existing IndexedDB mechanism. Source-only history is not database rollback. No automatic claim of completed M0–M6: see packages/builder/README.md for measured status.
