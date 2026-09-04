import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type {
  OpenClawConfig,
  OpenClawPluginApi,
  ProviderCatalogContext,
  ProviderPlugin,
  ProviderPrepareDynamicModelContext,
  ProviderResolveDynamicModelContext,
  ProviderRuntimeModel,
} from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";
import {
  buildOpenAICompatibleLiveModelProviderConfig,
  getCachedLiveProviderModelRows,
} from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import type { BifrostModel, ModelProviderConfig } from "./models.js";
import {
  DEFAULT_BASE_URL,
  MODEL_DISCOVERY_TTL_MS,
  projectBifrostModels,
  readDiscoveredModel,
  rememberDiscoveredModels,
  resolveDiscoveryUrl,
} from "./models.js";

const PLUGIN_ID = "bifrost";
const PROVIDER_ID = PLUGIN_ID;

/** Reads the user's `models.providers.bifrost` overlay regardless of id casing. */
function findProviderOverlay(config: OpenClawConfig | undefined) {
  const providers = config?.models?.providers;
  if (!providers || typeof providers !== "object") return undefined;
  return Object.entries(providers).find(
    ([providerId]) => normalizeProviderId(providerId) === PROVIDER_ID,
  )?.[1];
}

/**
 * Reads the gateway base URL from this plugin's own config section.
 *
 * `models.providers.<id>` is the obvious home for a base URL, but OpenClaw's
 * config schema rejects an overlay for any provider outside a hardcoded set of
 * bundled ids ("custom model providers must declare models"), which a
 * third-party plugin can never join. The plugin's `configSchema` is not subject
 * to that rule, so it is the primary source; a hand-written provider overlay is
 * still honoured for anyone who already has one.
 */
function resolvePluginBaseUrl(config: OpenClawConfig | undefined): string | undefined {
  const value = config?.plugins?.entries?.[PLUGIN_ID]?.config?.baseUrl;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveBaseUrl(config: OpenClawConfig | undefined): string {
  const overlayBaseUrl = findProviderOverlay(config)?.baseUrl;
  return (
    resolvePluginBaseUrl(config) ??
    ((typeof overlayBaseUrl === "string" && overlayBaseUrl.trim()) || DEFAULT_BASE_URL)
  );
}

/**
 * Replicates the SDK's catalog scope check. `buildOpenAICompatibleProviderCatalog`
 * does this internally, but it also hard-requires an API key (see below), so the
 * check is reproduced here rather than inherited.
 */
function matchesCatalogScope(ctx: ProviderCatalogContext): boolean {
  const selected = ctx.providerIds;
  return selected === undefined || selected.includes(PROVIDER_ID);
}

function buildBifrostProvider(baseUrl: string): ModelProviderConfig {
  return {
    api: "openai-completions",
    baseUrl,
    models: [],
  };
}

/**
 * Patches the gateway base URL into the plugin's own config section during
 * non-interactive setup, rather than `models.providers.bifrost`, for the schema
 * reason described on `resolvePluginBaseUrl`.
 */
function applyBifrostConfig(config: OpenClawConfig, baseUrl?: string): OpenClawConfig {
  const normalized = baseUrl?.trim().replace(/\/+$/, "");
  if (!normalized) return config;
  const entries = config.plugins?.entries;
  return {
    ...config,
    plugins: {
      ...config.plugins,
      entries: {
        ...entries,
        [PLUGIN_ID]: {
          ...entries?.[PLUGIN_ID],
          config: { ...entries?.[PLUGIN_ID]?.config, baseUrl: normalized },
        },
      },
    },
  };
}

/**
 * API keys seen by the catalog run, keyed by gateway base URL.
 *
 * The dynamic-model hooks receive no credential resolver, so the key captured
 * during catalog discovery is reused when the cache has to be refreshed.
 */
const discoveryApiKeys = new Map<string, string>();

function resolveRuntimeBaseUrl(ctx: ProviderResolveDynamicModelContext): string {
  const configured = ctx.providerConfig?.baseUrl;
  return (typeof configured === "string" && configured.trim()) || resolveBaseUrl(ctx.config);
}

/** Projects a cached discovery row into the runner's model shape. */
function buildRuntimeModel(
  ctx: ProviderResolveDynamicModelContext,
): ProviderRuntimeModel | undefined {
  const baseUrl = resolveRuntimeBaseUrl(ctx);
  const model: BifrostModel | undefined = readDiscoveredModel(baseUrl, ctx.modelId);
  if (!model) return undefined;
  return {
    ...model,
    provider: PROVIDER_ID,
    api: "openai-completions",
    baseUrl,
    contextTokens: model.contextWindow,
  };
}

export function registerBifrost(api: OpenClawPluginApi): void {
  const apiKeyAuth = createProviderApiKeyAuthMethod({
    providerId: PROVIDER_ID,
    methodId: "api-key",
    label: "Bifrost virtual key",
    hint: "AI gateway fronting many LLM providers",
    optionKey: "bifrostApiKey",
    flagName: "--bifrost-api-key",
    envVar: "BIFROST_API_KEY",
    promptMessage: "Enter Bifrost virtual key",
    // No `defaultModel`: which models a gateway exposes is entirely deployment
    // specific, so any hardcoded starter ref would point at a missing model.
    expectedProviders: [PROVIDER_ID],
    noteTitle: "Bifrost",
    noteMessage: [
      "Bifrost is an AI gateway that fronts many providers behind one OpenAI-compatible API.",
      `Set the gateway base URL if it is not ${DEFAULT_BASE_URL}:`,
      "  openclaw config set plugins.entries.bifrost.config.baseUrl http://<host>:8080/openai/v1",
      "The virtual key is only required when 'Enable Auth on Inference' is on in Bifrost.",
    ].join("\n"),
    wizard: {
      choiceId: `${PROVIDER_ID}-api-key`,
      choiceLabel: "Bifrost virtual key",
      groupId: PROVIDER_ID,
      groupLabel: "Bifrost",
      groupHint: "AI gateway, OpenAI-compatible",
      methodId: "api-key",
    },
  });

  const provider: ProviderPlugin = {
    id: PROVIDER_ID,
    label: "Bifrost",
    envVars: ["BIFROST_API_KEY"],
    // Bifrost model ids are `<upstream vendor>/<model>`, so the leading segment
    // is a meaningful namespace rather than a duplicated provider prefix.
    preserveLiteralProviderPrefix: true,
    auth: [
      {
        ...apiKeyAuth,
        /**
         * `applyConfig` is invoked with the config alone, so it cannot see the
         * setup options. Non-interactive setup therefore patches the base URL in
         * before delegating, matching how the bundled LiteLLM plugin does it.
         */
        runNonInteractive: async (ctx) => {
          const runNonInteractive = apiKeyAuth.runNonInteractive;
          if (!runNonInteractive) return null;
          const customBaseUrl = ctx.opts.customBaseUrl;
          return await runNonInteractive({
            ...ctx,
            config: applyBifrostConfig(
              ctx.config,
              typeof customBaseUrl === "string" ? customBaseUrl : undefined,
            ),
          });
        },
      },
    ],
    catalog: {
      order: "simple",
      /**
       * Builds the live catalog from Bifrost's `/v1/models`.
       *
       * The SDK's `buildOpenAICompatibleProviderCatalog` is public and would fit,
       * but it delegates to `buildSingleProviderApiKeyCatalog`, which returns null
       * when no API key resolves. Bifrost runs with "Enable Auth on Inference" off
       * by default, so requiring a key would leave the provider empty on a stock
       * gateway. This calls the same public builder one layer down and passes the
       * key through only when there is one.
       */
      run: async (ctx: ProviderCatalogContext) => {
        if (!matchesCatalogScope(ctx)) return null;

        const baseUrl = resolveBaseUrl(ctx.config);
        const auth = ctx.resolveProviderApiKey(PROVIDER_ID) ?? {};

        const providerConfig = await buildOpenAICompatibleLiveModelProviderConfig({
          providerId: PROVIDER_ID,
          providerConfig: buildBifrostProvider(baseUrl),
          ...(auth.apiKey ? { apiKey: auth.apiKey } : {}),
          ...(auth.discoveryApiKey ? { discoveryApiKey: auth.discoveryApiKey } : {}),
          modelDiscovery: {
            endpointUrl: { url: resolveDiscoveryUrl(baseUrl), requireBaseUrl: baseUrl },
            ttlMs: MODEL_DISCOVERY_TTL_MS,
            projectRows: (rows) => projectBifrostModels(rows),
          },
        });

        if (auth.apiKey) discoveryApiKeys.set(baseUrl, auth.apiKey);
        rememberDiscoveredModels(baseUrl, providerConfig.models as BifrostModel[]);

        return { provider: providerConfig };
      },
    },
    staticCatalog: {
      order: "simple",
      run: async () => ({ provider: buildBifrostProvider(DEFAULT_BASE_URL) }),
    },
    /**
     * Supplies model metadata at request time.
     *
     * The catalog hook feeds listing surfaces, but the embedded runner resolves a
     * model through this hook. Without it OpenClaw falls back to generic defaults
     * (a 200k context and zero cost) for every Bifrost model.
     */
    resolveDynamicModel: (ctx: ProviderResolveDynamicModelContext) =>
      buildRuntimeModel(ctx) ?? null,
    /** Warms the discovery cache when the sync hook missed, then retries it. */
    prepareDynamicModel: async (ctx: ProviderPrepareDynamicModelContext) => {
      const cached = buildRuntimeModel(ctx);
      if (cached) return cached;
      const baseUrl = resolveRuntimeBaseUrl(ctx);
      try {
        const rows = await getCachedLiveProviderModelRows({
          providerId: PROVIDER_ID,
          endpoint: resolveDiscoveryUrl(baseUrl),
          ...(discoveryApiKeys.get(baseUrl) ? { apiKey: discoveryApiKeys.get(baseUrl) } : {}),
          ttlMs: MODEL_DISCOVERY_TTL_MS,
        });
        rememberDiscoveredModels(baseUrl, projectBifrostModels(rows));
      } catch {
        // Leave the model unresolved; OpenClaw falls through to its own handling.
        return;
      }
      return buildRuntimeModel(ctx) ?? undefined;
    },
  };

  api.registerProvider(provider);
}

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Bifrost",
  description: "Adds the Bifrost AI gateway to OpenClaw as a first-class provider with live model discovery.",
  register: registerBifrost,
});
