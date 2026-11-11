# Resident compiler and Codex subscription mode

Builder keeps its VM workspace canonical. A detached Node process inside that VM owns a Vite watch build and a private Unix socket. It retains compiler imports and the watch graph across edits. An internal revision file, referenced by a virtual build module, binds results to the latest completed source writes. A config epoch restarts the watcher when build configuration changes. The host only replaces the isolated preview after a successful matching result. It preserves the previous preview on failure.

The watch backend uses the pinned Rolldown experimental incremental option. Plugin transforms can still rerun on unchanged dependencies: retaining a compiler process does not imply every transform is cached. The implementation tests actual output, revisions, runtime reuse and recovery rather than claiming cache behavior unsupported by the bundled engine.

Save waits for a settled compiler before capturing the VM. Cancellation terminates the detached guest compiler process group, including native compiler workers. Restarting a stopped compiler is intentionally a cold operation. The socket is internal to the VM and has no preview HTTP route.

For subscriptions, Builder uses the official `codex login --device-auth` command for device-code authentication and the official Codex app-server for inference. It shows the verification URL and code; the user approves with OpenAI in their own browser. After the CLI stores its credentials, a fresh app-server loads that same private Codex-owned store itself. Codex owns login, token refresh and model inference. No Codex token is extracted and reused as a Pi API key. API-key/Pi mode stays separate, with no billing fallback.

Each browser session gets an isolated owner-only Codex configuration/credential directory. Its shell, apps and web search are disabled; its permission profile denies host project and credential access and allows only minimal runtime paths plus an empty read-only working directory. Project instruction-file loading is disabled. Dynamic tools relay list/read/write/build requests to the owning browser VM. ADR 0003 adds Supabase setup and limited-role migration tools, bringing the total to six. All other app-server approval requests are rejected. Requests and responses are bound to the active browser session and turn; late results are rejected. Disconnect/expiry/shutdown clean up the runtime. Public multi-user deployment remains gated.

The app-server dynamic-tool API is experimental. Tested local Codex version: 0.167.0. User-approved CLI device authentication and a live `gpt-6.1-sol` turn passed on 2026-11-08, including actual VM source edits, compilation, a vote and persistence across preview rebuild, followed by disconnection. Generated schemas and mocked login tests alone do not establish access for another account.

References:

- https://learn.chatgpt.com/docs/auth#login-on-headless-devices
- https://learn.chatgpt.com/docs/app-server
- https://learn.chatgpt.com/docs/permissions
