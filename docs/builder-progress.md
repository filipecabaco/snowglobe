# Builder implementation progress

Updated November 9, 2026. This tracks the original
[implementation plan](../Snowglobe_Builder_Implementation_Plan.md). The complete
plan is **not finished**. Builder remains excluded from public deployment.

## Current implementation

- The host uses a VM-owned React/Vite workspace, Pi/API-key or official Codex
  subscription inference, streamed tool progress, bounded builds, Stop/Retry,
  opaque previews, and browser-local Supabase Auth/PostgreSQL/PostgREST.
- Every migration now presents its exact SQL for user approval. Denial happens
  before enabling a backend, changing source, or executing SQL. Stop revokes a
  pending approval. Applied/saved migration files cannot be silently rewritten;
  schema changes need a new migration. Read-only inspection exposes columns,
  RLS settings and policies without application records.
- Tools support exact-match versioned edits, mkdir, reviewed versioned file
  deletion, persisted diagnostics and bounded check/test commands. They do not
  expose a shell. Test execution excludes skill bundles. Timeout kills the guest
  process group and reports failure.
- Source versions are retained before AI tasks/imports and reviewed before
  restore. Restores validate the complete source generation and use a durable
  guest journal. An interrupted restore is rolled back before the next operation.
  Source restoration cannot change existing migration history or roll back data.
- Source/conversation/preview recovery is written automatically after changed
  tasks. Manual Save captures the source and database VMs. A newer source recovery
  record can be restored over an older checkpoint; data may be from the last
  completed database checkpoint. Quota errors remain visible.
- Local projects support create, rename, source duplication, delete and reopen.
  VM scopes, recovery, history, preview state and conversation metadata use the
  project identifier. Codex keeps separate in-memory conversations per project.
  Source duplication does not copy database accounts/rows.
- Agent Skills accept reviewed SKILL.md or bounded text-only ZIP imports. Names
  and descriptions are supplied as untrusted context; instructions are loaded
  only on demand. Bundled scripts do not execute automatically. Native Pi
  extensions are not supported by this mechanism.
- Reviewed Builder extensions use read-only scoped requests through an opaque
  frame and a dedicated worker. Revocation/Stop destroys the worker. The example
  summarizes file types. Extensions have no DOM, host credentials, shell or
  network capability. At most eight extensions are enabled, with bounded input,
  output, requests and execution time. Grants expire when the page closes.

The live development gateway was restarted after confirming no active Builder
Codex runtime or gateway connection. Its new tool catalog and per-project Codex
changes are loaded; the Builder route and gateway status endpoint passed health
checks afterward. Browser bundles are rebuilt separately.

## Milestone accounting

| Plan milestone | Status | Remaining evidence/work |
| --- | --- | --- |
| M0 compatibility | Development workflows verified | Four framework guest runs and live Codex subscription generation passed; final supported-device/artifact matrix remains; optional Pi/API live qualification remains open |
| M1 project tools | Implemented with transport adaptation | Job-file transport replaces the proposed TCP listener; race-hardening against concurrently hostile guest processes remains gated |
| M2 agent loop | Codex subscription loop verified | Live voting-app repair and profile generation passed; supported-desktop Stop/Retry and novice walkthrough remain; optional API providers are not live qualified |
| M3 trust boundaries | Partial | Public authentication/custody/abuse controls, full production deployment/security acceptance |
| M4 project UX | Partial | Framework chooser and pinned provisioning implemented; React binary-asset browser recovery passed; SvelteKit guest acceptance passed; final release matrix remains pending |
| M5 database workflow | Live development acceptance passed | Live generated profiles, two accounts, direct row isolation, paired reload and denied SQL passed; broader migration planning/check coverage and final device acceptance remain |
| M6 release | Partial | Gateway budgets, privacy/recovery/rollback and tool-contract docs implemented; license review, live-provider/device/novice and full public-security acceptance remain open |

## Validation in this implementation pass

- Native tests cover migration approval/denial/Stop; exact/stale/ambiguous edits;
  serialized writes and deletion; command failure/timeout; dangerous skill
  archives; reviewed skill import/discovery; version conflicts; migration-history
  protection; interrupted-restore journal recovery; project identifiers and
  conversation isolation; extension permission validation.
- Chromium `workspace-browser.mjs` passed real guest edits, interactive builds,
  source diff/denied restore/approved restore, denied/approved skill import and
  lazy loading, and independent project scopes/reopen.
- Chromium `supabase-browser.mjs` passed schema/RLS inspection, approved migration
  idempotence, denied destructive SQL, restricted-role file-read denial, two real
  accounts and row isolation, password login, paired Save/reload under simulated
  localStorage quota failure, and recovery after an injected capture failure.
- Builder unit/protocol tests passed all 50 tests including the native Codex fixture.
- Chromium `extensions-browser.mjs` passed isolated worker execution, scope and
  host/network denial, review denial, revocation and infinite-loop cancellation.
  WebKit refuses activation cleanly because COEP blocks its opaque-origin blob
  worker; it does not execute a less isolated fallback.
- Earlier browser acceptance and its precise limits remain recorded in
  [the package README](../packages/builder/README.md). Browser tests use separate
  contexts and fixture data; they do not reuse a developer's credentials.

These results are incremental evidence, not completion of the release checklist.
Rerun acceptance against the final bundle after changes to recovery or tools.
Physical iPhone behavior, approved live provider access for another user, and
public deployment are not established by native or browser-engine fixtures.

## Current remaining work

1. Complete the final supported-desktop Stop/Retry and nontechnical walkthrough
   using the retained worksheet. Four framework development runs and live Codex
   voting/repair and accounts/profiles acceptance have terminal passing results.
2. Record an approved immutable artifact, matching guest images and rollback
   reference; retain independent source and sensitive VM backups. The focused
   real backup-download/new-project-import test passed.
3. Finish applicable guest filesystem concurrency/security, guest image/OS
   provenance and license review. Missing browser Pi notices have been recovered
   from pinned upstream source; that does not approve the full guest inventory.
4. Public hosting/signup/abuse qualification, Next.js/SSR and broader device/API
   provider support remain separate scope. The first release is private on Tailscale.

The implementation remains private. No public deployment or PR publication has
been performed.

## Continuation revalidation

The current bundle builds. The baseline Builder unit run passed 55 tests with one
opt-in native Codex fixture skipped. A new Backend None regression also passed:
setup, SQL migration and preview requests are rejected before guest execution or
approval prompts. Prior temporary framework browser logs are unavailable in this
runtime; do not treat their remembered results as current release evidence.
Fresh real-guest acceptance is still required before closing the framework gates.

Gateway admission now limits credential/session connection attempts per remote
address, before parsing credentials or creating a session. It ignores untrusted
forwarded address headers, bounds its address table, expires inactive windows,
and returns HTTP 429 with Retry-After. Seven targeted gateway/Codex/rate-limit
tests passed. This is an abuse-control increment, not production authentication.
The dev endpoint returned 502 and its former systemd unit was absent during this
continuation; its existing start script is being used to restore the service.

The restored Builder endpoint returned HTTP 200. Fresh SvelteKit and Supabase
browser acceptance processes were started with logs at
`/tmp/builder-kit-acceptance.log` and `/tmp/builder-supabase-acceptance.log`.
Do not restart them solely because a polling call times out; inspect their live
handles or processes first. Dependency install batch validation is now shared by
the host and guest, rejecting empty or over-ten-package batches before review.
All seven framework/provisioning unit tests passed after that change.

Gateway request parsing now bounds raw bytes and preserves UTF-8 characters split
across network chunks, rather than decoding each chunk independently. Invalid
encoding and non-object JSON are rejected. Header/body timeouts and header counts
are bounded. Nine targeted parser/gateway/admission/Codex tests passed. The two
fresh browser acceptance handles remained live when polled in this continuation;
no replacement test processes were started.

The UI now displays the gateway's session usage after connected tasks: API token
counts and catalog cost estimates are labeled as estimates, while Codex displays
request counts and explicitly leaves plan allowance accounting to Codex. Invalid
or unavailable metering is reported without inventing a cost. Three targeted
usage/budget tests passed; the bundle was rebuilt. Guest acceptance continues on
its original live handles rather than being restarted.

Interrupted provider streams now expose `accountingComplete: false` when usage is
missing. The session remains blocked and the UI reports incomplete accounting
instead of showing a misleading zero-cost estimate. Request/token limit settings
also reject fractional counts. Four targeted budget/auth/usage tests passed and
the bundle rebuilt. Both original guest acceptance handles were still live at
this continuation's poll.

Production gateway origins now reject credentials, paths and trailing slashes,
so the configured Origin comparison cannot silently accept an unusable URL.
Direct CLI subprocess tests verify that unknown modes and missing explicit
production origins exit before listening. Five targeted startup/budget/auth
tests passed. The existing SvelteKit and Supabase browser handles remained live;
their logs show package installation and database operations respectively.

Current consolidated unit run: 67 passed, one opt-in native Codex test skipped,
zero failures. The npm provenance inventory inspected 468 lockfile entries and
reported 61 license-review entries: one Unlicense entry and 60 MPL-2.0 entries
across repeated framework/platform scopes. Registry origin/integrity checks had
no reported issues. `docs/builder-license-review.json` records the deduplicated
packages and exact input fingerprints. The audit remains failing pending review;
no license was silently added to the allowlist. This does not audit guest OS or
VM-image licensing. Both original guest browser handles remained live.

A new real Chromium readiness regression passed under the isolated HTTPS fixture:
a startup wrapper containing only a script cannot replace the last working app.
Rejected candidate blob URLs are revoked, the previous successful URL stays live,
and replacement revokes that previous URL. This fixture is included in CI as
`test:browser:readiness`. Guest acceptance remains on its original live handles.

The Postgres client now rejects oversized output explicitly rather than silently
returning truncated success, and has a bounded client execution timeout. Ten
focused database/backend tests passed, including overflow followed by a nominal
zero exit, timeout termination and intact normal JSON. These are client-process
bounds, not a claim that arbitrary SQL is transactionally reversible. The live
Supabase acceptance already in progress uses its captured earlier helper; it is
not evidence for the new timeout/overflow implementation.

Fresh baseline regression checks passed: `go test ./...` and all 184 shared Node
regressions. A new provenance regression verifies actual input SHA-256 values,
issue-to-inventory references, and nonzero audit exit whenever review issues
remain. Its passing result verifies the audit mechanism, not license approval.
The original SvelteKit run reached compilation; Supabase passed real signup,
insertion and two-user row isolation and continues its recovery assertions.

Recovery and source-history stores now validate project IDs at their own entry
points. Invalid identifiers such as `latest` cannot alias the default recovery
record. Native tests verify rejection before IndexedDB access; the actual browser
persistence fixture also passed after the change. The bundle rebuilt successfully.
Both ongoing guest acceptance handles remained live at this turn's poll.

Approval callbacks now bind to a unique per-prompt ticket. A delayed callback
from a dismissed review cannot settle or disable a newer review, even when the
caller reuses the same request object. New stale-callback and Stop/retry tests
passed along with backend policy tests (10 total); the bundle rebuilt. The live
Supabase acceptance has now passed paired VM reload with Auth/data history and
simulated localStorage quota exhaustion. Remaining guest assertions still run.

## Gateway, portability and release continuation

- Added optional invitation-token admission for both API-key and Codex connection
  routes, exact-origin validation, non-development HTTPS/token startup checks,
  session request/token/estimated-dollar limits and an authenticated usage view.
  API usage is estimated from the pinned catalog; Codex is request-count only.
  Reconnecting resets these per-session limits, so they are not account budgets.
  The settings UI clears credential fields and shows the appropriate usage units.
- Added `snowglobe-source-v2` binary envelopes while retaining v1 text recovery.
  ZIP export decodes the original bytes. History/version hashing, stale checks,
  journal rollback and duplication retain binary assets. Native tests include PNG
  bytes and UTF-8 BOM preservation. A fresh React browser VM passed binary ZIP export, Save/reload, asset byte
  preservation and rebuild. Vanilla and Svelte also passed their complete guest
  provisioning/edit/build/export/checkpoint/reload tests. Vanilla additionally
  passed failed-install preservation and actual execution of an approved package.
- Added [operation/privacy/recovery and rollback guidance](builder-operations.md)
  and the [development tool contract](builder-tool-contract.md).
- The deterministic npm inventory covers 468 lockfile entries. Registry integrity
  includes bundled dependencies through their parent tarball. The retained
  [license review record](builder-license-review.json) has 61 review entries
  (Unlicense and MPL-2.0), not a completed legal or guest-image audit. [Built artifact hashes](builder-build-provenance.json)
  record this development build and its dirty working-tree baseline.
- Pi's real browser bundle passed fixture-model streaming, tool execution and
  cancellation in Chromium, Firefox and WebKit. CI now installs all three engines
  and runs this proof. This does not establish live-provider compatibility.
- Preview isolation/interaction passed Chromium and WebKit, including mobile
  viewport and suppressed animation frames. Extension and IndexedDB persistence
  checks passed Chromium; WebKit safely refuses the isolated worker and passes
  persistence. The native Codex protocol fixture and complete Go suite pass.
- Linux single-time proportional-memory samples of browser descendant processes
  during these concurrent runs were approximately 938 MiB (SvelteKit), 782 MiB
  (vanilla), 916 MiB (Svelte), and 1,670 MiB (source plus Supabase). These are not
  peaks, controlled benchmarks, browser guarantees or physical-device evidence.

The final Builder unit run passed 75 tests with one opt-in native Codex test
skipped; that native fixture passed separately. Shared site regressions passed
169 tests, and the additional Conduit/benchmark regressions passed 15 tests
(184 shared regressions total). Supabase passed its complete real-VM browser run,
including two-user RLS, password login, paired checkpoint/reload under localStorage
quota failure, and latest-source/account/data recovery after an injected capture failure.

Current run logs are under `/tmp/builder-*-browser.log`, with final unit and shared
regression logs at `/tmp/builder-final-unit.log` and `/tmp/builder-shared.log`.
These temporary paths are continuation aids, not durable release artifacts.

### Current binary persistence verification

The current full unit suite passes 75 tests, with one optional native integration
fixture skipped (76 total). The real Chromium IndexedDB fixture also verifies
binary asset bytes survive both checkpoint and source-history round trips,
including preservation of the previous binary checkpoint after an injected quota
failure. This establishes browser storage serialization, not full guest asset
preview/save/reload acceptance. SvelteKit and paired database guest acceptance
runs remain active and are not counted as passed.
The same binary persistence fixture passes in installed WebKit 2359 when launched
with its explicit executable path; the test dependency's default WebKit 2215 is
not installed in this workspace.

### Server-independent backend preview release regression

The backend preview fixture now uses an intercepted HTTPS document with the
production COOP/COEP headers instead of depending on the private Tailscale server.
It passes in Chromium and installed WebKit 2359: allowed JSON backend responses,
AbortSignal cancellation, parent/storage isolation, and denied gateway/network
access. The Pages validation job now runs this two-engine regression. Its backend
responses are deterministic fixtures, not real Postgres/Auth acceptance.

### Browser support and novice acceptance preparation

The app and operations guide now expose browser/storage recovery limits without
claiming physical-device support from emulation. The bundle builds successfully.
`docs/builder-novice-acceptance.md` provides an unexecuted, artifact-specific
participant worksheet for all six plan scripts plus paired database recovery and
privacy comprehension. The novice gate remains open until actual participation.

### Paired database acceptance and bounded Pi conversation

The current Chromium Supabase guest harness completed with exit code zero. It
passed real signup/login, row-level user isolation, immutable/idempotent limited
role migrations, denied destructive migration, paired checkpoint reload with
localStorage quota exhausted, and recovery of latest source/account/rows after
an injected source-capture failure. This run captured the helper at startup and
does not prove later helper changes or live model-driven profile generation.

Pi now condenses oversized conversation history between tasks (96,000 serialized
UTF-8 bytes or 120 messages), preserving its policy and tool declarations and
retaining bounded user/assistant history. The UI reports condensation. The
transformContext hook rejects active context above 512,000 bytes without cutting
a tool-call/result pair. Codex runtime conversation management remains separate.
The initial new test accidentally replaced the Pi system baseline; it was fixed
to preserve the real initial system message before testing compaction.

### Portable export instructions and integrity inventory

Source ZIP creation now lives in a tested module. It preserves project README.md,
rejects collisions with its two reserved metadata names, includes binary bytes,
and lists each original source path/byte count/SHA-256 in the manifest. The
export README explains Node/npm setup, static output/deployment, Kit hash routing,
Supabase migration review/environment/Auth redirect/RLS setup and data omissions.
These instructions are not a claim of a verified external hosted deployment.

### Built binary media in isolated preview

Both preview adapters now embed bounded built media URLs as data URLs rather
than expecting a project HTTP origin inside the opaque blob frame. The media
helper rejects symlinks and oversized media/output; CSP permits only data/blob
media, retaining the network prohibition. A real one-pixel PNG renders with
naturalWidth 1 in Chromium and WebKit without project HTTP requests. This fixture
is now in CI. Unit suite: 78 passed, one optional native fixture skipped. This is
not yet full guest Save/reload acceptance of all possible asset reference forms.

### Stylesheet-relative preview assets

Built stylesheets now resolve local url() references against each stylesheet's
output path before concatenation, including normalized parent paths and SVG
fragments. This applies to Vite and Kit output. A new regression initially caught
a missed parent-path form; after normalization the full suite passes (78 passed,
one optional fixture skipped), the bundle builds, and Chromium/WebKit media
render checks pass. External URL references remain subject to preview CSP.

### Explicit provider transport failure and disconnect regression

The gateway now emits a sanitized terminal SSE error if the provider iterator
throws, distinguishing stopped/timed-out requests from provider unavailability.
It does not forward arbitrary upstream exception text. Missing usage still
exhausts the session allowance rather than inventing zero cost. New HTTP tests
verify transport-failure wire content, secret omission, incomplete accounting,
and disconnect aborting a live provider iterator and revoking the session.
Full Builder suite: 80 passed, one optional native fixture skipped. The running
gateway has not been restarted while guest acceptance remains active.

The current SvelteKit guest run has now passed clean initialization/build,
Pi-tool source edit, real rebuild/counter interaction and hash-route navigation
and return. Export/checkpoint/reload assertions are still pending; the template
compatibility gate remains unchanged until the full run finishes.

### Current npm advisory scan

Added a scanner for Builder and all four exact template lockfiles, with bounded
subprocess time/output, no installation/lifecycle execution, explicit npm registry
and a high/critical/incomplete-response CI gate. Current registry evidence:
Builder/React/vanilla have zero findings; Svelte has two low-severity affected
packages and Kit has four, from transitive deepmerge GHSA-gcqx-w48m-w2h4. No high
or critical findings were reported. The full dated report and lock fingerprints
are in `docs/builder-vulnerability-review.json`. Low findings remain for review;
this does not close license or guest image/OS provenance gates. Running guest
acceptance still uses its captured pinned graph; no pins were silently changed.

### Conventional credential-file exclusions

A shared path policy now blocks conventional credential stores (.npmrc, .netrc,
.git-credentials, .ssh, .aws, .azure, .gcloud and related config) from guest tools,
source export/recovery, framework scaffolds and skill import. The host ZIP maker
also rejects excluded paths independently, including traversal, absolute paths
and node_modules. Regression tests prove guest export omits actual credential
canary files and host archive creation refuses excluded entries. Full suite:
80 passed, one optional native skip; final focused export/guest checks: five
passed; bundle builds. This does not scan arbitrary source text for secrets.

### Source task after-images and recovery outcomes

Changed tasks now persist a bounded source after-image alongside task state
(completed/failed/stopped), completion time and duration. Existing before-images
remain available, and the history store retains its 20-entry cap. Automatic
recovery records include the same lastTask metadata; reload surfaces failed or
stopped task outcomes without replaying edits. Failure to save task history is
reported separately from source recovery having committed. Chromium and WebKit
IndexedDB fixtures verify stopped-task metadata survives with binary after-image
bytes. The bundle builds; no database undo claim is introduced.

### Dependency restore acceptance assertion failure

The vanilla guest run terminated on its forward-restore cache-key assertion.
Backward restore and rebuild had passed, and the forward source restore returned
success. Inspection shows graph keys include installation input lockfile/update
mode, so an npm update from a prior graph and npm ci from its completed lockfile
can legitimately have different cache directory keys for the same pinned graph.
The harness now compares actual restored package/lock contents and executes the
restored dependency after rebuilding, rather than assuming those cache keys are
identical. Forward execution/export/save/reload remain unproven until rerun.

### Reviewed mismatched source recovery

Source recovery now requires a host-reviewed diff when saved source and the VM
source differ. Denial or absent approval mutates neither source copy; existing
version checks reject changes during review. Recovery files remain available for
retry, and database migrations retain their separate exact SQL approval. Tests
cover denial/missing approval and migration ordering; suite: 81 passed, one
optional skip; bundle builds. The database browser harness now expects both
source-recovery review and the separate migration review in its failure scenario.
A fresh vanilla guest run is testing corrected dependency restore acceptance.

### Source read hard-link and final-component race checks

Guest text reads and recovery snapshots open with O_NOFOLLOW and reject nlink
other than one. Regression tests create a hard link to a separate private temp
file and verify both read and export reject it. A deterministic test swaps the
file for a symlink after path validation but before open; the operation fails
with ELOOP instead of returning target bytes. Full suite before the final race
fixture: 81 passed/one optional skip; focused guest suite including the new race:
five passed; bundle builds. Parent-directory replacement races and privileged
guest build execution remain open security gates; this is not complete hostile
concurrent-process filesystem isolation.

### Pinned parent descriptors for source reads

Source text reads and export/recovery snapshots now open each directory segment
with O_DIRECTORY|O_NOFOLLOW and traverse through /proc/self/fd descriptors while
the handles remain open. This prevents a parent-directory rename/symlink swap
from redirecting a read outside the pinned source tree. A deterministic real-fs
race regression swaps src for a symlink to a separate private directory just
before the final open; only the original source is returned. The final-component
symlink and hard-link regressions also pass (six focused guest tests). This
Linux guest mechanism requires mounted procfs and intentionally fails closed
without it. Mutation/build concurrency and hostile privileged guest processes
remain unresolved; this change does not establish complete sandbox acceptance.

The SvelteKit guest framework harness has now completed with exit zero, including
source/lockfile/binary export and saved VM reload/rebuild after the earlier
clean-build/edit/counter/navigation assertions. It captured its app/helpers at
startup, before the latest media, recovery-review and filesystem changes. The
current full native suite passes 83 tests with one optional native fixture skip,
and the current browser bundle builds. Final-artifact clean-VM verification is
still required before changing advertised template availability.

### Saved VM backup download slice

Added explicit source/database VM backup downloads using the existing checksummed
.snowglobe format. They require a completed Save and matched build/timestamp
metadata for both machines, reject missing/mismatched checkpoints, and verify
loaded checkpoint metadata again. Each download is an independent user action
with a sensitive-data review and matching filename Save timestamp. Round-trip
codec tests verify exact source/database bytes and reject mismatched pairs. Full
suite: 84 passed, one optional skip; focused post-load validation passed; bundle
builds. Builder backup import and full external backup restore remain missing,
clearly disclosed in the UI and operations guide. Current guest runs captured
the app before these backup controls, so do not prove them in real VMs.

### VM backup pairing manifest and restore validation

Added a separately downloadable pairing manifest with only project settings,
checkpoint builds/timestamps and public backend configuration. Conversation and
host fields are omitted. A restore validator decodes/checksums both files,
checks exact source/database pairing and VM configuration, rejects missing or
oversized inputs and invalid backend configuration. Tests round-trip matching
pairs and reject mixed/missing/incompatible files. Full suite: 85 passed, one
optional skip; focused final validation tests passed; bundle builds. Validation
is preparation for import; new-project installation/UI and real VM backup import
acceptance remain unfinished. Both current guest harnesses remain live.

### Focused current-helper VM acceptance

The current rebuilt bundle's guest helpers passed a fresh real Linux VM test of
pinned-parent descriptor reads, optimistic file writes, complete source export,
binary source restore and journal completion (`test/guest-files-browser.mjs`).
Its terminal result is in `/tmp/builder-current-guest-browser.log`. This closes
the procfs/runtime smoke question; it does not replace the newest-artifact full
SvelteKit/dependency-restore acceptance runs now active at
`/tmp/builder-kit-final-acceptance.log` and
`/tmp/builder-vanilla-restore-acceptance-v2.log`. The earlier SvelteKit run passed
its complete edit/build/routing/export/checkpoint/reload sequence with exit zero.
The current native suite passed 83 tests with one optional native fixture skip;
the native Codex protocol fixture passed separately. Gateway reload remains
pending while these guest acceptance runs use the development server.

Live-provider acceptance is awaiting the user's connection choice. Fixture-model
results do not establish that acceptance. Human/device, public-security and
license/image-provenance review gates remain open in the release evidence ledger.

### Delayed workspace completion notification

The background runner reported exit 0 for the earlier
`node packages/builder/test/workspace-browser.mjs` invocation targeting
`/tmp/snowglobe-plan-delta-workspace-browser.log`. That temporary log is absent
from the current runtime, so its individual assertions and captured artifact
cannot be independently rechecked here. Record the reported successful exit;
do not use it to close newer final-artifact or release acceptance gates.

### New-project VM backup import implemented

The UI now imports the pairing manifest and source/database .snowglobe files,
validates their checksums and exact VM configuration/timestamps, reviews trust
and data scope, and installs into newly generated project scopes. It publishes
the project only after all checkpoint and metadata writes succeed; denial writes
nothing, write failures clean staged records, and existing projects are retained.
A crash can leave unlisted staged data, as disclosed in operations docs.
Chromium and WebKit real IndexedDB tests verify exact restored source/database
bytes, denial, and cleanup after injected quota failure during the second VM
write. CI runs this regression. Full native suite: 85 passed/one optional skip;
bundle builds. A new real Supabase guest run now includes downloading the paired
backups and importing/rebuilding into a new project, followed by real logins and
per-user row verification. Its terminal result is pending.

### Backup Stop cleanup and per-project model choice

The real Chromium/WebKit import storage fixture now cancels after the first VM
checkpoint write. It verifies AbortError, no staged checkpoint/project residue,
and zero held Web Locks, alongside denial/quota checks. Both engines pass.

Per-project model preferences now persist the provider mode and bounded model ID
only. API settings restore the selected ID without credentials or reconnecting;
Codex selects a saved model only if the current authenticated catalog offers it.
Changing the Codex selection saves the preference. Storage failure reports that
the connection remains usable for this tab. This does not establish fresh live
provider acceptance or persist any provider secret.

### Reviewed project skill removal

Skill manager now offers removal of a reviewed skill bundle, including its
references. Builder captures a source version first, lists the exact files for
approval, then removes them in one version-checked journaled source restore.
Denial writes nothing; a concurrent edit causes a conflict without deletion.
Native guest tests verify denial, exact reviewed bundle, concurrent edit refusal,
complete removal and preservation of unrelated app source. UI explicitly states
that removing files cannot recall instructions previously sent to the model.

### Persisted reviewed skill bundle versions

Imported skill bundles now pin each file's SHA-256 in host project metadata.
Lazy loading compares the whole current bundle with those pins. New legacy or
changed bundles require full host review; denial sends no skill instructions,
and changes during review are rejected. Unchanged reviewed bundles load without
another prompt after reopening. Metadata discovery still contains no full skill
instructions. Import pin-storage failures roll back newly created files, and
imports reject same-name legacy skills as collisions. Tests cover reopened
registries, changed references, denial, concurrent changes and successful re-pin.
Pins are host metadata; restored VM/source imports require review if the host
has no matching pins. The source ZIP manifest independently hashes skill files.

### Enforced source read/decode allocation limits

Guest source reads now use a fixed LIMIT+1 buffer and bounded reads rather than
readFile after stat. A deterministic regression grows a file to 1 MiB after its
stat result; the read rejects at the 256 KiB boundary. Source envelope decoding
also rejects excessive encoded length before atob and checks decoded UTF-8/binary
byte counts. Boundary tests preserve exact 256 KiB text and binary round trips
and reject oversized ASCII, multibyte text and encoded input. Ten focused guest
and source-file tests pass. These changes close allocation bypasses without
claiming complete hostile-process isolation.

### Pinned directory source mutations

Text writes/patches, source restore writes/deletes, mkdir and file removal now
operate through retained parent directory descriptors. Temporary writes and
rename remain anchored to the same directory even if its path is concurrently
renamed/replaced. Removed sourceChanged's redundant path-based utimes call;
actual writes update file mtimes and the compiler watches its revision marker.
The deterministic mutation race test verifies an external target remains intact
while the original pinned source directory receives the write. Eleven focused
compiler/guest tests pass, including warm rebuild, syntax repair, config restart
and Stop. Full suite before the final added write race: 90 passed/one optional
skip; bundle builds. This still does not establish isolation from a hostile guest
root process, compiler config execution, dependency journals or all metadata
operations. The broader guest sandbox gate remains open.

### Completed pinned dependency restore guest acceptance

The corrected vanilla real-VM harness completed with exit zero: failed install
preserved the old graph/preview, approved pinned nanoid installed and executed,
backward and forward source restores matched manifests/lockfiles and rebuilt,
and source/lockfile/binary ZIP plus saved VM reload/rebuild passed. Cache keys
were not used as a proxy for dependency equivalence. This run captured an earlier
bundle, before later skill, mutation and connection-lifecycle changes.

### Connection switching and privacy disclosure

Switching an API session to Codex now revokes the API session instead of retaining
its key/budget under Codex mode. API reconnect rotates cookies and revokes old
credentials; rotation is allowed even when the session table is otherwise full.
HTTP tests verify only the rotated key reaches the provider fixture, old cookies
are unauthorized, and the new Codex session rejects API streaming. Common AI
settings now disclose prompt/source/tool/skill context transmission, provider
billing/retention and disconnect/revocation. The former "work stays local until
export" wording was corrected. Gateway restart remains deferred during active
VM acceptance, so current tests establish code behavior rather than live rollout.

### Project deletion UI/runtime regression fixed

The actual deletion handler called nonexistent BrowserStore.delete, so approved
deletions could never complete. It now checks both stores are available, enables
its narrowly scoped host confirmation, calls orchestrator startFresh to end each
VM without capture and clear its checkpoint, then deletes source recovery,
history and project metadata. This avoids a surviving VM saving deleted state
again. Partial failure is described honestly. The real Builder browser test seeds
two projects and verifies denial, confirmed removal of both slots/recovery/history
and metadata, and preservation of the other project. It passes without booting
fixture snapshot bytes. The shared orchestrator tests separately exercise ending
an active machine without capture. The current bundle builds. This test uses the
private dev server and is exposed as test:browser:project-deletion, not a CI-only
mock of the UI handler.

### First-run connection guide

Added the missing first-run guide with framework/provider/prompt steps, billing
and context disclosure, deliberate settings navigation and an Explore without AI
path. Its dismissal persists per project; successful connection also hides it.
The real browser UI regression verifies correct settings focus, no automatic
provider connect requests, and dismissal after reload. The first run timed out
because the test tried clicking another setup choice while the floating settings
panel covered it; a duplicate test launch was interrupted. The corrected test
closes settings through its visible summary before switching choices. This is
preparation for novice participation, not an actual novice acceptance result.

The Supabase backup run completed all earlier real Auth/RLS/paired recovery and
reviewed failed-capture recovery assertions, then stopped in the harness when
Download.path() was used through Playwright's remote connection. Fixed the
harness to saveAs() into a temporary directory and clean downloaded sensitive
files afterward. A fresh run is active; external backup restore remains pending.
The first-run connection guide browser regression passes after closing the
floating settings panel through its visible summary between setup choices.

### Current README and provider status reconciliation

Removed stale top-level README claims that on-demand dependencies, currency
budgets and binary assets were absent. The current capability summary now links
to scoped acceptance evidence and distinguishes implemented features from open
release gates. Added the M6 provider status matrix for API/Pi, isolated Codex plan
mode, unavailable Claude subscription login and unavailable other providers. It
does not convert historical live evidence into current-artifact or account-wide
eligibility claims. Conditional P2 roadmap integrations remain explicitly gated.

### Refreshed provenance evidence

Added a repeatable development provenance command and regenerated the report for
105 source files and 14 Builder artifacts. Artifact hashes match the separate
npm provenance audit. The report explicitly records dirty worktree/HEAD and does
not attest release acceptance or guest-image provenance. Re-running the current
license audit still returns 61 findings (MPL-2.0 and Unlicense), with fingerprints
matching the existing review record; the review gate remains open.

### Individual gateway user authentication

Added bounded operator-configured user identities with distinct hashed access
tokens. Both connection modes validate the bearer token; switching identities
revokes the previous browser session. Production now requires HTTPS and an
individual user-token map; shared invitations remain development-only. Invalid
configuration errors omit secret input. HTTP tests verify both-mode denial,
separate identities, old-session revocation and no token disclosure in status.
This implements operator-managed access, not public signup/account recovery.
Per-user budgets across reconnections and final production deployment/security
acceptance remain open. Current running development gateway has not restarted.

### User-window abuse controls and SvelteKit gate promotion

Individual user quotas now survive session reconnect/disconnect in fixed one-hour
in-memory windows. Requests across API/Codex share the user request allowance;
reported API tokens and estimated API dollars also constrain the window. One
active model request per identity prevents concurrent session budget races.
Different users have isolated allowances. Missing API usage fails closed, and
window expiry is tested with an injected clock. Reconnect HTTP tests verify the
allowance cannot reset by obtaining a new session. Usage UI shows the user count
and reset time. Gateway restart resets these counters, so provider-side limits
remain necessary; no durable billing/accounting claim is made.

The second real SvelteKit guest harness completed with exit zero, covering clean
VM initialization, actual Pi-tool edit/rebuild/counter, hash navigation, binary
source/lockfile export and Save/reload/rebuild. The unchanged pinned SvelteKit
graph is now verified-development in the chooser. This is development support,
not completion of final live-provider/device/novice release gates. Template
manifest fingerprint and the still-review-required license record were updated
for the status change; npm dependency pins were unchanged.

### Per-user connection resource cap

Added a default three-session cap per authenticated identity, configurable from
1–10 in the gateway factory. A user at capacity cannot open either an extra API
or Codex session, while another identity can still connect and the original
session can rotate its credentials. Five focused user-auth/quota tests pass;
bundle builds. Aggregate gateway session/runtime caps remain in effect. No
public deployment has been performed, and the active dev gateway still runs its
previous configuration until a safe restart after guest acceptance.

### Consolidated current fast regressions and local timing hooks

Local and CI server-independent browser regressions now share one runner. The
current run passed Pi fixtures in Chromium/Firefox/WebKit; extension isolation or
safe refusal; Chromium/WebKit persistence; preview readiness/last-good retention;
backend bridge isolation/cancellation; binary media rendering; and paired backup
storage/denial/Stop/quota cleanup. These use deterministic provider/backend
fixtures and do not replace live guest/provider acceptance. Current native suite:
98 passed, one optional native fixture skipped.

Added local timing markers for the first actual streamed model response (text or
tool output), preview readiness, and verified source/database capture boundaries.
The first-output duration starts immediately before the model prompt, separate
from environment preparation. It is not labeled first-token latency where the
provider exposes only complete tool output. SessionStorage contains only stage
names and timing numbers, no prompts/source/credentials; no remote telemetry was
added. The bundle builds and the real onboarding browser regression passes.

### Backup/export Stop publication guard

Saved backup preparation now checks cancellation before/after checkpoint loading
and encoding, so Stop prevents a completed encoding operation from returning a
download artifact. A regression aborts during encoding and verifies AbortError
without changing the checkpoint. Source ZIP and pairing-manifest handlers also
check cancellation before requesting a download. Status text now says download
requested rather than claiming the browser has saved the file to disk. Three
focused backup tests pass; bundle builds. In-progress checksum work itself is
not preempted, but cancelled results are never published.

### Live subscription acceptance — November 9, 2026

The user approved a fresh official Codex device login. An isolated test browser
used the account-selected `gpt-6.1-sol` model through the development gateway;
no API key or API-billing fallback was used. The live model edited the real
React/Vite VM project and built a voting application. Actual browser interaction
updated the vote count, which survived a preview rebuild. An injected syntax
error produced a visible failed build while retaining the working preview. A
second live model turn read and repaired the source, rebuilt successfully, and
retained the vote state. The gateway confirmed disconnect after completion.

The harness exited zero. Retained non-secret evidence is in
[the subscription acceptance record](builder-live-subscription-acceptance.json).
This closes the fresh subscription-login, local live-generation and multi-turn
failure/repair acceptance slice. It does not establish a live model-generated
Supabase profile workflow, every framework/provider combination, or public release
readiness. API-key/Pi live acceptance remains distinct from this Codex result.

### Paired external VM backup acceptance — November 9 continuation

A focused real two-VM run completed with exit zero. It created two synthetic Auth
accounts, inserted private rows and checked RLS, saved the source/database pair,
downloaded the manifest and both actual `.snowglobe` files (approximately 80 MB
source and 94 MB database), imported them through the reviewed UI into a separate
project, rebuilt the restored source, and logged into both saved accounts. The
restored users retained their correct isolated row histories. The temporary
sensitive backup files were deleted by the harness. Terminal evidence is in
`/tmp/builder-backup-focused.log`; repeat with
`BUILDER_BACKUP_ONLY=1 node packages/builder/test/supabase-browser.mjs`.

The development gateway was restarted after all guest tests and the prior live
subscription session were closed. The Builder route and gateway status returned
healthy responses; newer gateway controls are now loaded in private development
mode. Settings/credential-clearing and subscription-login UI regressions pass.
The current full unit suite passed 100 tests with one optional native fixture
skipped. No public deployment or new operator credential configuration was made.

Prepared an opt-in subscription-backed profiles acceptance harness. It prepares
the real source/database VMs before asking for sign-in, limits automatic SQL
review to its declared synthetic profiles schema, and is designed to check two
accounts, profile persistence, direct cross-user RLS denial, paired save/reload
and denied destructive SQL. Its approval-scope regression passes; live generation
remains pending until the user approves the fresh sign-in.

### Live profiles sign-in wait expired

The prepared source/database VMs passed their preflight, but the fresh Codex
approval was not detected within the harness's ten-minute login window. The
harness exited nonzero and confirmed provider-session disconnect. No live model
request, generated profile migration or profile-app acceptance ran. This is a
pending user-authentication prerequisite, not evidence of an application build
or database-workflow failure. A fresh code must be requested when the user is
ready; the earlier displayed code must not be reused.

### First release scoped to private Tailscale access

The owner selected private-on-Tailscale for the first release. The new
`builder-private-release.md` checklist separates the private release's remaining
acceptance from deferred public hosting/signup work, while retaining preview,
credential, data/restore and filesystem safety gates. The original public-service
roadmap is not marked complete by this decision. Live listeners were observed on
127.0.0.1:18446 and 127.0.0.1:18447; Tailscale Serve proxies HTTPS port 18445 to the
application and its returned configuration had no enabled Funnel entries. No
network, tailnet ACL or public deployment settings were changed. Live profile
acceptance still awaits fresh user-approved subscription sign-in.

### Profile-save failure exposed a preview form bug

A user-approved live profile run generated its schema, enabled RLS, built the app
and signed into a synthetic account, but timed out waiting for its save
confirmation. It disconnected cleanly; live profile acceptance remains open.
A deterministic form-based profile app reproduced that failure without AI
credentials. Diagnostics showed no submit-handler effects or application errors.

A focused browser regression then reproduced the cause: sandbox `allow-scripts`
without `allow-forms` suppresses submit events before application handlers run.
Adding `allow-forms` enables client-side form handling while retaining the opaque
origin and CSP `form-action 'none'`. The regression failed before the fix and
passes Chromium/WebKit afterward, including async backend relay, zero native form
network requests/navigation, blocked popups and denied parent/storage access.
The full fast browser regression set and native suite pass. A fresh real-VM
profile fixture is running; the full live profile workflow is not yet marked passed.

The local, uncommitted profile harness now captures source and redacted UI
failure diagnostics before cleanup and supports one bounded functional repair in
the same live session. Diagnostic files stay private under the ignored local-dev
directory and are not part of the pushed source.

### Real profiles fixture and on-demand sign-in

After the preview form fix, the deterministic profiles source passed against real
Auth/PostgreSQL VMs: two accounts, profile saves, direct cross-user read/write
denial, paired source/database save/reload and denied destructive SQL. The
sanitized `builder-profile-fixture-acceptance.json` records this fixture result;
it does not establish live-model generation.

The private `/builder-test/` page now runs the draft profiles harness and requests
a device code only when the user clicks. Real code creation, replacement and
cancellation passed without account approval or inference. Cancellation cleanup
owns Playwright's signal handling so gateway disconnect happens before Chrome
closes. The controller refuses renewal after an unconfirmed disconnect and never
reports a fixture result as live acceptance. Its targeted unit tests pass. The
next live profiles run still requires fresh user approval; the prior failed run
disconnected its session.

### Live profiles acceptance passed

On November 9, a fresh user-approved device login ran the actual profiles prompt
through `gpt-6.1-sol`. The model inspected and changed the source, applied the
reviewed profiles/RLS schema and built a working app. Two actual Auth accounts
saved separate profiles; direct REST reads and cross-user writes confirmed row
isolation. Paired source/database Save/reload retained the signed-in profile,
and denial of a destructive migration left the profiles table intact. All
assertions passed without the optional repair turn, and cleanup confirmed the
provider session disconnected. The sanitized `builder-live-profile-acceptance.json`
records the browser bundle and test-harness hashes; local source diagnostics and
credentials are excluded.

The profile controller's real code-creation/renewal/cancel check and unit tests
also passed. Browser-bundle notices now use checksummed license text from the
matching upstream Pi v1.5.0 commit when the npm package omits its repository-root
license. Unknown versions or license declarations still require review. The
notice rebuild left the browser bundle hash unchanged, and provenance now
includes these notice inputs and distributed notice text. Full guest license,
image provenance, security and owner/device release gates remain open.

Final validation for this continuation: 106 Builder native tests passed, with
one optional fixture skipped. The package build passed with zero missing browser
notice entries; the browser bundle hash stayed unchanged. The prior complete
fast browser regression run, focused form regression, real code lifecycle check,
real profiles fixture and newly completed live profiles run all have terminal
passing results. Shared runtime and Go sources were unchanged in this continuation.

### Private candidate pinned for Chrome on macOS

Stable acceptance/notices commit `b48f0fd` was pushed to
`feat/builder-private-release`. The owner selected Chrome on macOS for the hands-on
walkthrough and was given a fresh-project recipe/search/save/reload/Stop/Retry/export
sequence; their results and Chrome version remain pending.

An owner-only local snapshot preserves that exact source commit, the previous
`0315dc3` source, tested browser assets and all referenced web/Supabase blobs.
All 6,962 asset entries passed archive readback; both guest build IDs were
independently recomputed and matched the catalog. The source archives retain their
matching Git commit markers. The sanitized `builder-private-candidate.json`
records hashes and scope; the binary archives and full inventory remain outside Git.

An isolated loopback drill restored the archived previous gateway source with
its unchanged dependency lock, started it after stopping an isolated candidate
gateway, verified rejection of the old session cookie, and verified a new
connect/disconnect/revocation cycle. It used synthetic credentials and made zero
provider calls. An initial harness connection reused a closed keepalive socket;
forcing Connection: close made the drill deterministic. The live gateway was not
restarted and the owner's browser workspace was not touched. Operational host
rollback, off-host image backup, guest provenance/license/security review and
owner/device approval remain open; this is an unapproved private candidate.

### Owner reported successful Chrome app generation

In Chrome on macOS, the owner connected ChatGPT and submitted one combined
prompt requesting recipe categories, search and Supabase accounts with per-user
recipes. The owner reported that the application built and appeared to work well.
This is owner-reported generation success, not an independently observed browser
run or confirmation of each requested feature. Account isolation, search,
Save/reload, Stop/Retry, export and the actual Chrome version remain unconfirmed.
The private candidate remains unapproved and the full walkthrough gate stays open.

### Upstream main merged into the Builder branch

Integrated upstream main at `4b5b8d2`, preserving all six incoming commits
(including fleet/link support, fleet templates, armless 0.9.3 and faster initial
npm installs). The merge was prepared and tested in a separate checkout. Five
conflicts were resolved by retaining both fleet publication and private Builder
exclusion, both worker link/recovery operations, both sets of orchestrator tests,
and both build/ignore requirements.

Integration checks found two Builder-only adaptations that needed updating:
the new worker loader requires `ws-client.js`, and the changed guestFetch
signature no longer matched the old network-restriction replacement. Builder
now copies/loads the WebSocket helper and its build rejects an unrecognized
fetch function instead of silently shipping unrestricted networking. Both new
artifact regressions failed before the fix and passed afterward. A real Chromium
worker initialization fixture also imports the built loader dependencies and is
included in the fast CI browser regression set. The shared demo networking keeps
upstream's behavior; only Builder's copied worker core has the npm restriction.

Terminal validation: Go `test ./...` passed, all 233 shared Node tests passed,
108 Builder tests passed with one optional skip, the package build passed, and
the complete fast browser regression set passed. Initial isolated-checkout test
setup failures (Go missing from PATH and a dependency symlink rejected by the
provenance scanner) were corrected without weakening either test. The prior
live-model and real-VM acceptance records remain tied to their original archived
artifact; they were not repeated against the merged runtime. The old private
candidate needs requalification before release. No PR was created.
