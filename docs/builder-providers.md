# Builder provider connections

Builder uses the installed `@earendil-works/pi-ai` **1.5.0** provider factories,
authentication interactions and thinking metadata. This investigation is pinned
to that package, rather than assuming the latest upstream main matches it.
Upstream references: [providers](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/providers.md),
[auth interaction contract](https://github.com/earendil-works/pi/blob/main/packages/ai/src/auth/types.ts),
and [provider/model collection](https://github.com/earendil-works/pi/blob/main/packages/ai/src/models.ts).

## User workflow

1. Open **AI settings**, choose a provider and method under **Add a provider**, then **Continue**.
2. Complete the provider's native prompts: API key, account settings, device code, or browser authorization. On a remote gateway, prefer device-code/copy-code options. If a loopback callback cannot reach the gateway, paste the final callback URL/code into the protected sign-in field when Pi requests it.
3. Add more providers without removing earlier connections. A provider can have both an API-key and OAuth connection. Repeating the same provider/method replaces that credential only after successful login/setup.
4. Search the combined model list, choose a model and its supported thinking level. Selection is per project. Switching between providers preserves portable chat context; it does not copy provider-specific tool calls or reasoning signatures.
5. **Refresh models** retries catalog discovery. **Forget connection** deletes that method's saved credential and catalog. The independent **Forget ChatGPT connection** signs out of the official Codex runtime.

The original official Codex device-login connection stays available alongside Pi.
Its models and reasoning efforts come from the official app-server, not a hardcoded
list. Pi's OpenAI and legacy Codex OAuth methods are also exposed as supplied by Pi;
there is no automatic transfer of credentials between those implementations.

## Pinned provider matrix

Counts are shipped chat catalog entries, not proof of account entitlement. Names,
models and auth methods are read from the installed factories. Dynamic catalogs
can change after refresh. Images/classifiers are not Builder coding models.

| Provider | Pi ID | Key setup | OAuth | Shipped chat models |
| --- | --- | --- | --- | --- |
| Amazon Bedrock | `amazon-bedrock` | Key / token | — | 197 |
| Ant Ling | `ant-ling` | Key / token | — | 3 |
| Anthropic | `anthropic` | Key / token | Yes | 17 |
| Azure | `azure` | Key / token | — | 45 |
| Baseten | `baseten` | Key / token | — | 14 |
| Cerebras | `cerebras` | Key / token | — | 2 |
| Cloudflare AI Gateway | `cloudflare-ai-gateway` | Key / token | — | 59 |
| Cloudflare Workers AI | `cloudflare-workers-ai` | Key / token | — | 19 |
| DeepSeek | `deepseek` | Key / token | — | 2 |
| Fireworks | `fireworks` | Key / token | — | 29 |
| GitHub Copilot | `github-copilot` | Key / token | Yes | 27 |
| Google | `google` | Key / token | — | 23 |
| Google Vertex AI | `google-vertex` | Key / token | — | 13 |
| Groq | `groq` | Key / token | — | 7 |
| Hugging Face | `huggingface` | Key / token | — | 78 |
| Kimi For Coding | `kimi-coding` | Key / token | Yes | 6 |
| Meta | `meta` | Key / token | Yes | 6 |
| MiniMax | `minimax` | Key / token | — | 4 |
| MiniMax CN | `minimax-cn` | Key / token | — | 4 |
| Mistral | `mistral` | Key / token | — | 34 |
| Moonshot AI | `moonshotai` | Key / token | — | 6 |
| Moonshot AI CN | `moonshotai-cn` | Key / token | — | 6 |
| NVIDIA | `nvidia` | Key / token | — | 21 |
| OpenAI | `openai` | Key / token | Yes | 44 |
| OpenAI Codex (legacy) | `openai-codex` | — | Yes | 8 |
| OpenCode Zen | `opencode` | Key / token | — | 79 |
| OpenCode Go | `opencode-go` | Key / token | — | 30 |
| OpenRouter | `openrouter` | Key / token | Yes | 388 |
| Qwen Token Plan | `qwen-token-plan` | Key / token | — | 21 |
| Qwen Token Plan CN | `qwen-token-plan-cn` | Key / token | — | 21 |
| Qwen Token Plan Individual | `qwen-token-plan-individual` | Key / token | — | 9 |
| Radius | `radius` | Key / token | Yes | 28 |
| Together | `together` | Key / token | — | 15 |
| TypeSafe | `typesafe` | Key / token | — | None (classifiers only) |
| Vercel AI Gateway | `vercel-ai-gateway` | Key / token | — | 303 |
| xAI | `xai` | Key / token | Yes | 4 |
| Xiaomi | `xiaomi` | Key / token | — | 3 |
| Xiaomi Token Plan AMS | `xiaomi-token-plan-ams` | Key / token | — | 2 |
| Xiaomi Token Plan CN | `xiaomi-token-plan-cn` | Key / token | — | 2 |
| Xiaomi Token Plan SGP | `xiaomi-token-plan-sgp` | Key / token | — | 2 |
| Z.AI | `zai` | Key / token | — | 7 |
| Z.AI Coding CN | `zai-coding-cn` | Key / token | — | 4 |

## Cloud credentials and advanced Pi capabilities

Pi supports more than interactive keys: environment variables, auth-file credentials,
provider-scoped configuration, AWS profiles/IAM/default chains, Google ADC/service
account files, command-based key resolvers, custom models/endpoints and native
provider extensions. Those mechanisms normally run with a local CLI user's host
permissions. Builder does not execute arbitrary auth commands, accept credential
file paths, import the operator's ambient credentials, or run native extensions
on behalf of a browser user. Custom provider/model configuration is not part of
this UI; the built-in provider catalog is the supported scope.

- **Bedrock:** user-supplied bearer token plus AWS region. The web flow skips the
  host AWS-profile/default-chain choices. It never exposes the operator's IAM role.
- **Vertex:** user-supplied Google Cloud API key. Host ADC and service-account
  file choices are skipped; a path on a Mac would not refer to the gateway anyway.
- **Azure:** user-supplied key, Azure OpenAI resource name, and optional
  `model-id=deployment-name` mapping. Arbitrary Azure/Foundry endpoint overrides
  and custom deployments absent from Pi's catalog are not offered.
- **Cloudflare:** Pi asks for the key, account ID and (for AI Gateway) gateway ID.
- **OpenRouter:** uses Pi's account-specific catalog personalizer and persists its
  returned model limits/pricing. Network failure retains the last catalog.
- **Radius:** refreshes its provider-owned gateway catalog and caches it for restart.
- **GitHub Copilot:** Pi's credential-specific model filter is honored.

Provider authorization, billing, organization policy and plan eligibility are
provider-controlled. An OAuth label is not a promise that usage is included in a
subscription. API-key requests use catalog spending estimates; subscription-marked
OAuth connections show request counts and leave actual billing to the provider.
There is no automatic fallback to another connection when inference fails.

## Persistence and boundaries

Pi keys, OAuth access/refresh tokens, required account settings and cached catalogs
are held in a gateway-only AES-256-GCM vault. Each browser profile gets a random
256-bit capability in an HttpOnly/SameSite=Strict cookie; only its hash names the
vault file. HTTPS adds Secure. The cookie has a rolling one-year lifetime.
Run one gateway process per credential directory. Within that process, vault
writes are serialized and published by atomic rename; Pi token rotation
runs inside the same credential-store lock. A refresh failure retains the old
credential for retry. Cancellation/failure before credentials are committed preserves any
working credential for the same provider/method.

`BUILDER_CREDENTIAL_DIR` defaults to `.local-dev/builder-credentials/`. The directory
is 0700, master key and vaults 0600. Encryption protects the files at rest; the
server operator owns the master key and can decrypt them. This is not end-to-end
encryption or an OS keychain. Keep private backups of both if needed. Restoring
only vault files without the master key cannot recover credentials.

The official Codex runtime owns its own protected credential files in
`BUILDER_CODEX_DIR`; these are not converted to Pi credentials or included in the
encrypted Pi vault. Native shutdown preserves remembered auth; explicit Forget
logs out and deletes its directory. Existing pre-feature sessions may require
one fresh sign-in. The official runtime refreshes its own tokens.

Credentials never enter project IndexedDB, localStorage, preview messages, VM
filesystem, source exports or VM backups. Project metadata stores only a connection
identifier, model ID and thinking preference. Credentials remain browser-profile
specific; this is not cross-device account sync. Clearing browser cookies leaves
unreachable gateway files, not an automatic server wipe. Provider-side revocation,
cookie deletion/expiry, lost server files, or a provider refusing refresh can
require sign-in again. Production profiles are bound to the gateway user identity;
removing that identity disables access to its profile.

The gateway re-resolves each selected model from its own catalog and checks the
connection's available models and thinking levels on every inference request.
Client-supplied endpoints, headers, model definitions and arbitrary stream options
are ignored. Origin checks, CSRF protection, request budgets and user quotas also
apply to the new routes. Model selection is carried per request, so another tab
cannot change an in-flight request's provider/model.

## Verification

`provider-connections.test.mjs` exercises the pinned catalog, multiple keys plus
OAuth for one provider, sanitized metadata/errors, unsupported thinking rejection,
provider/model enforcement, token rotation and serialized writes, failed/cancelled
login, tampered vault rejection, user isolation, restart recovery, native Codex
persistence/Forget and account-reported reasoning efforts.

`providers-browser.mjs` runs the actual Builder, Pi Agent/proxy, gateway and
encrypted vault with fixture provider inference. Chromium and WebKit cover multiple
connections, a second method for one provider, model/thinking switching, portable
conversation handoff, cleared secret fields, HttpOnly cookies, browser and gateway
restart, restored model preference and scoped Forget. It is included in the fast
browser regression suite.

These tests use synthetic credentials and responses. They do not establish live
entitlement or successful OAuth/inference for every provider. Earlier documented
live ChatGPT acceptance predates this change; fresh provider-specific acceptance
requires the owner's sign-in or keys through the app UI, never in chat.
