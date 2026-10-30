import { normalizeOpenRouterModelPricing } from "openclaw/plugin-sdk/model-catalog-pricing";
/**
 * Bifrost's own unified API surface. `/openai/*` is a separate OpenAI-shaped
 * passthrough namespace whose routes carry no `/v1` segment, and its model list
 * is stripped of pricing and context limits, so `/v1` is the route to target.
 */
export const DEFAULT_BASE_URL = "http://localhost:8080/v1";
/** Fallbacks for Bifrost rows that omit limits (models with no upstream metadata). */
const FALLBACK_CONTEXT_WINDOW = 128_000;
const FALLBACK_MAX_TOKENS = 8_192;
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
/** Mirrors the SDK's reasoning inference so Bifrost rows without a flag still get it. */
const REASONING_MODEL_ID_PATTERN = /(?:^|[/_:.-])(?:reason(?:er|ing)?|thinking|deepseek-r1|o[134](?:-mini)?|gpt-5|gpt-oss)(?:$|[/_:.-])/i;
function asRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? value
        : undefined;
}
function readString(record, keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === "string" && value.trim())
            return value.trim();
    }
    return undefined;
}
function readPositiveInteger(record, keys) {
    for (const key of keys) {
        const value = record?.[key];
        if (typeof value === "number" && Number.isSafeInteger(value) && value > 0)
            return value;
    }
    return undefined;
}
/** Rejects ids carrying control characters, matching the SDK's own id guard. */
function isSafeModelId(value) {
    if (!value || value.length > 512)
        return false;
    for (const char of value) {
        const codePoint = char.codePointAt(0) ?? 0;
        if (codePoint <= 32 || codePoint === 127)
            return false;
    }
    return true;
}
/**
 * Resolves discovery to the gateway's `/v1/models` route from any Bifrost base
 * URL, rather than appending a path to the configured one.
 *
 * Rich model metadata lives only on `/v1/models`. Someone pointed at the
 * `/openai` passthrough namespace instead would otherwise get `/openai/models`,
 * which answers 200 but omits `context_length` and `pricing`, or
 * `/openai/v1/models`, which answers 200 with the dashboard SPA.
 */
export function resolveDiscoveryUrl(baseUrl) {
    const url = new URL(baseUrl.trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error("Bifrost baseUrl must be an HTTP(S) URL without credentials, query or fragment");
    }
    const root = url.pathname.replace(/\/+$/, "").replace(/(?:\/openai)?(?:\/v\d+)?$/, "");
    url.pathname = `${root}/v1/models`;
    return url.toString();
}
/** Projects one Bifrost `/v1/models` row into an OpenClaw catalog model. */
export function projectBifrostModel(row) {
    const record = asRecord(row);
    const id = readString(record, ["id", "model", "model_name"]);
    if (!record || !id || !isSafeModelId(id))
        return undefined;
    const contextWindow = readPositiveInteger(record, ["context_length", "max_input_tokens"]) ?? FALLBACK_CONTEXT_WINDOW;
    const maxTokens = readPositiveInteger(record, ["max_output_tokens", "max_tokens"]) ??
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
export function projectBifrostModels(rows) {
    const models = rows
        .map((row) => projectBifrostModel(row))
        .filter((model) => Boolean(model));
    return [...new Map(models.map((model) => [model.id, model])).values()].sort((left, right) => left.id.localeCompare(right.id));
}
