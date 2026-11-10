# Builder operation, privacy, and recovery

The first release is [private on Tailscale](builder-private-release.md), as selected
by the owner. Builder remains a development application until that checklist passes.
Public deployment remains disabled
in the Pages workflow. See [progress](builder-progress.md) for evidence and open
release gates.

## Browser support

Current desktop Chrome/Edge are the development target. Chromium has actual guest
VM acceptance coverage. Firefox runs the browser Pi fixture; that does not prove
its full VM, database, save and recovery workflow. Linux WebKit has component
coverage, including opaque preview/backend isolation, binary IndexedDB recovery,
and checkpoint Blob fallback. Earlier emulated iPhone guest runs are recorded in
the package README; physical Safari/iPhone/Android acceptance remains unverified.
Do not treat an emulated viewport as a device test.

WebKit blocks opaque extension workers under the production isolation headers;
Builder rejects extension activation rather than granting a host-origin fallback.
Core preview and backend relay tests pass in both Chromium and WebKit. A current
browser, HTTPS and production COOP/COEP headers are required for the intended VM
configuration. Private browsing and low storage can prevent durable saves.

## Where information goes

Source files, database rows, accounts, conversation recovery, and VM checkpoints
are held in this browser's origin storage. They do not sync across devices.
Clearing site data or deleting a browser profile can remove them. Private
browsing, storage quota, OS eviction, and a different browser profile can prevent
recovery. Export important source and keep an independent backup.

AI requests send prompts, selected source, tool results, and supplied conversation
context through the gateway to the chosen provider. Pi API keys and OAuth tokens
persist encrypted in `BUILDER_CREDENTIAL_DIR` (default
`.local-dev/builder-credentials/`). Keep the directory private (0700); its master
key and encrypted files are 0600. The operator can decrypt them. Browser access
uses a one-year rolling HttpOnly, SameSite=Strict cookie scoped to `/builder-api/`
and Secure on HTTPS. Losing that cookie loses access to the saved profile; losing
the master key makes its vaults unreadable. Back up both only through private
operator backup procedures; neither belongs in source/VM exports or public assets.

The official Codex runtime manages separate protected credential files beneath
`BUILDER_CODEX_DIR`. Remembered profiles restore authorization after expiry and
normal gateway restart. Runtime cleanup stops processes and retains remembered
credentials; **Forget connection** on the ChatGPT (Codex) row signs out and removes its directory.
**Forget connection** deletes an individual Pi credential and its cached catalog.
Browser storage clearing does not delete abandoned server files; operators must
remove unused profiles privately after confirming no active sessions need them.
Revoke authorization at the provider when required. Do not expose ambient host
AWS/GCP profiles or environment secrets as browser-user credentials.

See [provider authentication and persistence](builder-providers.md) for supported
methods, cloud settings and the distinction between saved credentials and live
provider acceptance.

No remote analytics are enabled. Task stage timings are stored in sessionStorage;
they contain durations and stage labels. Browser storage also contains project
content and chat. Gateway operators must avoid logging bodies, cookies, invitation
tokens, device codes, prompts, or source. Provider retention and billing are
controlled by the provider account, not Builder.

## Save and recovery

- **Automatic source recovery** saves source and conversation after changed tasks.
  It is separate from database durability. A recovered source version can be
  newer than the database checkpoint.
- **Save VM** captures source and database machines when enabled. Wait for the
  explicit checkpoint-saved status. A failure message means persistence has not
  been established; keep the page open and export source before troubleshooting.
- **Source versions** offers a reviewed file diff before restore. It changes
  source only; accounts, rows, and migrations already applied are not undone.
- **Export source** includes source, lockfile, migrations, and local run
  instructions. It excludes database rows, Auth accounts, VM state and AI keys.
  Source recovery/export accepts bounded UTF-8 text and binary assets (256 KiB
  per file, 600 KiB total). An error must not be interpreted as a completed export.

If a build fails, the last working preview stays visible. Read the failure,
request a repair, or Retry. Stop cancels active guest work and pending approvals.
If an install fails, the previous dependency graph remains usable. A journal
recovers interrupted dependency or source restores before the next operation.

After reload, a saved preview can appear before the VM resumes. Use Rebuild
preview to resume and verify source. If storage is full, export first, remove
unneeded projects through Builder, then retry Save. Do not clear all site data as
a first troubleshooting step. Project deletion removes that project's saved
machines, recovery and versions after approval; it is permanent.

## Private gateway configuration

The gateway binds to loopback port 18447. Put a trusted HTTPS reverse proxy in
front of it, with `/builder-api/` forwarded to the gateway and bodies capped at
1 MiB. Pass the original Origin header, disable request-body logging, retain SSE
streaming, and use upstream response timeouts longer than the task deadline.
Never expose the development daemon or its socket alongside this route.

For the standalone gateway, set `BUILDER_ORIGIN` to the exact HTTPS application
origin and `BUILDER_MODE=production`. Configure `BUILDER_GATEWAY_USER_TOKENS`
through the operator's secret store as a JSON object mapping 1–100 stable user
IDs to distinct high-entropy access tokens (32–512 characters). IDs contain only
letters, digits, underscores and hyphens. Issue tokens privately to their owners;
never put them in source or command history. Startup rejects invalid or duplicate
entries without printing configuration text. The gateway keeps token hashes for
lookup and scopes each browser session to its authenticated user ID.

Users enter their token in AI settings. It is sent only on connection and cleared
after success; it is not stored in projects or browser storage. Changing browser
identity revokes the previous session. Rotate/revoke configured tokens through
the secret store and restart the gateway; restart also revokes existing sessions.
This is operator-managed individual access, without public signup or recovery.
The development daemon can still use `BUILDER_GATEWAY_ACCESS_TOKEN` for shared
invitation admission, but production requires individual user tokens. The local
dev server retains development defaults.

Defaults are 100 requests, 250,000 reported API tokens, and $2 estimated API cost
per session. A conservative next-call estimate uses transcript bytes and the
pinned model catalog's input/output prices. Missing terminal usage exhausts the
token allowance. `/usage` returns counters only for the authenticated session.
Estimates can differ from provider bills; set a provider-side spending limit too.
Codex enforces request count only: its subscription allowance and prices are not
represented as API dollars. Individually authenticated users also share the same default limits across all
sessions in a one-hour in-memory window. Reconnecting does not reset that user
window. Only one model request per user can run at a time, preventing concurrent
sessions from spending against the same reported total. Missing API usage blocks
further requests for the window. User counters reset after gateway restart;
these are not durable provider-account spending controls. Admission is also rate-limited;
behind the local proxy all users share its loopback address limit.

## Release and rollback

Builder's top switch selects the editing view, full-window app preview or Console.
Console connects to the current project's source VM (`/workspace`) or Supabase VM.
In the latter, PostgreSQL opens `psql "$DB_URL"`; `\dt` lists tables. This is
direct owner access to the local VM, including its database access, rather than
an AI tool. Manual SQL is retained in a VM checkpoint but is not automatically
added to exported migration files. Terminal output stays in the current page.
Return to Builder or Disconnect ends the interactive shell. Save VM first closes
the terminal connection, then performs the existing paired checkpoint flow.
The build cross-compiles the guest PTY helper using the repository's Go toolchain;
`BUILDER_GO_BIN` can select it. Provider credentials remain on the model gateway.

Before release, record the repository commit, clean build output hashes, Node/Pi
versions, guest image hashes, template/lockfile hashes, target browser versions,
and final acceptance logs. `node packages/builder/audit.mjs` emits the npm
inventory and SHA-256 fingerprints; a nonzero exit means provenance or license
review remains open. This does not audit the guest OS or VM image. Preserve
third-party notices and review MPL packages and bundled native dependencies
before distributing artifacts.

Release acceptance must include a fresh-user accounts/profiles app with two-user
RLS checks, failed-build repair, Stop/Retry, every enabled framework's clean-VM
edit/build/preview/save/reload/export, malicious-preview tests, storage failures,
and a nontechnical walkthrough on supported browsers. Native fixtures do not
replace live-provider or physical-device acceptance. Unsupported Next.js/SSR,
Storage/Realtime/Functions and native Pi extensions stay unavailable.

Keep the previous immutable site bundle, matching guest image and gateway
version. To roll back, stop admitting new sessions, stop the gateway (revoking
sessions), restore the matched artifact set, restart privately and run health,
preview-isolation and recovery checks before reopening access. Do not alter or
delete browser projects, checkpoints or database schemas as part of deployment
rollback. Browser checkpoints can depend on their original guest image: retain
that image or offer source export and an explicitly reviewed migration path.

## npm vulnerability scan

Run `npm run audit:vulnerabilities --prefix packages/builder` to query current npm
advisories for the exact Builder and four template lockfiles without installing
packages. It fails on high/critical advisories or incomplete service responses;
lower-severity findings remain visible in its JSON report and require review. CI
runs this scan. It does not audit the guest OS/image or dependencies users add.
License review remains separate and unresolved.

## Saved VM backup downloads

After a successful Save VM, open Download saved VM backups. Download source and,
for database apps, database backups. Their filenames must have the same Save
timestamp; keep both and a source ZIP. Builder verifies both checkpoints match
the completed Save metadata before producing either download, and checks the
loaded checkpoint again. Files use the existing checksummed `.snowglobe` format.
They are unencrypted, potentially contain service keys, Auth accounts and private
rows, and depend on the exact guest build. Store them privately. Keep the pairing manifest with both files. Choose them under Restore into a new
project and review the confirmation. Builder verifies checksums, timestamps and
exact VM configuration before writing a new isolated project. It preserves
existing projects and removes staged data if a write fails. A crash during import
can leave unlisted staged data, so retain the original files. Conversation and
browser preview storage are not restored; rebuild the imported app to verify it.
The focused Chromium real-VM backup/import run passed, including both restored
accounts and their isolated rows; see
[the acceptance record](builder-backup-acceptance.json). That result applies to
the recorded development artifact. Verify backups against the supported release
artifact and device before deleting browser data.

To fingerprint current Builder source and built assets, run
`npm run provenance --prefix packages/builder`. The JSON records repository HEAD,
dirty-worktree status, Node version and SHA-256 for source/artifact bytes. Keep
this with test logs; it does not attest that tests passed, cover the guest image,
or establish a reproducible release from an uncommitted worktree.

Individually authenticated users are limited to three gateway sessions by default
(factory option `userMaxSessions`, validated from 1 to 10). Creating another
session without its existing cookie is refused at capacity; rotation using the
existing session remains available. Disconnect unused sessions or wait for their
one-hour idle expiry. Active Codex tasks are kept until completion, cancellation
or the explicit task deadline; ordinary authenticated requests renew the idle
lease. Saved authorization is resumed on direct Codex requests when the hourly
session cookie expires. The gateway also retains its total-session and Codex-runtime
caps. These controls do not replace operator monitoring or provider-side limits.
