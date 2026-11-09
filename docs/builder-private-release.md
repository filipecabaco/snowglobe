# Builder first release: private on Tailscale

The owner selected this scope on November 9, 2026. It defines the first release,
not completion of the original public-service roadmap. Public signup, public
hosting/domain setup, internet-wide availability and public-service abuse
qualification are deferred. The existing Pages workflow must continue excluding
Builder.

## Access and operation

Use `https://aspire.tailb03e.ts.net:18445/builder/` from an authorized device on
the tailnet. Keep the application listener on `127.0.0.1:18446` and the model
gateway on `127.0.0.1:18447`, behind Tailscale Serve HTTPS. Do not enable Tailscale
Funnel or bind either listener to a public interface. Tailnet access rules and
device authorization determine who can reach the service; this release does not
include a public account system.

The initial acceptance target is the owner's trusted desktop browser and test
data. Before inviting additional people, explicitly identify the intended users,
review their tailnet access, and configure individual gateway tokens if per-user
quotas and revocation are required. A broad tailnet grant is not a substitute for
that review. This decision does not authorize changes to tailnet-wide ACLs.

On November 9 the live listeners were confirmed on loopback, and Tailscale Serve
was configured to proxy HTTPS port 18445 to the local application. The returned
Serve configuration had no enabled Funnel entries. This is a configuration
observation, not an external penetration test or proof about unrelated tunnels.
No network configuration was changed for this scope decision.

## First-release acceptance

- [x] Four development framework guest workflows: React/Vite, vanilla/Vite,
  Svelte/Vite and SvelteKit SPA.
- [x] Subscription login, live local app generation, actual interaction, state
  persistence, visible build failure and a second live repair turn.
- [x] Synthetic two-account Supabase Auth, CRUD and row isolation in real VMs.
- [x] Paired source/database save, actual backup downloads, reviewed import into a
  new project, rebuild and both restored accounts' isolated rows.
- [x] Private gateway reload and route/status health checks.
- [x] Live model-generated accounts/profiles workflow, direct cross-user denial,
  paired save/reload and denied destructive migration. After the preview form
  fix, the user-approved `gpt-6.1-sol` run passed without a repair turn and
  confirmed disconnect. See [the live record](builder-live-profile-acceptance.json);
  [the separate fixture record](builder-profile-fixture-acceptance.json) records
  deterministic source against real Auth/PostgreSQL VMs.
- [ ] Final Stop/Retry and novice walkthrough on the owner's supported desktop
  browser, using the retained acceptance worksheet.
- [ ] Approve the [recorded private candidate](builder-private-candidate.json),
  matching guest images and rollback reference. All 6,962 archived assets passed
  readback and both guest build IDs matched. An isolated archived-gateway drill
  passed restart/session-revocation and connect/disconnect checks without live
  inference; an operational host rollback drill and independent off-host image
  backup remain open. Keep source and sensitive browser VM backups separately.
- [ ] Finish the applicable notices/provenance and security review. Tailnet-only
  access does not close preview, credential, restore or filesystem safety gates.

The owner selected Chrome on macOS for the final hands-on walkthrough. Its
actual browser version and results remain pending. Desktop Chrome/Edge are the first target. Firefox/WebKit component tests do not
establish full workflow support on physical Safari, iPhone or Android. Broader
browser/device support is a separate qualification; unsupported devices must not
be advertised as verified for this release.

## Remaining boundaries

Projects and database state stay in their browser profile and do not synchronize
across devices. AI context goes to the selected provider through the private
model gateway. Source restore does not roll back database data. VM backups are
sensitive and image-dependent. Public publishing, Next.js/SSR, unsupported
Supabase services and native Pi extensions remain outside the verified feature
set. Concurrent hostile guest-process safety remains under review; private
network access does not turn generated code into trusted code.

Use the existing [operations and rollback guide](builder-operations.md) and
[nontechnical acceptance worksheet](builder-novice-acceptance.md). The
[release evidence ledger](builder-release-evidence.md) retains the broader
roadmap's outstanding checks rather than silently marking them complete.
