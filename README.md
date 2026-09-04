# openclaw-plugin-bifrost

An [OpenClaw](https://openclaw.ai) provider plugin for the [Bifrost](https://github.com/maximhq/bifrost)
AI gateway. It registers `bifrost` as a first-class provider with **live model
discovery**, so the models a gateway exposes never have to be typed into
OpenClaw's config by hand.

Requires OpenClaw `>= 2026.9.1`.

## What it does

- Discovers models from the gateway's `/v1/models` route at runtime.
- Maps Bifrost's metadata onto OpenClaw's model schema: `normalized_name` →
  model name, `context_length` → context window, `max_output_tokens` →
  max tokens, and per-token `pricing` → OpenClaw's per-million-token costs.
- Registers an API-key auth method (`BIFROST_API_KEY`) that appears in
  `openclaw onboard` and in the provider picker.
- Works against a gateway with `Enable Auth on Inference` off, and sends the
  virtual key as `Authorization: Bearer` once it is on.

## Install

```bash
openclaw plugins install <path-or-clawhub-spec> --accept-capabilities
openclaw gateway restart
```

## Configure

The gateway URL goes in the plugin's own config section:

```bash
openclaw config set plugins.entries.bifrost.config.baseUrl http://<host>:8080/v1
```

It defaults to `http://localhost:8080/v1`. Onboarding sets the same value
from `--custom-base-url`:

```bash
openclaw onboard --auth-choice bifrost-api-key \
  --bifrost-api-key <virtual-key> \
  --custom-base-url http://<host>:8080/v1
```

> **Why not `models.providers.bifrost.baseUrl`?** OpenClaw's config schema
> rejects a provider overlay for any id outside a hardcoded list of bundled
> providers (`custom model providers must declare models; provider overlays
> without models are only supported for bundled providers`), and a third-party
> plugin cannot join that list. A plugin's own `configSchema` is not subject to
> that rule. An existing hand-written overlay is still read as a fallback.

If the gateway requires auth, store the virtual key:

```bash
openclaw models auth paste-api-key --provider bifrost
# or: export BIFROST_API_KEY=<virtual-key>
```

## Use

```bash
openclaw models list --provider bifrost
openclaw agent --model bifrost/cerebras/gpt-oss-120b -m "say OK"
```

Bifrost model ids are already namespaced as `<vendor>/<model>`, so a full
OpenClaw reference has three segments: `bifrost/cerebras/gpt-oss-120b`.

## How it fits together

| Surface | Hook | Purpose |
|---|---|---|
| `openclaw models list` | `catalog.run` | Fetches and projects the live catalog |
| Provider picker before auth | `staticCatalog.run` | Offline row, no network |
| Every agent turn | `resolveDynamicModel` | Serves cached model metadata synchronously |
| First turn / cold cache | `prepareDynamicModel` | Refreshes discovery, then retries the sync hook |

The dynamic-model hooks are what carry context windows and pricing into a run.
Without them OpenClaw resolves Bifrost models with generic defaults (a 200k
context and zero cost).

### Model discovery endpoint

Bifrost's `/v1` routes are its own unified API surface, and `/v1/models` is the
only one carrying full model metadata. `/openai/*` is a separate OpenAI-shaped
passthrough namespace whose routes have no `/v1` segment; its `/openai/models`
answers `200` but omits `context_length` and `pricing`, and `/openai/v1/models`
answers `200` with the dashboard SPA. Discovery therefore normalizes any
configured base URL back to the gateway's `/v1/models`, so a deployment still
pointed at `/openai/v1` keeps full metadata.

### Public SDK surface only

The plugin imports only documented `openclaw/plugin-sdk/*` subpaths
(`plugin-entry`, `provider-auth`, `provider-catalog-live-runtime`,
`model-catalog-pricing`, `model-ref-parse`). It never imports the hashed
`dist/*-<hash>.js` chunks that the bundled plugins reference, since those names
change on every OpenClaw release. `src/openclaw-sdk.d.ts` supplies types for the
subpaths that ship without `.d.ts` files.

## Development

```bash
npm install
npm run build
npm test
npm run typecheck
```

Node must satisfy OpenClaw's engine range (`>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0`).

## First Publish

Install dependencies, log in to the ClawHub CLI, then validate and publish manually once:

```bash
npm install
npm exec clawhub -- login
npm run validate
npm exec clawhub -- package publish .
```

That first publish creates the ClawHub package and establishes the package managers who can configure trusted publishing.

## Trusted Publishing

After the first publish, configure GitHub Actions OIDC publishing for future releases:

```bash
npm exec clawhub -- package trusted-publisher set openclaw-plugin-bifrost \
  --repository <owner>/<repo> \
  --workflow-filename clawhub-publish.yml
```

Future release publishes can run through the manually dispatched `.github/workflows/clawhub-publish.yml` action without a long-lived ClawHub token. Run it first with `dry_run=true`, then rerun with `dry_run=false` after the preview is clean.
