import type { ProviderCatalogResult } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOpenRouterModelPricing } from "openclaw/plugin-sdk/model-catalog-pricing";

/** OpenClaw does not export these config types by name; derive them from the catalog result. */
export type ModelProviderConfig = Extract<
  NonNullable<ProviderCatalogResult>,
  { provider: unknown }
>["provider"];
export type ModelDefinitionConfig = ModelProviderConfig["models"][number];

export const DEFAULT_BASE_URL = "http://localhost:8080/openai/v1";

/** Cache window for the live catalog, matching the SDK's own default. */
export const MODEL_DISCOVERY_TTL_MS = 60_000;

/** Fallbacks for Bifrost rows that omit limits (models with no upstream metadata). */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

/** Mirrors the SDK's reasoning inference so Bifrost rows without a flag still get it. */
const REASONING_MODEL_ID_PATTERN =
  /(?:^|[/_:.-])(?:reason(?:er|ing)?|thinking|deepseek-r1|o[134](?:-mini)?|gpt-5|gpt-oss)(?:$|[/_:.-])/i;

/** Bifrost proxies image/audio/embedding models too; keep the text catalog clean. */
const NON_TEXT_MODEL_ID_PATTERN =
  /(?:^|[/_:.-])(?:embed(?:ding)?|rerank(?:er)?|whisper|transcri(?:be|ption)|tts|speech|moderation|guard|gpt-image|dall-e|flux|sdxl|stable-diffusion|imagen|image-gen(?:eration)?|text-to-image|veo|sora|video-gen(?:eration)?|text-to-video)(?:$|[/_:.-])/i;

/**
 * Bifrost only fronts text models here, and the runtime model type accepts a
 * narrower input set than the catalog config type, so pin it.
 */
export type BifrostModel = ModelDefinitionConfig & { input: ("text" | "image")[] };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(record: Record<string, unknown> | undefined, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readPositiveInteger(
  record: Record<string, unknown> | undefined,
  keys: string[],
): number | undefined {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
  }
  return undefined;
}

/** Rejects ids carrying control characters, matching the SDK's own id guard. */
function isSafeModelId(value: string): boolean {
  if (!value || value.length > 512) return false;
  for (const char of value) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (codePoint <= 32 || codePoint === 127) return false;
  }
  return true;
}

/**
 * Bifrost exposes rich model metadata on its native `/v1/models` route only.
 * The OpenAI-compatible `{baseUrl}/models` mirror answers 200 but strips
 * `context_length` and `pricing`, and `{baseUrl}/v1/models` silently serves the
 * dashboard SPA — so the discovery URL is derived from the gateway root instead
 * of being appended to the base URL.
 */
export function resolveDiscoveryUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  const root = trimmed.replace(/\/openai(?:\/v\d+)?$/, "");
  return `${root}/v1/models`;
}

/** Projects one Bifrost `/v1/models` row into an OpenClaw catalog model. */
export function projectBifrostModel(row: unknown): BifrostModel | undefined {
  const record = asRecord(row);
  const id = readString(record, ["id", "model", "model_name"]);
  if (!record || !id || !isSafeModelId(id)) return undefined;
  if (NON_TEXT_MODEL_ID_PATTERN.test(id)) return undefined;

  const contextWindow =
    readPositiveInteger(record, ["context_length", "max_input_tokens"]) ?? FALLBACK_CONTEXT_WINDOW;
  const maxTokens =
    readPositiveInteger(record, ["max_output_tokens", "max_tokens"]) ??
    Math.min(contextWindow, FALLBACK_MAX_TOKENS);

  return {
    id,
    // Bifrost's human label lives in `normalized_name`, not the OpenAI `name`.
    name: readString(record, ["normalized_name", "display_name", "name"]) ?? id,
    reasoning: REASONING_MODEL_ID_PATTERN.test(id),
    input: ["text"],
    // Bifrost prices per token as strings, the same shape OpenRouter uses, so
    // the SDK normalizer converts them to OpenClaw's USD-per-million unit.
    cost: normalizeOpenRouterModelPricing(record.pricing) ?? { ...ZERO_COST },
    contextWindow,
    maxTokens,
  };
}

/** Projects a whole `/v1/models` payload, de-duplicated and ordered by id. */
export function projectBifrostModels(rows: unknown[]): BifrostModel[] {
  const models = rows
    .map((row) => projectBifrostModel(row))
    .filter((model): model is BifrostModel => Boolean(model));
  return [...new Map(models.map((model) => [model.id, model])).values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

/**
 * Models seen by the most recent discovery, keyed by gateway base URL.
 *
 * OpenClaw resolves a model at request time through `resolveDynamicModel`, a
 * synchronous hook, so the projected rows are kept here by the catalog run (and
 * refreshed by `prepareDynamicModel`) instead of being re-fetched inline.
 */
const discoveredModels = new Map<string, ReadonlyMap<string, BifrostModel>>();

export function rememberDiscoveredModels(
  baseUrl: string,
  models: readonly BifrostModel[],
): void {
  if (models.length === 0) return;
  discoveredModels.set(baseUrl, new Map(models.map((model) => [model.id, model])));
}

export function readDiscoveredModel(baseUrl: string, modelId: string): BifrostModel | undefined {
  return discoveredModels.get(baseUrl)?.get(modelId);
}

/** Test seam; discovery state is process-local and otherwise never cleared. */
export function clearDiscoveredModels(): void {
  discoveredModels.clear();
}
