# snowglobe skills

Agent skills in the SKILL.md format (a directory per skill, YAML `name` and `description`, a markdown body). One concern per skill; link, don't duplicate. Each skill loads when its concern comes up, so keep them small and send readers to a sibling by name instead of repeating it.

| Skill | Concern |
|---|---|
| `snowglobe` | What it is, the three places things run, which skill to load, the happy path |
| `snowglobe-build` | `snowglobe build`, flags, `LABEL snowglobe.*`, what a site contains |
| `snowglobe-run` | `serve`, `run`, `sh`, `cp`, the daemon, `up`, snapshots, `snowglobe ui`, saving |
| `snowglobe-fleet` | `snowglobe.toml`, `diff` / `apply` / `down` / `top`, instances, the same file at /fleet/ |
| `snowglobe-networking` | `--network fetch`, tunnels, egress, links, WebSockets, what is refused |
| `snowglobe-agents` | `snowglobe mcp`, the /agent/ page and its WebMCP tools, consent, limits |
| `snowglobe-hosted` | The handoff server: what works today and what does not |

Rules for editing:

- Every command, flag, label and tool name must exist: check it against `snowglobe --help`, the Go source, `site/llms.txt` or `internal/site/agent-webmcp.js`.
- The CLI and daemon come first; the browser pages are another place the same site and fleet files run.
- Reference detail goes behind a `More:` link to the docs, not into the skill.
