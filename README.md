# Bifrost live discovery for OpenClaw

Audited derivative of `mberatsanli/openclaw-plugin-bifrost`, based on
`e81706eed78bb0c06073656d38b4d6f9fe723b03`. Tested with **OpenClaw 2026.10.9**
and Node **24.22.2**. This is a local review build, not a published upstream release.

The plugin id remains `bifrost`; its provider is now **`bifrost-live`**. Model
references are `bifrost-live/<exact Bifrost id>`, for example
`bifrost-live/OllamaLocal/example-model`. Existing `bifrost/...` references and
`models.providers.bifrost` remain independent.

## Behavior

- Native `catalog.run` discovery uses the SDK's guarded HTTP client to request
  the gateway's `/v1/models` with the current Virtual Key.
- Every invocation fetches a complete, fresh catalog. No plugin TTL, retained
  keys, cumulative union, disk synchronization, or stale fallback. An empty
  response replaces the previous result. Failures return an empty provider and
  a native `auth-rejected` or `unavailable` outcome.
- Auth is resolved afresh through OpenClaw. `discoveryApiKey` takes precedence
  over the host's credential marker. A credential change during discovery
  discards that response and retries, at most three times.
- `prepareDynamicModel` resolves the current credential (including a locked
  profile), fetches current metadata and rejects unknown/revoked models.
  `resolveDynamicModel` deliberately has no synchronous stale cache.
- `prepareRuntimeAuth` checks the exact key selected for inference, even if core
  supplied an older registry row. Catalog failures and revocations throw rather
  than falling through to OpenClaw's generic model guessing.
- All valid returned model IDs are listed without a name-based denylist.
  Listing does not mean every model supports chat completions.
- Redirects are rejected. No credential is retried anonymously. The SDK bounds
  response size, follows supported same-origin pagination and applies a total
  timeout (default 5 seconds). Errors do not include response bodies or keys.

## Coexistence

OpenClaw 2026.10.9 merges explicitly configured models additively. Returning an
empty discovered list cannot delete `models.providers.bifrost.models`.
Using the separate provider `bifrost-live` avoids claiming ownership of those
static rows. Only the legacy **URL** is read as a fallback; legacy models,
headers and stored credentials are neither copied nor modified.

URL order: plugin `plugins.entries.bifrost.config.baseUrl`, then
`models.providers.bifrost-live.baseUrl`, then `models.providers.bifrost.baseUrl`,
then `http://localhost:8080/v1`. `/openai` and `/openai/v1` are normalized to
`/v1` for the new provider; reverse-proxy path prefixes are retained.
Conflicting plugin/live URLs are rejected before sending credentials.

Keep the new live namespace free of static model rows and credential header
overrides. The plugin refuses to execute with those conflicting settings.
No model registration is needed. OpenClaw's separate model allowlist policies
still apply; this plugin does not widen them or change a default model.

## Install the reviewed build (manual, not performed during development)

See [Spanish installation and verification guide](docs/INSTALACION-Y-VERIFICACION.md).
With the supplied archive, use its absolute path:

```sh
openclaw plugins install /absolute/path/openclaw-plugin-bifrost-0.2.0.tgz --accept-capabilities
openclaw config set plugins.entries.bifrost.config.baseUrl https://your-gateway.example/v1
openclaw models auth paste-api-key --provider bifrost-live
openclaw gateway restart
openclaw models list --all --provider bifrost-live --refresh --json
```

Enter a **`sk-bf-` Virtual Key** at the auth prompt, or supply `BIFROST_API_KEY`
to the OpenClaw process through your normal secret management. No key belongs in
this repository. Stored profiles under `bifrost` are not reused; configure the
new provider deliberately. No per-model configuration is required.

The plugin id `bifrost` must have a single installed owner. This build replaces
the upstream community plugin if it was already installed; it does not replace
the user's manual provider configuration. Do not load a development directory
whose `node_modules` contains OpenClaw: the 2026.10.9 loader can report ambiguous
ownership of bundled public surfaces. Use the built archive instead.

## Verification and development

```sh
npm ci --ignore-scripts
npm run typecheck
npm test
npm run test:native
npm pack
```

`npm test` uses the real SDK HTTP client and loopback fixtures with dummy keys;
only the auth-storage lookup is mocked in unit tests. `test:native` stages a
copy of the built plugin without development dependencies and runs the actual
pinned CLI and actual SDK auth resolver. It uses temporary OpenClaw home,
config, agent and state directories, and fake env keys and stored profiles.
It never reads the normal OpenClaw config or changes an installed gateway.
Native logs are written to the printed temporary evidence directory.

## Limits

- Freshness is guaranteed **when these native hooks run**. OpenClaw owns picker
  and catalog caches; there is no push notification or background polling here.
  Use `models list --all --provider bifrost-live --refresh`, then reopen the
  picker. Previously selected/default/static references can remain visible as
  configuration, and legacy `bifrost` rows intentionally remain.
- OpenClaw model allowlists, `models.mode: replace`, disabled/untrusted plugins
  or a second plugin claiming the same id can prevent discovery/selection.
  They are not changed automatically.
- Existing runs are not cancelled. There is an unavoidable gap between checking
  `/v1/models` and inference; Bifrost must enforce its own permissions on every
  request. A server that ignores Virtual Keys or returns an unfiltered catalog
  cannot be corrected by this client.
- The adapter uses OpenAI chat completions, text input defaults, and metadata
  fallbacks of 128,000 context tokens / 8,192 output tokens / zero unknown cost.
  Embedding, audio, image-generation APIs, vision inference and full capability
  accuracy are not implemented or end-to-end tested by this change.
- Only modern `sk-bf-` keys via Bearer are supported. Legacy keys requiring
  `x-bf-vk`, separate gateway admin authentication, custom authorization headers,
  anonymous mode and redirects are deliberately unsupported.
- Environment changes in another shell do not update a running gateway process.
  Restart with the new environment. Config/SecretRef changes must first be
  resolved/reloaded by OpenClaw; its prepared credentials remain authoritative.
- Every discovery/preparation incurs HTTP latency; transient failures hide the
  live catalog and stop new prepared requests. Other OpenClaw versions,
  real Bifrost deployments, desktop UI refresh and actual LLM generation have
  not been validated in the user's environment.

See [audit](docs/AUDITORIA.md) and [test evidence](docs/PRUEBAS.md).
