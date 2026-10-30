import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { createProviderApiKeyAuthMethod } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/model-ref-parse";
import { DEFAULT_BASE_URL, resolveDiscoveryUrl } from "./models.js";
import { discoverModels, DiscoveryError, PROVIDER_ID } from "./discovery.js";
// Keep the upstream plugin id/config path; isolate its provider from the user's
// manually configured bifrost provider. OpenClaw merges explicit rows additively.
const PLUGIN_ID = "bifrost";
function findOverlay(config, id) {
    const providers = config?.models?.providers;
    if (!providers)
        return undefined;
    return providers[id] ?? Object.entries(providers).find(([key]) => normalizeProviderId(key) === id)?.[1];
}
function settings(config) {
    const plugin = config?.plugins?.entries?.[PLUGIN_ID]?.config;
    const overlay = findOverlay(config, PROVIDER_ID);
    // The live namespace must remain authoritative. Refuse static pins instead of
    // pretending a plugin can remove explicit rows from OpenClaw's merge pipeline.
    if (overlay?.models?.length) {
        throw new DiscoveryError("unavailable", "remove static models from models.providers.bifrost-live; keep legacy rows under bifrost");
    }
    if (overlay?.authHeader === false || Object.keys(overlay?.headers ?? {}).some((key) => /^(authorization|x-bf-vk|x-api-key|api-key|x-goog-api-key)$/i.test(key))) {
        throw new DiscoveryError("unavailable", "credential header overrides are unsupported for bifrost-live");
    }
    const configured = typeof plugin?.baseUrl === "string" ? plugin.baseUrl.trim() : undefined;
    if (configured && overlay?.baseUrl && resolveDiscoveryUrl(configured) !== resolveDiscoveryUrl(overlay.baseUrl)) {
        throw new DiscoveryError("unavailable", "conflicting bifrost-live and plugin base URLs");
    }
    const baseUrl = configured || overlay?.baseUrl || findOverlay(config, "bifrost")?.baseUrl || DEFAULT_BASE_URL;
    // Normalize both inference and discovery to the unified /v1 API. This does not
    // change the legacy provider's URL, headers, credentials or models.
    const endpoint = resolveDiscoveryUrl(baseUrl);
    const timeoutMs = plugin?.timeoutMs ?? 5000;
    if (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
        throw new DiscoveryError("unavailable", "timeoutMs must be an integer from 100 to 30000");
    }
    return { baseUrl: endpoint.slice(0, -"/models".length), timeoutMs };
}
function providerConfig(baseUrl, models = [], apiKey) {
    return { api: "openai-completions", baseUrl, models, ...(apiKey ? { apiKey } : {}) };
}
function runtimeModel(model, baseUrl) {
    return { ...model, provider: PROVIDER_ID, api: "openai-completions", baseUrl, contextTokens: model.contextWindow };
}
function requestedModel(models, id, baseUrl) {
    const model = models.find((candidate) => candidate.id === id);
    // Returning undefined permits OpenClaw's generic provider fallback. Throw to
    // prevent an absent/revoked id from becoming an invented executable model.
    if (!model)
        throw new DiscoveryError("auth-rejected", "requested model is not in the current Virtual Key catalog");
    return runtimeModel(model, baseUrl);
}
export function registerBifrost(api) {
    const apiKeyAuth = createProviderApiKeyAuthMethod({
        providerId: PROVIDER_ID, methodId: "api-key", label: "Bifrost live Virtual Key",
        hint: "Discover the current Virtual Key's model catalog", optionKey: "bifrostApiKey",
        flagName: "--bifrost-api-key", envVar: "BIFROST_API_KEY",
        promptMessage: "Enter Bifrost Virtual Key (sk-bf-...)", expectedProviders: [PROVIDER_ID],
        noteTitle: "Bifrost live",
        noteMessage: "Set plugins.entries.bifrost.config.baseUrl. Existing bifrost model references remain separate.",
        wizard: {
            choiceId: "bifrost-live-api-key", choiceLabel: "Bifrost live Virtual Key",
            groupId: PROVIDER_ID, groupLabel: "Bifrost live", groupHint: "Bifrost live discovery", methodId: "api-key",
        },
    });
    const runCatalog = async (ctx) => {
        if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER_ID))
            return null;
        let baseUrl = DEFAULT_BASE_URL;
        let profileId;
        try {
            // Re-resolve after I/O so a rotated credential cannot publish the preceding
            // account's result. Bounded retries also handle rapid credential churn.
            for (let attempt = 0; attempt < 3; attempt++) {
                const current = settings(ctx.config);
                baseUrl = current.baseUrl;
                const auth = ctx.resolveProviderApiKey(PROVIDER_ID);
                profileId = auth.profileId;
                const key = auth.discoveryApiKey ?? auth.apiKey;
                const models = await discoverModels({ ...current, apiKey: key, signal: ctx.signal });
                const latest = ctx.resolveProviderApiKey(PROVIDER_ID);
                if (key !== (latest.discoveryApiKey ?? latest.apiKey) || profileId !== latest.profileId ||
                    baseUrl !== settings(ctx.config).baseUrl)
                    continue;
                return {
                    // apiKey is the host's marker, not the resolved discovery secret.
                    provider: providerConfig(baseUrl, models, latest.apiKey),
                    outcomes: [{ provider: PROVIDER_ID, profileId, status: "ready", listedModelIds: models.map((m) => m.id) }],
                };
            }
            throw new DiscoveryError("unavailable", "credentials changed repeatedly during discovery");
        }
        catch (error) {
            const status = error instanceof DiscoveryError ? error.status : "unavailable";
            api.logger?.warn(error instanceof DiscoveryError ? error.message : "Bifrost live: invalid configuration or credential resolution failure");
            return {
                provider: providerConfig(baseUrl),
                outcomes: [{ provider: PROVIDER_ID, profileId, status,
                        ...(status === "auth-rejected" ? { rejectionScope: "catalog" } : {}) }],
            };
        }
    };
    const provider = {
        id: PROVIDER_ID, label: "Bifrost live", envVars: ["BIFROST_API_KEY"],
        preserveLiteralProviderPrefix: true,
        auth: [apiKeyAuth],
        catalog: { order: "simple", run: runCatalog },
        staticCatalog: { order: "simple", run: async () => ({ provider: providerConfig(DEFAULT_BASE_URL) }) },
        preferRuntimeResolvedModel: () => true,
        // No synchronous model cache can establish that a credential is still current.
        resolveDynamicModel: () => null,
        prepareDynamicModel: async (ctx) => {
            const lookup = async () => {
                try {
                    return await resolveApiKeyForProvider({
                        provider: PROVIDER_ID, cfg: ctx.config, agentDir: ctx.agentDir,
                        workspaceDir: ctx.workspaceDir, profileId: ctx.authProfileId,
                        lockedProfile: Boolean(ctx.authProfileId), secretSentinels: false,
                    });
                }
                catch {
                    throw new DiscoveryError("auth-rejected", "current Virtual Key could not be resolved");
                }
            };
            for (let attempt = 0; attempt < 3; attempt++) {
                const current = settings(ctx.config);
                const auth = await lookup();
                const models = await discoverModels({ ...current, apiKey: auth.apiKey });
                const latest = await lookup();
                if (auth.apiKey !== latest.apiKey || auth.profileId !== latest.profileId ||
                    current.baseUrl !== settings(ctx.config).baseUrl)
                    continue;
                return requestedModel(models, ctx.modelId, current.baseUrl);
            }
            throw new DiscoveryError("unavailable", "credentials changed repeatedly during model resolution");
        },
        // This receives the credential actually selected for inference, including
        // profile rotation/failover. Recheck even when core supplied a registry row.
        prepareRuntimeAuth: async (ctx) => {
            const current = settings(ctx.config);
            const modelEndpoint = resolveDiscoveryUrl(ctx.model.baseUrl);
            if (modelEndpoint !== resolveDiscoveryUrl(current.baseUrl)) {
                throw new DiscoveryError("unavailable", "inference route changed; refresh model selection");
            }
            const models = await discoverModels({ ...current, apiKey: ctx.apiKey });
            requestedModel(models, ctx.modelId, current.baseUrl);
            return { apiKey: ctx.apiKey, baseUrl: current.baseUrl };
        },
    };
    api.registerProvider(provider);
}
export default definePluginEntry({
    id: PLUGIN_ID, name: "Bifrost live discovery",
    description: "Virtual Key scoped live discovery under bifrost-live, isolated from static bifrost config.",
    register: registerBifrost,
});
