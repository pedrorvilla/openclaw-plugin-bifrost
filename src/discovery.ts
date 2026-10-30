import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { projectBifrostModels, resolveDiscoveryUrl } from "./models.js";

export const PROVIDER_ID = "bifrost-live";

export class DiscoveryError extends Error {
  constructor(public readonly status: "auth-rejected" | "unavailable", message: string) {
    super(`Bifrost live: ${message}`);
  }
}

export function requireVirtualKey(value: string | undefined): string {
  const key = value?.trim();
  // Bifrost accepts Bearer virtual keys only with this prefix. Legacy keys need
  // x-bf-vk and may otherwise silently become an anonymous, broader listing.
  if (!key || isNonSecretApiKeyMarker(key) || !/^sk-bf-[^\s\x00-\x1f\x7f]+$/.test(key)) {
    throw new DiscoveryError("auth-rejected", "a current sk-bf- Virtual Key is required");
  }
  return key;
}

/** No process cache, retained credentials, anonymous retry or stale fallback. */
export async function discoverModels(params: {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const apiKey = requireVirtualKey(params.apiKey);
  try {
    const rows = await fetchLiveProviderModelRows({
      providerId: PROVIDER_ID,
      endpoint: resolveDiscoveryUrl(params.baseUrl),
      apiKey,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      // A cross-origin redirect strips Bearer auth in the SDK. Accepting the
      // destination's anonymous catalog would misrepresent key permissions.
      fetchGuard: (request) => fetchWithSsrFGuard({ ...request, maxRedirects: 0 }),
      buildRequestHeaders: () => ({ Authorization: `Bearer ${apiKey}`, "Cache-Control": "no-cache" }),
      readRows: (body) => {
        if (!body || typeof body !== "object" || !Array.isArray((body as { data?: unknown }).data)) {
          throw new Error("Invalid models envelope");
        }
        return (body as { data: unknown[] }).data;
      },
    });
    return projectBifrostModels(rows);
  } catch (error) {
    // SDK/network errors can contain URLs or response text. Do not expose them
    // (or attach a cause) to host logs, the catalog or the user.
    const status = error && typeof error === "object" && "status" in error ? error.status : undefined;
    throw new DiscoveryError(
      status === 401 || status === 403 ? "auth-rejected" : "unavailable",
      status === 401 || status === 403
        ? "Virtual Key rejected; no models published"
        : "model discovery failed; no models published",
    );
  }
}
