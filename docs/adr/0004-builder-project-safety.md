# Builder task approvals, source versions and project boundaries

The continuing implementation uses a host-owned review dialog for every SQL
migration, source deletion, source-version restore, skill import and extension
activation. It displays exact SQL/source and resolves only from the host UI.
Escape/Cancel denies; Stop aborts the pending review. No mutation occurs before
approval. Pi and Codex use the same host-side policies. These approvals concern
actions performed by Builder's agent, independently of developer authorization
to implement and test Builder.

File operations remain bounded, relative to /workspace and version checked.
Agent guest commands are a fixed check/test catalog rather than a shell interface.
Detached command groups are killed on deadline, SIGINT and SIGTERM. Node test
execution selects project tests explicitly and excludes bundled skill scripts.
The job-file transport remains the deliberate alternative to the proposed
separate TCP RPC service; no privileged RPC is reachable through preview HTTP.

The owner can separately open Console in the parent Builder page and choose the
project's source or database VM. Its authenticated PTY runs independently of the
serial channel used by agent jobs, supports interactive programs such as psql,
and closes before Builder jobs or checkpoint capture. Commands and SQL entered
by the owner change the VM directly; they are not automatically migrations.
The short-lived binary upload and terminal ports are unavailable through preview
HTTP. No console operation or output is added to model tools or conversations.

Source history is separate from VM/database checkpoints. Before a restore, the
host shows a diff and the guest verifies hashes and the complete source file set.
A guest-side before-image journal survives process interruption. Unfinished
restores roll back before the next file operation; completed restores remove the
journal only after all changes and compiler revisions are recorded. Existing
migration files are immutable. A source version cannot roll back database rows,
accounts or existing migration history.

Projects use stable UUIDs and separate VM checkpoint scopes without changing
asset URLs. Recovery, source versions and conversation records use those same
identifiers. Codex sessions share authentication but keep independent thread
references per project. Restored chat text is portable across process restarts;
it cannot grant tool permissions. VM-client generation changes invalidate helper
installation and late results after the owning host changes.

Skill imports are text-only, bounded, reviewed source. Metadata is supplied as
untrusted project context, and instructions are loaded on demand. Skill scripts
never execute automatically. Full native Pi extensions remain out of scope.

The Builder extension format is versioned and permissioned. Executable code runs
in a dedicated worker inside an opaque sandbox, with network-denying CSP. The
parent only brokers approved list/read operations while an invocation is active.
Source-window checks, per-frame nonces, request/output limits, cancellation and
revocation constrain the bridge. The worker keeps an infinite loop off the host
UI thread. Browser resource exhaustion is still a platform risk: this is a local
development extension feature, not proof of public malicious-code hardening.

Chromium passed extension isolation and cancellation acceptance. WebKit currently
blocks the opaque-origin blob worker under Cross-Origin-Embedder-Policy. That
engine refuses activation, removes the failed instance and reports the limitation;
it does not fall back to executing extension code in the host or iframe thread.
The sandbox and multi-CPU isolation headers are preserved.
