/**
 * Ambient declarations for the OpenClaw plugin SDK subpaths this plugin uses
 * that ship JavaScript without `.d.ts` files.
 *
 * Every module declared here is a public `exports` subpath of the `openclaw`
 * package (verified against OpenClaw 2026.9.1). They are stable re-export
 * shims; the hashed `dist/*-<hash>.js` chunks they forward to are build
 * artifacts and must never be imported directly.
 */

declare module "openclaw/plugin-sdk/model-ref-parse" {
  export function normalizeProviderId(value: string): string;
  export function parseModelRef(ref: string): { provider?: string; model: string };
}

declare module "openclaw/plugin-sdk/model-catalog-pricing" {
  export type ModelCost = {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };

  /**
   * Reads OpenRouter-shaped per-token prices (`prompt` / `completion`) and
   * returns OpenClaw costs in USD per million tokens.
   */
  export function normalizeOpenRouterModelPricing(value: unknown): ModelCost | undefined;
}

declare module "openclaw/plugin-sdk/provider-auth" {
  import type { ProviderAuthMethod } from "openclaw/plugin-sdk/plugin-entry";

  export function createProviderApiKeyAuthMethod(
    params: Record<string, unknown>,
  ): ProviderAuthMethod;
}

declare module "openclaw/plugin-sdk/provider-catalog-live-runtime" {
  import type {
    ProviderCatalogContext,
    ProviderCatalogResult,
  } from "openclaw/plugin-sdk/plugin-entry";

  type ModelProviderConfig = Extract<
    NonNullable<ProviderCatalogResult>,
    { provider: unknown }
  >["provider"];
  type ModelDefinitionConfig = ModelProviderConfig["models"][number];

  export type LiveModelDiscovery = {
    /** Appended to the provider base URL. Mutually exclusive with `endpointUrl`. */
    endpointPath?: string;
    /** Absolute discovery URL, used only when the base URL still matches. */
    endpointUrl?: { url: string; requireBaseUrl: string };
    timeoutMs?: number;
    ttlMs?: number;
    readRows?: (body: unknown) => unknown[];
    buildRequestHeaders?: (ctx: {
      apiKey?: string;
      discoveryApiKey?: string;
    }) => Record<string, string>;
    projectRows?: (
      rows: unknown[],
      fallback: ModelProviderConfig,
    ) => readonly ModelDefinitionConfig[];
    acceptUnknownModel?: (params: { id: string; record: unknown }) => boolean;
  };

  /**
   * Merges a live `/models` catalog into a provider config, falling back to the
   * given config untouched when discovery fails.
   */
  export function buildOpenAICompatibleLiveModelProviderConfig(params: {
    providerId: string;
    providerConfig: ModelProviderConfig;
    apiKey?: string;
    discoveryApiKey?: string;
    modelDiscovery?: LiveModelDiscovery;
    signal?: AbortSignal;
  }): Promise<ModelProviderConfig>;

  /** Fetches and caches the raw `/models` rows for one discovery endpoint. */
  export function getCachedLiveProviderModelRows(params: {
    providerId: string;
    endpoint: string;
    apiKey?: string;
    discoveryApiKey?: string;
    ttlMs?: number;
    timeoutMs?: number;
    cacheKeyParts?: readonly string[];
    readRows?: (body: unknown) => unknown[];
    buildRequestHeaders?: (ctx: {
      apiKey?: string;
      discoveryApiKey?: string;
    }) => Record<string, string>;
    signal?: AbortSignal;
  }): Promise<unknown[]>;

  /** Requires a resolvable API key; returns null without one. */
  export function buildOpenAICompatibleProviderCatalog(params: {
    ctx: ProviderCatalogContext;
    providerId: string;
    providerAliases?: string[];
    buildProvider: () => ModelProviderConfig | Promise<ModelProviderConfig>;
    allowExplicitBaseUrl?: boolean;
    modelDiscovery?: LiveModelDiscovery;
  }): Promise<{ provider: ModelProviderConfig } | null>;
}
