# Builder release evidence

This maps section 18 of the original implementation plan to evidence. It is an
acceptance ledger, not a declaration that the implementation is ready to release.
Passing native fixtures establish their asserted behavior only.

The owner selected a [private Tailscale first release](builder-private-release.md).
Public hosting, signup and public-service qualification are deferred to a later
release. The security and data-safety checks below still apply; this scope
decision does not mark the full public-service roadmap complete.

| Release requirement | Current evidence | Outstanding acceptance |
| --- | --- | --- |
| Existing demos and tests | Go suite and 184 shared JavaScript tests passed in this implementation pass | Recheck after any further shared-runtime edits |
| Independent deployed route | Builder has its own route; default Pages assembly removes `dist/builder` | Private deployment/release acceptance |
| Nontechnical fresh-project walkthrough | Browser fixtures exercise real VM work | Actual nontechnical participant walkthrough |
| AI/framework chooser and clean VM templates | Pinned manifests, provisioning, chooser; framework guest harness | All four guest framework runs and live Codex choice passed; final release artifact/device matrix and optional API-provider live qualification remain |
| Honest backend scope | Postgres/Auth/PostgREST UI and operations disclosure | Chromium paired restore and live generated profiles/two-user RLS passed; final artifact/device matrix remains |
| Skills and extension boundaries | Unit and browser fixtures; unsupported native execution excluded | Supported-browser acceptance on final artifact |
| Provider secret separation | Gateway owns credentials; preview has no host origin | Live subscription connect/inference/disconnect passed; final artifact export/backup inspection remains |
| Preview isolation | Opaque sandbox, strict message identity, deny-network CSP; browser fixtures | Final adversarial release matrix |
| RPC project and generation identity | Client/runtime tests and project-scoped storage | Concurrent hostile guest filesystem races remain unresolved |
| Database approval and denial | Exact SQL approval tests, denied migration guest evidence, live generated profiles migration and destructive denial passed | Final artifact/device qualification |
| Truthful errors/build completion | Guest build exit checks and failure UI tests | SvelteKit guest compile/edit/reload passed; final release matrix remains |
| Last working preview after interruption | Readiness browser regression and guest failure scenarios | Final Stop/Retry walkthrough |
| Save/recovery and quota | Chromium/WebKit IndexedDB tests, including binary bytes and injected quota failure | Focused real source/database backup download, new-project import and account/row restore passed; final device matrix remains open |
| Source and Postgres restore | Source journal unit tests; paired Supabase guest run passed | Dependency graph restore and real downloaded paired backup/import acceptance passed; final release/device matrix remains open |
| Portable source export | ZIP excludes caches; binary round-trip unit tests; guest harness assertions | Final artifact guest export acceptance |
| Credential connect/disconnect/rotate/revoke | Gateway unit fixtures and lifecycle implementation | Subscription connect/live inference/disconnect and profiles passed; live rotation/revocation remain |
| Browser documentation | Operations/progress docs distinguish native fixtures, browser fixtures and physical devices | Final browser/device matrix |
| Privacy disclosure | Operations guide documents provider context and browser persistence | Product disclosure review against final flows |
| Pinned dependencies and licenses | Exact locks and inventory audit; 61 review findings recorded; browser notices include pinned upstream Pi license text | License approval and guest image/OS provenance |
| Approved subscription integration | Official Codex app-server integration; no Claude subscription claim | User-approved live local app generation/interaction/repair and profiles passed; provider eligibility review remains |

Current long-running tests must have terminal results before their assertions are
counted as passed. A live process or repeated progress messages establish only
that the test is still running. Final release evidence must include the exact
commit/artifact and browser/image versions; these incremental runs do not yet
provide that immutable release record.

The sanitized [live profiles record](builder-live-profile-acceptance.json) is
separate from the [deterministic real-VM fixture record](builder-profile-fixture-acceptance.json).
Both passed against the browser bundle hash they record; neither closes the
owner walkthrough, physical-device or final immutable release gates.
