# Builder development tool contract

This describes the current private adapter for future integrations. It is not an
externally reachable MCP server. Tools operate on the active browser-owned
project, through its owning VM. They cannot access the host machine's shell or
credentials. See ADRs 0001–0004 for the trust boundaries.

## Transport and ownership

The request envelope is `{protocol: "snowglobe-builder-rpc-v1", id, projectId,
vmGeneration, op, params}`. `id` is a fresh string per call. `projectId` and
`vmGeneration` must match the browser client's current project and VM host.
Responses echo the envelope and carry `ok` plus `result` or a bounded error.
Progress records include request/project/generation, stage and message; they
never authorize another operation. The browser rejects stale or truncated
results. Host replacement reinstalls guest tools and increments generation.

The adapter serializes calls, transfers compressed helpers and a request file
through the existing job runner, and waits for a matching terminal response.
Cancellation terminates the job; it is not a successful result. Replaying an
arbitrary timed-out mutation is unsafe. Automatic bootstrap retry is limited to
a verified pre-execution upload failure. The transport is trusted within the
owning VM; it does not claim protection against a concurrently hostile guest
process modifying paths between filesystem checks.

## Operations

| Operation | Parameters and behavior |
| --- | --- |
| `project.templates` | Supported template summaries; compatibility status is part of the response |
| `project.info` | Initialized template, version, dependency key and toolchain |
| `project.initialize` | `template`; refuses to overwrite an existing different workspace |
| `project.dependencies` | Exact public npm package/version map; lifecycle scripts disabled; managed lockfile and atomic graph commit |
| `fs.list` | Relative source files, excluding build output, dependencies, secrets and symlinks |
| `fs.read` | Relative `path`; returns UTF-8 `text` and SHA-256 `version` |
| `fs.write` | `path`, `text`, `version`; null version creates a new file |
| `fs.patch` | `path`, `version`, nonempty `search`, `replacement`; search must match once |
| `fs.mkdir` | Relative `path` |
| `fs.remove` | Relative `path` and current `version`; reviewed by the browser before execution |
| `process.run` | `command` is `check` or `test`; bounded deadline/output and process-group cancellation |
| `project.diagnostics` | Last persisted check/build result, never an invented success |
| `preview.build` | Build the selected framework and package the isolated static preview; keep the last successful preview on failure |
| `project.export` | Source archive data described below; excludes database rows and VM state |
| `project.restore` | Complete `expected` path/hash map and target `files` or delta `changes`; null delta values delete files; durable journal and conflict checks |

Agent-facing tool names are mapped to these operations in `src/app.js` and the
Codex catalog in `codex-runtime.mjs`. Backend operations use a separate VM and
adapter: enable, inspect schema, apply a named migration, and proxy bounded
Auth/REST requests. Every SQL migration requires an exact-SQL review in the host
UI. Approval is scoped to that request and revoked by Stop. Migration history
cannot be changed by file restore. Skills and extensions cannot grant approval.

## Source format and compatibility

`project.export` returns `{format: "snowglobe-source-v2", template, files}`.
Each `files[path]` is either a UTF-8 string or `{encoding: "base64", data}` for
binary bytes. Base64 must be canonical. Plain strings remain compatible with
existing v1 recovery/history records. Hashes always cover decoded original bytes;
a text file containing JSON resembling an envelope stays plain text. Manifests
and migration SQL must remain text.

The ZIP writer decodes envelopes into real files. Recovery, duplication and
history retain them as structured data. A binary diff displays its size and
base64 bytes. Individual files are at most 256 KiB, source exports/restores at
most 600 KiB total and 500 files. There are no silently omitted oversized files.
Read/edit text tools reject binary files. This format does not imply arbitrary
asset rendering support in the isolated preview; external asset/chunk references
must be packaged by a separately verified preview adapter.

Paths must be relative, bounded and free of traversal, control characters,
backslashes and disallowed directories. Symlinks are rejected or excluded.
`package-lock.json` and dependency fields in `package.json` are changed only by
the dependency installer. Restoring old dependencies requires the corresponding
validated cached graph or a successful approved installation path. Existing
migration files cannot be edited, deleted or rolled back by source restore.

## Extension boundary

Reviewed extensions run in an opaque frame and dedicated worker with explicit
read-only file scopes. They have no host DOM, credentials, shell or network.
Revocation, Stop or page close destroys their capabilities. Imported skill
metadata and instructions are untrusted content loaded on demand; executable
native Pi extensions require a separately gated native integration.

Future MCP/native adapters must retain these ownership, version, approval,
cancellation and source-format rules. A new transport is not authorization to
expose unrestricted process execution or bypass host review.
