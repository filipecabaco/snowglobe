# Snowglobe Builder (local development)

Development implementation across M0–M6 of the original plan. Release acceptance remains incomplete; Builder is not a public service. Current evidence and open gates are tracked in [release evidence](../../docs/builder-release-evidence.md) and [progress](../../docs/builder-progress.md).

Operator configuration, privacy, recovery, and release rollback are documented in
[Builder operations](../../docs/builder-operations.md).

The first release targets [private Tailscale access](../../docs/builder-private-release.md);
public hosting/signup remain deferred.

## Try it

Open https://aspire.tailb03e.ts.net:18445/ and choose **Snowglobe Builder**, or open `/builder/` directly. Tailscale must be connected. **Try a counter** boots the actual browser VM, initializes `/workspace` from the installed React starter, writes a component, compiles it and shows an interactive opaque sandbox preview. No AI account is required for this test. It replaces `src/App.jsx`.

For subscription access, open **AI settings → Add a provider → OpenAI → Sign in with ChatGPT (Codex) → Continue**. Builder runs the official `codex login --device-auth` command on the dev server, then starts a fresh Codex app-server for inference. Open the returned OpenAI link on your Mac, enter the code, approve access, then select **Check connection**. Enable device-code login in your ChatGPT security settings or workspace permissions if required. No API key or local connector is needed. Choose a Codex model after connection; actual model entitlement is verified by the first turn. This mode uses the official Codex agent loop and your eligible ChatGPT plan allowance.

For Pi connections, open **AI settings → Add a provider**, choose a provider and connection method, then follow its API-key, device-code or browser/callback flow. Save several providers at once, including an API key and OAuth connection for the same provider. Choose a model from the combined searchable model selector and a supported thinking level. The selection is remembered per project; switching preserves portable conversation context and does not remove other accounts. No automatic provider or billing fallback occurs.

Pi credentials and refreshed tokens are encrypted on the gateway under `.local-dev/builder-credentials/` (override with `BUILDER_CREDENTIAL_DIR`). A private HttpOnly browser cookie reconnects to that credential profile across reloads, browser restarts and gateway restarts. The server operator can decrypt this store; it is not end-to-end encryption or an OS keychain. Do not commit or publicly serve its encryption key or vault files. **Forget connection** removes one credential. Provider-side authorization must be revoked at the provider as well.

The separate official Codex connection remains available and now remembers authorization across normal shutdown and restart. Codex owns its protected credential files beneath `.local-dev/builder-codex/`, separate for each remembered browser profile; Builder never reads or forwards those tokens to Pi, the browser, the VM or exports. **Forget connection** on the ChatGPT (Codex) row signs out and deletes that directory. Expiry/shutdown stops the runtime while preserving remembered credentials. A session created before this feature may require one fresh sign-in to opt into persistence. This never imports the developer's existing Codex login.

Codex mode requires the official `codex` executable on the dev server (tested with 0.167.0); `BUILDER_CODEX_BIN` and `BUILDER_CODEX_DIR` configure its executable and private runtime directory. No Codex installation is required on the Mac. Each process uses a restricted permission profile, an empty read-only host working directory, disabled native shell/apps/web search, denied host project/credential reads, and bounded browser-VM tools for files, checks, previews, reviewed skills/extensions, schema inspection and approved migrations. Unknown native approval requests are refused. Dynamic tools are an experimental Codex app-server API; this remains a gated development integration.

Official references: [device-code authentication](https://learn.chatgpt.com/docs/auth#login-on-headless-devices), [app-server device-code login and dynamic tools](https://learn.chatgpt.com/docs/app-server).

**Save VM** checkpoints the actual machine into browser IndexedDB and suspends it. Save first waits for the compiler to settle; the next operation resumes the VM and its resident compiler. Unsaved edits warn before leaving. Save also records conversation/preview metadata bound to that exact checkpoint timestamp and VM build. Reload restores matching metadata; Saved AI connections are restored when their browser profile and gateway credential files remain available. Metadata quota failures are reported separately from VM Save. **Export source** downloads a ZIP source archive with an export manifest and run instructions, separate from a VM backup. It omits node_modules, dist, Git and .env files; do not put secrets in ordinary source files.

## Provider integration status

The pinned Pi 1.5.0 catalog supplies 42 built-in providers and nine OAuth methods. Builder exposes their interactive sign-in/key flows and chat models, with thinking options taken from Pi metadata. TypeSafe currently has classifier models only and cannot drive the Builder coding agent. OpenRouter account-specific catalogs and Radius catalogs are refreshed and cached; GitHub Copilot availability follows Pi's account filtering. Model entitlement is ultimately checked by the provider on inference.

See [provider support and persistence](../../docs/builder-providers.md) for the complete provider matrix, cloud configuration, authentication limits and test coverage. Host environment secrets, command-based key resolvers, cloud credential files and native provider extensions are not exposed through the web UI. Bedrock uses a supplied bearer token and region; Vertex uses a supplied API key. Public signup and account recovery remain out of scope; production still requires individual operator-issued gateway tokens.

## Build and test

Node 22.19+ is required. From the repository root:

```
npm ci --prefix packages/builder
npm run build --prefix packages/builder
npm test --prefix packages/builder
# After installing Chromium, Firefox and WebKit with bench Playwright:
npm run test:browser:regressions --prefix packages/builder
# Optional: exercise the installed native app-server against local model fixtures
BUILDER_CODEX_TEST_BIN="$(command -v codex)" npm test --prefix packages/builder
```

The build bundles browser-only Pi core and copies the shared machine transport scripts into `site/builder/`. `SNOWGLOBE_BUILDER=1 mise run assemble` includes the bundle. Default site assembly and public Pages deployment omit Builder until the release gates are met. CI separately validates its bundle and unit tests. To integrate the ignored local server, run `node packages/builder/integrate-dev.mjs` once and restart it.

No guest image rebuild is needed for this slice: use the existing built `web` and `supabase` runtime catalog at `dist/agent/runtimes.json`.

The current local server integrates the gateway on loopback 18447 and forwards `/builder-api/*` from 18446; its starting page includes the Builder card. The local server files live under the checkout's ignored `.local-dev/` directory. For a different dev server, use `createGateway` from `gateway.mjs` and proxy `/builder-api/` with that prefix removed. Preserve Origin/Cookie headers and abort the upstream request when the downstream closes. Configure `BUILDER_ORIGIN` (or `createGateway({origin})`) to exactly match the HTTPS page origin. Never expose port 18447 to the public Internet.

## Implemented and gated

- Pinned Pi 1.5.0 browser bundle, streaming text, sequential typed tools, Stop/Retry, bounded tool/build attempts.
- VM-owned workspace with typed request IDs/project/generation envelopes over the existing guest job transport. The helper uploads once per page session; subsequent operations send only their request. Builder uses a single acknowledged upload line and a longer inactivity timeout for slower or briefly throttled browsers. Guest path/symlink/size checks, UTF-8 validation, atomic writes, optimistic file version checks and source export. No generic shell tool. SQL migrations use a limited application database role in the optional Supabase VM. Guest outbound fetch is disabled in Builder’s copy of the worker core (the shared demo code remains unchanged).
- Resident guest React/Vite compiler with revision-matched watch builds, pinned experimental Rolldown incremental mode, configuration invalidation, syntax-error recovery, and cancellation of its private guest process group. Successful preview retained on failure. Static preview in an opaque sandbox, CSP prohibits network, Builder storage and parent access denied by browser origin isolation. Generated apps receive a separate bounded project-local storage shim; its data is saved with checkpoint metadata.
- In-memory development gateway, strict Origin validation (including rejecting opaque/null origins), HttpOnly/SameSite session cookie, canonical server-selected provider/model, request/output/time limits and disconnect.
- Existing demos retain their interfaces. Shared runtime file downloads now retry transient failures; the existing runtime regression suite passes.

Implemented development capabilities include pinned multi-framework provisioning/cache,
reviewed dependency installation, estimated API session budgets, binary source
export/recovery, task after-images, model preferences, reviewed/pinned skill
bundles, isolated read-only extensions, and paired VM backup import into a new
project. These implementations have different levels of acceptance evidence;
see the progress ledger rather than assuming every feature has a final live run.

Still gated: public individual identity/abuse protection and deployment, final
multi-framework/live-provider acceptance, downloaded VM backup restore execution,
physical-device and novice walkthroughs, license/notices and guest-image audit,
and isolation from hostile privileged guest processes. Storage/Realtime/Functions,
hosted backend provisioning, Next.js/SSR, native Pi extensions and external MCP
remain unavailable or separately gated roadmap work. Source/database Save is
sequential and does not promise universal transactional rollback. The guest uses
job-file transport rather than the proposed TCP service, as documented in ADRs.

Source export/recovery preserves UTF-8 text and binary files (256 KiB per file, 600 KiB total). The ZIP includes per-file SHA-256 hashes and setup/deployment instructions. Conventional credential stores and caches are excluded; arbitrary secrets pasted into ordinary source are not detected.

Preview adapters bundle JavaScript/CSS and embed bounded built media assets as data URLs, including stylesheet-relative references. Arbitrary external fonts/downloads and network calls are blocked by preview CSP. The Supabase relay described below is the only backend network interface. Chromium desktop is the initial test target.

Design decisions: [initial slice](../../docs/adr/0001-builder.md), [compiler and Codex](../../docs/adr/0002-resident-compiler-codex.md), [local Supabase](../../docs/adr/0003-builder-supabase.md). Provider streaming reference: https://developers.openai.com/api/docs/guides/streaming-responses .

## Validation on this checkout

Baseline Go suite: passed. Existing Node regression suite: 168 passed. Builder unit/protocol tests: 37 passed with the opt-in native runtime test enabled. Browser bundle: passed; no Node built-ins required. Dependency audit: zero reported vulnerabilities at installation.

Real Chromium acceptance passed: actual guest source edit, React compilation, counter click from 0 to 1, parent/storage/network isolation checks, source ZIP download containing the edited component, browser VM Save, and source recovery after reload. The startup/upload path also passed with 4× CPU throttling, and a unit regression verifies delayed acknowledgements beyond the former 10-second limit. A cold counter flow took roughly two minutes on this development host; this is an observation, not a performance guarantee. The browser script also exercises checkpoint reload/source recovery and can be run with `node packages/builder/test/browser.mjs` after installing the existing `bench` Playwright tooling.


## Build feedback and current performance

The preview pane shows completed stages, an elapsed timer, when the VM last responded, and an expandable compiler log. Compiler stages and heartbeats come from the guest process; the animation alone is not used as evidence of VM activity. There is no invented completion percentage. Timings are recorded locally in sessionStorage under `snowglobe-builder-last-timing` and included in Build details, without code, prompts or credentials.

Preview builds invoke the pinned Vite Node API directly, avoiding an extra npm/CLI startup and gzip-size reporting. They still perform a real production compilation with minification. The page reuses an initialized workspace for later actions and resumes its VM as needed. A private guest Unix-socket service retains the Vite process and watch graph between builds. Source changes increment a revision marker watched through a small virtual module, so even unreferenced-file edits settle correctly. Configuration changes restart the watcher. Unchanged file writes do not force a revision. Stop kills the private compiler process group; a later build starts it again.

An instrumented cold counter run on the development host completed in about 98 seconds. Device speed, cold filesystem reads and browser throttling affect that result; it is not an across-device speed guarantee or a controlled before/after benchmark. The resident compiler removes repeated compiler startup from later edits. Further optimization candidates are image/file warming, reducing per-operation guest process startup, and deeper transform caching; the current bundler can still rerun plugin transforms during watch builds.


Current validation also covers a real warm demo-title edit in the browser VM, reuse of the compiler after a VM Save/reload, native syntax-error recovery and configuration invalidation, and termination of a deliberately blocked compiler. Codex tests cover device-code UI with mocked approval, browser-session isolation, stale tool-result refusal, native approval denial, and absence of API billing fallback. The installed Codex binary was exercised for startup, permission configuration and dynamic tool registration without using an existing account. Live subscription authorization and inference passed with a user-approved isolated test session on 2026-11-08; see the live acceptance result below.


## Preview validation and failure reporting

Compilation alone no longer marks a task Ready. A candidate opaque preview installs its error/storage bridge before application scripts, waits for a rendered document, and only then replaces the last working frame. Startup errors, rejected promises, blocked resources and empty/timeout previews surface in the task status and chat. Completed Codex messages are forwarded even when no streaming deltas arrive; empty turns and provider failures cannot silently trigger a successful starter rebuild. If no source files changed, Builder reports that fact.

The project-local localStorage/sessionStorage shim supports common static app patterns without granting access to Builder storage. Only bounded string records belonging to that preview are bridged; error/ready/storage messages require the owning iframe and per-frame nonce. App data is held in this page and included in Save metadata, with an unsaved-data warning. This shim alone is local prototype state. With Supabase enabled it also retains the app’s real local Auth session; account records and database rows live in the separate Supabase VM.

The preview compiler protocol is versioned. Saved VMs running the older compiler automatically stop it and start the current version, so cached builds cannot bypass newer preview configuration. Browser regressions: `node packages/builder/test/preview-browser.mjs` and `node packages/builder/test/codex-browser.mjs`. The latter uses a mocked Codex SSE response with real guest read/write/build operations and an interactive storage-backed voting component; it does not claim live subscription inference.


Rebuild preview compiles the files already in the VM; it does not send another AI request. To generate an app, submit the prompt with **Build my app**, or choose **Retry** to resend the last prompt from this page session. Builds of the untouched installed source are labeled **Starter preview only**. An AI turn with no file changes fails visibly and preserves the prior preview. The progress panel counts completed project reads, actual file changes and rendered previews; Build details and chat list file paths and failures without including file contents or credentials.

The opt-in `codex-native.test.mjs` test launches the actual installed Codex app-server with an isolated temporary home and a local Responses fixture. It verifies that dynamic list/read/write/build calls reach the browser adapter, tool results return to the model, and completed assistant messages arrive even without text deltas. It uses no account or external inference and does not establish subscription model access. The browser Codex regression additionally verifies the activity record and a visible no-change failure that retains the interactive existing app.


## Guest bootstrap download recovery

A failed lazy image download can make BusyBox unavailable while the existing serial shell still responds. Its first upload command then reports `step 0, status 126` (`mkdir: I/O error`); simply retrying the job can leave the VM in the same failed state. Image and warm-pack downloads now retry transient failures twice, with a 15-second bound per image-file attempt (60 seconds for the larger warm pack); permanent HTTP errors such as 404 fail immediately.

Builder recognizes structured failures at upload step zero with status 126/127, restores missing immutable image files in the running VM, and retries that bootstrap once. This happens before the helper or a requested project edit has executed. It does not reset the VM, replace the project, or replay a running edit. Recovery holds the VM awake, and Stop prevents another upload after recovery. If downloads remain unavailable, the UI reports the connection failure and keeps the project. Upload diagnostics include the shell error without echoing uploaded source.

Run `node packages/builder/test/recovery-browser.mjs` against the dev server for actual network-fault acceptance. It blocks BusyBox and the warm pack, verifies automatic recovery and an interactive counter, then injects download failures after checkpoint reload and checks that previously edited source renders and exports unchanged. No ChatGPT session is required for these VM tests.


## Live subscription acceptance page

Use [the development live-test page](https://aspire.tailb03e.ts.net:18445/builder-test/) to approve a test when ready. It requests an official device code only after **Get a fresh sign-in code** is clicked, reports sign-in/build/interaction progress, clears ended codes and supports explicit replacement and Cancel. Approval starts the configured fixed acceptance prompt in a separate browser workspace. The default voting controller verifies a vote and its persistence across a real preview rebuild; the profiles controller checks real Auth, row isolation, checkpoint/reload and denied SQL. Both confirm gateway sign-out before reporting success. The voting controller retains a failed browser for debugging; the profiles controller retains private diagnostics and disconnects during cleanup. No account credentials, cookies, account details or browser-control endpoint are served by the test page.

These optional development controllers are not part of the Builder browser bundle or public Pages deployment. After the package build, run `node packages/builder/dev/profile-test.mjs` for profiles or `node packages/builder/dev/live-test.mjs` for voting, one at a time. Both listen on loopback 18448; the current host mounts `/builder-test` through its existing tailnet-only HTTPS dev server. This does not restart Builder's gateway. For browser automation during a failed voting test, its owner-only `.local-dev/builder-live-control.json` references only that isolated test browser and is removed when it closes. The profiles controller exposes only whitelisted status and device-code fields, and blocks another run if disconnect cannot be confirmed. No arbitrary client prompt or browser command is accepted by the utility's HTTP API. Origin validation protects code creation and cancellation.

`node packages/builder/test/live-test-browser.mjs` exercises real code creation, renewal and cancellation without approving an account or running inference. `node packages/builder/test/codex-login-browser.mjs` checks that successful connection closes the settings overlay and keeps the composer accessible. Live subscription generation still requires the user's approval on the test page; code-generation tests alone do not establish it.


Both Builder and the live-test page provide **Copy code**, with a direct clipboard write inside the tap/click gesture, a selected read-only-field fallback, and visible success/failure feedback. The test page updates its input only when the code changes, preserving iPhone text selection across status polls. Its generated `dev/live-test.html` is built from `dev/live-test.template.html` and the same clipboard helper used in Builder. Run the package build after editing either source.

`BUILDER_WEBKIT_BIN=/path/to/pw_run.sh node packages/builder/test/clipboard-browser.mjs` checks Chromium and WebKit with iPhone touch emulation. It verifies real native clipboard writes, denied-API fallback, manual selection, and selection surviving polling, using fixture codes without creating or cancelling actual login sessions. Omit `BUILDER_WEBKIT_BIN` when the Playwright-matched WebKit binary is installed.

Subscription sign-in now uses the standard Codex CLI device-auth command. The CLI and app-server share only their isolated Codex-owned credential directory; Builder never reads or copies its tokens. Upon CLI success, a fresh app-server loads its own managed credentials. Pending/failed login state is reported without an in-flight account RPC. Forgetting the ChatGPT (Codex) connection cancels pending CLI login before stopping the app-server and deleting its private directory. Tests cover code parsing, cancellation, restart/account metadata, real code issuance and cleanup. This standard CLI sign-in path successfully authorized the user-approved test session and completed live model generation on 2026-11-08.


## Completed live acceptance

On 2026-11-08, the user approved a fresh CLI-issued device code through the live-test page. The official Codex app-server then used `gpt-6.1-sol` with ChatGPT plan authentication to inspect the actual browser VM project, edit `src/App.jsx` and `src/styles.css`, and build the voting app. Browser assertions verified the requested heading and Yes/No controls, clicked Yes to reach “Yes votes: 1”, rebuilt the actual preview, and confirmed that the vote survived. The service reported `passed` and confirmed gateway disconnection before removing the private test browser control file. This was live subscription inference, not a mocked model response or API-key fallback.

The live-test page can be closed after approval: its isolated test browser runs on the dev server. Ordinary Builder workspaces run their VM on the visitor's device, so the Builder tab should remain visible during builds.


## Mobile preview startup

WebKit can suspend animation-frame callbacks in transparent or offscreen iframes. The original readiness bridge waited for two such callbacks before checking the app's DOM, while the candidate frame stayed transparent until ready. Scrolling to the chat on an iPhone could therefore cause a false preview timeout even after the app rendered. Readiness now checks after DOMContentLoaded and polls independently of painting. A boot notification distinguishes a frame that did not start from an app that started but did not render. Sandbox, CSP and source-window/token validation remain enforced.

Preview regressions now run in Chromium and WebKit with iPhone touch emulation, including actual bundled React in an offscreen opaque iframe, deliberately suppressed animation frames, delayed rendering, storage/parent isolation, empty/error rejection and last-good-preview retention. Set `BUILDER_WEBKIT_BIN` when using a locally installed WebKit binary that differs from the bench Playwright default. These checks cover the preview pipeline; the complete live subscription/VM acceptance above ran in server-side Chromium.

A failed build of the current source revision is no longer automatically repeated after the AI turn ends. If its retry allowance is exhausted, the original build/startup error is retained instead of being replaced by a generic retry-limit message. To load this client update while keeping source, choose Save VM, refresh Builder, then Rebuild preview.


## Local Supabase backend

Choose **Backend → Supabase** to prepare it explicitly, or leave **Automatic** and ask the AI for Supabase, accounts or database records. Both Pi and Codex can enable the backend and apply timestamped SQL migrations. Builder supplies `src/supabase.js`; generated apps import its `supabase` client. This runs real Supabase Auth, PostgreSQL and PostgREST in a second browser VM. Email/password signup and login are supported; this development configuration needs no confirmation email and does not deliver mail. It is browser-local development, not a hosted backend or cross-device service.

The generated preview stays opaque with `allow-scripts` only and CSP `connect-src 'none'`. A nonce/source-checked fetch relay accepts only the fixed project's Auth/Data routes, bounded methods/headers/payloads, public application schema and public/user credentials. It does not expose generic HTTP, VM commands, SQL or Builder's model gateway to the frame. Administrative stack keys and database passwords remain inside the Supabase VM. Migration SQL connects as a limited application role with public-schema creation and `auth.users(id)` reference permission; it cannot read guest files or modify Auth tables. Generated migrations must enable RLS and grant the intended application privileges.

**Save VM** drains backend requests, checkpoints the source VM and Supabase VM, then saves matching metadata and preview session state. Reload rejects mismatched backend checkpoints. Saving is sequential, not an atomic multi-VM transaction; keep the tab open and retry if either checkpoint fails. Source export contains migrations and setup instructions, but no database rows, Auth accounts or administrative credentials. Exported apps can use their own Supabase project through `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`.

On 2026-11-08, `node packages/builder/test/supabase-browser.mjs` passed against the actual two browser VMs: migration application/idempotence, refusal of a guest-file read after `RESET ROLE`, two real account signups, a saved dice roll, cross-user read/insert denial, password login restoring history, and paired Save/reload preserving the Auth session and database row. No backend or VM responses were mocked. This ran in Chromium; physical iPhone two-VM performance is not established. The separate `backend-preview-browser.mjs` passed relay/cancellation and parent/storage/gateway/network isolation in Chromium and WebKit with iPhone touch emulation. The native Codex protocol fixture exercises both new dynamic tools without external inference; a live subscription turn using Supabase has not been claimed.

## Save recovery on mobile

Save VM now commits a small source/preview/conversation recovery record to a separate IndexedDB database **before** capturing either VM. The complete paired-checkpoint metadata also lives there, so localStorage quota exhaustion cannot erase restoration metadata. A failed or interrupted capture leaves a newer recovery record; reload restores its preview and Rebuild/Export/Save restores its source into the VM. Recovery explicitly warns that database contents may be from the last completed database checkpoint. It cannot reconstruct edits lost before this recovery mechanism was installed. Builder's capture deadline is 120 seconds rather than the shared transport's 15-second default; source recovery also protects against a browser process termination that no timeout can prevent.

The managed Supabase client dispatches auth callbacks after the SDK releases its session lock. An async auth listener can then query the database without deadlocking login. Rebuild preview upgrades the managed module in existing saved projects, while preserving custom modules that do not carry its marker.


The native Auth service's default 10-second request deadline can expire during password hashing in WebKit/ARM emulation. Builder upgrades its running guest Auth service to a 120-second deadline, preserving its database, keys and hashing settings. A private guest HTTP relay on port 54322 routes bounded Auth requests to that service and Data API requests to the existing stack. This keeps Builder independent of the native CLI gateway's removal of an Auth route when the original owned process exits. All private Auth configuration remains in the guest; previews still use only the fixed virtual origin. Reference: [Supabase Auth request configuration](https://github.com/supabase/auth/blob/master/internal/conf/configuration.go).

WebKit also reproduced a real VM Save failure: IndexedDB rejected the worker-created compressed snapshot with `UnknownError: Error preparing Blob/File data to be stored in object store`, leaving the old checkpoint on disk. BrowserStore now retries this specific Blob failure using ArrayBuffers in an atomic transaction, and converts them back to Blobs when loading. It does not retry quota/permission errors or clear the old checkpoint. Runtime save errors are retained for the UI instead of being discarded.

`BUILDER_WEBKIT_BIN=/path/to/pw_run.sh node packages/builder/test/checkpoint-browser.mjs` passed in Chromium and WebKit with an 80 MiB worker-compressed snapshot, the exact injected Blob preparation error, decompression/hash verification after storage, and retention of the existing checkpoint after a quota failure. Actual WebKit VM Save/reload also preserved the dice app's account and roll history after applying the binary-storage fix. These are Linux browser-engine checks with iPhone emulation, not physical iPhone hardware validation.


Final acceptance after these fixes passed real signup/password login, per-user dice history and isolation, paired VM Save/reload with a localStorage quota error, and recovery of a newer source edit after an injected source-capture failure in both Chromium and iPhone-emulated WebKit. WebKit was debugged and retried in its retained test browser after the native Auth timeout and real Blob-storage failures were observed; the original failing harness deadline is retained in its log rather than represented as a clean initial run. The final WebKit assertions returned passed. The latest shared Node regression suite passed all 168 tests, and Builder passed 37 unit/protocol tests with the native Codex fixture enabled. No live ChatGPT inference was needed for these platform tests.


## Plan continuation: approvals, project tools and extensibility

The [implementation progress log](../../docs/builder-progress.md) tracks completed
work and remaining release gates against the original plan. SQL now requires
review and explicit consent. Inspect schema reads public columns and RLS policies.
Source history restores files through a version-checked rollback journal; it does
not undo database rows or accounts. Project selection isolates VM checkpoints,
conversation, recovery and source versions. Changes save a small recovery record
automatically; use Save VM to preserve the database too.

Import skill accepts SKILL.md or a ZIP with SKILL.md at its root, up to 40 reviewed
text files and 256 KiB total. Skills are scoped instructions, not executable
permissions. Builder extensions accept version 1 JSON with id, name, description,
scopes and source (an async function receiving input and api). The only scopes
are files:list and files:read; the API exposes listFiles() and readFile(path).
Use the project-summary example in Builder to inspect the contract. Extensions
run in a dedicated worker in an opaque frame and lose permissions on reload.
They cannot run arbitrary native Pi extension modules. Extension execution is
currently validated on desktop Chromium; WebKit refuses activation because its
COEP implementation blocks the opaque-origin worker. No host-thread fallback is
used.

Regression commands (existing bench Playwright tools required):

```sh
node packages/builder/test/workspace-browser.mjs
node packages/builder/test/supabase-browser.mjs
node packages/builder/test/extensions-browser.mjs
```

These tests use fresh browser contexts and fixture data. They do not require
live model inference. React/Vite, vanilla TypeScript/Vite, Svelte/Vite and
SvelteKit SPA now have passing development guest runs. Public deployment stays disabled.

The extension and persistence suites also run in CI against an intercepted HTTPS
fixture with production-like COOP/COEP headers. They need no tailnet, development
server, VM image, model credentials or external inference. `BUILDER_URL` can
explicitly select a real deployed development page instead. Run these fixture
suites with `npm run test:browser:extensions` and
`npm run test:browser:persistence` from this package. Set `BUILDER_BROWSER=webkit`
to check WebKit; a blocked opaque extension worker must fail closed with no
active extension. Browser-engine fixtures do not establish physical-device
performance or full browser VM compatibility.

The shared suite passed 184 Node regressions; Builder native tests and fast browser
regressions are recorded in the progress ledger. The updated gateway/tool catalog
is loaded on the development server. The complete plan remains active; final
owner/device, security, license and artifact release gates remain.

### November 9 subscription revalidation

A fresh user-approved Codex device login with `gpt-6.1-sol` passed live source
editing, real React/Vite guest compilation, voting interaction and state retention
after rebuild. A deliberately broken build retained the last working preview;
a second live model turn repaired the source and rebuilt with vote state intact.
The gateway confirmed disconnect. No API key was used. See the
[non-secret acceptance record](../../docs/builder-live-subscription-acceptance.json)
for scope and artifact fingerprint. This is local voting-app acceptance, not a
live Supabase profile-app or public release sign-off.

### Live accounts and profiles acceptance

On November 9, the user-approved `gpt-6.1-sol` run generated and built the actual
Supabase profiles app and applied its reviewed schema/RLS migration. Two real
Auth accounts saved distinct profiles; direct REST checks denied cross-user
reads/writes. Paired Save/reload preserved the signed-in profile, a denied
DROP migration left its table intact, and cleanup confirmed provider disconnect.
No repair turn or API key was needed. See
[the live acceptance record](../../docs/builder-live-profile-acceptance.json),
which is separate from [the deterministic real-VM fixture record](../../docs/builder-profile-fixture-acceptance.json).
These are automated desktop Chromium development results; final artifact and
owner/device qualification remain open.

### External VM backup round-trip acceptance

The focused real source/database VM test passed actual backup downloads and
reviewed import into a separate project, followed by rebuild, both saved account
logins, and their correct isolated row histories. Temporary sensitive downloads
were removed. See [the acceptance record](../../docs/builder-backup-acceptance.json).
Repeat without the longer interrupted-capture scenario with
`BUILDER_BACKUP_ONLY=1 node packages/builder/test/supabase-browser.mjs`.

The opt-in live profiles harness is
`BUILDER_LIVE_SUBSCRIPTION=1 npm run test:browser:live-profiles --prefix packages/builder`.
It issues a fresh official device code immediately, then prepares the source/database
VMs after approval and before sending the live model request.
Its fixed test scope permits only synthetic profiles table/RLS/CRUD migration
approval. It then verifies model-generated Auth/profile behavior, two-user REST
isolation, checkpoint/reload and denied destructive SQL, and disconnects in cleanup.
It retains source and redacted UI diagnostics privately under `.local-dev/` before
cleanup, and allows one bounded live repair of a failed profile save. It is excluded
from CI and requires explicit human subscription approval. Use
`BUILDER_PROFILE_FIXTURE=1 node packages/builder/test/live-profile-browser.mjs`
to validate the database assertions with deterministic source and no AI credentials.

### Client-side preview forms

Preview forms support JavaScript submit handlers, including asynchronous Supabase
saves. Handlers should prevent native submission. The opaque sandbox continues
to deny host access and popups, and CSP blocks native form network/navigation.
Chromium/WebKit regression coverage is in `test/preview-forms-browser.mjs` and the
standard browser regression runner. Reload Builder after saving your work to
load this preview fix into an already-open page.

Browser dependency notices are generated from installed package files or exact
name/version/license matches in `notices/sources.json`. The three Pi 1.5.0 npm
packages omit their repository-root MIT text; the vendored snapshot is
checksummed and links to the matching upstream commit. A changed version or
license declaration keeps the missing-notice review visible. This completes
browser notice text, not the separate guest inventory/license approval.

## Builder, Preview and Console views

The top mode switch offers Builder, a full-window Preview and Console. The preview
bar's Full preview button opens the same view as the top Preview button; Exit full
preview or Builder returns to editing. Switching views preserves the existing
preview iframe and its state. The floating mode switch stays available in full
preview. Escape also returns when focus is in Builder's controls.

Console opens an independent interactive shell inside the selected project's VM.
Choose a machine and Connect console: Source VM runs Linux commands in `/workspace`,
or Database VM opens the actual
Supabase instance backing the app. PostgreSQL opens `psql "$DB_URL"` in that VM;
use `\dt` to list tables and `SELECT * FROM public.recipes LIMIT 50;` to inspect a
recipe table. The shell supports terminal resizing, Ctrl+C, interactive programs
and normal Linux commands. This is the owner's VM access: commands and SQL change
it directly. It does not add shell access to AI tools or generated previews.

Opening the source console prepares the project's framework; opening the database
console enables the normal optional backend when allowed by project settings.
Console connection is available after an active Builder task finishes. Leaving Console, disconnecting,
or starting a Builder action closes its interactive session; a psql prompt does
not capture subsequent Builder jobs. Save VM closes the session before capturing
source/database checkpoints. Console input marks its VM as changed; use Save VM
to preserve manual changes. Manual SQL is not automatically added to exported
migration files. Terminal output stays in the current page and is not
automatically added to the AI conversation or source export.

The package build needs the repository's Go toolchain as well as Node. It
cross-compiles a small Linux/arm64 PTY bridge, includes its project/Go license
texts, and fingerprints both the bridge source and generated asset. Set
`BUILDER_GO_BIN` if Go is not on PATH. The helper is uploaded once per VM generation
over an authenticated, checksummed TCP transfer. The owner page keeps the VM awake
while connected. Guest networking retains the existing npm-registry policy.
Preview Auth/Data relay permissions remain unchanged; neither
console port is available to the app iframe. Native Go tests exercise PTY input,
resize, interrupt and authentication; the fast Chromium/WebKit view test checks
layout, iframe retention and console controls. The optional
`node packages/builder/test/console-vm-browser.mjs` exercises real source/database
VM consoles and psql without any model credentials.
