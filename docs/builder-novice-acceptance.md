# Nontechnical acceptance worksheet

Status: partial owner report. In Chrome on macOS, the owner connected ChatGPT
and reported that the requested recipe app built and appeared to work well.
Search, application accounts/isolation, Save/reload, Stop/Retry and export have
not yet been individually confirmed. The pinned
[candidate record](builder-private-candidate.json) identifies source commit
`b48f0fd9c47c10fd9351b5bd61f35c597f12f2b4`, browser assets and matching guest
images. Record the actual Chrome version before counting physical-device results.
Complete this with a participant who has not used Builder.
The facilitator records results without supplying terminal commands or developer
tools. This worksheet does not replace automated safety or real VM tests.

Record date, artifact commit/hash, gateway version, guest image hashes, browser
version, OS/device, network, starting storage availability, and participant's prior
experience. Use a fresh browser profile. Use test accounts and no private data.
Record task duration, participant confusion, visible status/error text, whether
help was required, and source/export/checkpoint evidence for each step.

1. Open Builder, create a project, connect the supported provider through AI
   settings, and request: “Create a recipe app with categories.” Pass when the
   participant reaches an interactive preview without terminal, folder picker or
   facilitator intervention. Record the actual model/provider and consent flow.
2. Request: “Make the recipe list searchable.” Add recipes and verify filtering;
   then request a second change and verify the old feature remains usable. Pass
   requires real edits/builds and no lost source or conversational continuity.
3. Save VM, reload, and use the app again. Verify source and preview reflect the
   saved app, not a starter. Repeat with a database-backed profiles app: create
   two test users, write distinct profiles, log out/in, verify isolation, Save,
   reload and verify both retained accounts and correct per-user records.
4. With a facilitator-prepared invalid source edit, rebuild. Verify the visible
   error is accurate and the previous preview stays usable. Request repair;
   exercise Stop while work is active, then Retry. Verify no approval remains
   active after Stop and the repaired app works without duplicate operations.
5. Export source. Open the ZIP and its README. Verify source, pinned manifests,
   migrations and any binary asset are present, while credentials, node_modules,
   build caches, database rows and account records are absent. Follow the local
   run instructions in a separate clean environment and record the result.
6. Request deletion of all profiles. Deny the exact SQL approval. Verify existing
   profiles remain intact. Record that denial was respected without a workaround.
7. Run the automated malicious-preview fixture against the same artifact and
   record its result: parent origin/storage, gateway credentials, other projects
   and privileged RPC must remain inaccessible. Do not ask the participant to
   paste attack code or credentials into generated source.
8. Review the browser support/privacy/recovery disclosure. Ask the participant
   where source and accounts are stored, where AI context is sent, and what
   deleting browser data does. Record their answers and any misunderstanding.

A failure is retained as evidence with reproduction steps and followed by a fresh
verification of the affected behavior after repair. All tasks must pass on each
advertised full-workflow browser/device before marking the novice release gate
complete. Facilitator completion or a mock model is not participant acceptance.
