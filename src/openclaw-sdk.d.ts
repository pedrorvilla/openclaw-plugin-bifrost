/**
 * Ambient declarations for the OpenClaw plugin SDK subpaths this plugin uses
 * that ship JavaScript without `.d.ts` files.
 *
 * Every module declared here is a public `exports` subpath of the `openclaw`
 * package (verified against OpenClaw 2026.10.9). They are stable re-export
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

  export function isNonSecretApiKeyMarker(value: string): boolean;

  export function createProviderApiKeyAuthMethod(
    params: Record<string, unknown>,
  ): ProviderAuthMethod;
}

declare module "openclaw/plugin-sdk/provider-catalog-live-runtime" {
  import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
  export function fetchLiveProviderModelRows(params: {
    providerId: string;
    endpoint: string;
    apiKey?: string;
    fetchGuard?: typeof fetchWithSsrFGuard;
    timeoutMs?: number;
    signal?: AbortSignal;
    readRows?: (body: unknown) => readonly unknown[];
    buildRequestHeaders?: (ctx: { apiKey?: string; discoveryApiKey?: string }) => HeadersInit;
  }): Promise<unknown[]>;
}

declare module "openclaw/plugin-sdk/provider-auth-runtime" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/plugin-entry";
  export function resolveApiKeyForProvider(params: {
    provider: string;
    cfg?: OpenClawConfig;
    agentDir?: string;
    workspaceDir?: string;
    profileId?: string;
    lockedProfile?: boolean;
    secretSentinels?: boolean;
  }): Promise<{ apiKey?: string; profileId?: string }>;
}
