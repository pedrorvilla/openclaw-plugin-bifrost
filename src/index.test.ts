import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";

// Only auth storage is mocked: tests never read the user's profiles or keys.
// Discovery uses the actual OpenClaw 2026.10.9 guarded HTTP implementation.
const { lookup } = vi.hoisted(() => ({ lookup: vi.fn() }));
vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({ resolveApiKeyForProvider: lookup }));
import entry from "./index.js";
import { DEFAULT_BASE_URL, projectBifrostModels, resolveDiscoveryUrl } from "./models.js";
import { discoverModels } from "./discovery.js";

const KEY_A = "sk-bf-fixture-a";
const KEY_B = "sk-bf-fixture-b";
const rows = [{ id: "vendor/a" }, { id: "vendor/b", context_length: 10000, max_output_tokens: 2000,
  normalized_name: "Model B", pricing: { prompt: "0.00000035", completion: "0.00000075" } }];

function registered() {
  const providers: ProviderPlugin[] = [];
  const warn = vi.fn();
  entry.register({ registerProvider: (p: ProviderPlugin) => providers.push(p), logger: { warn } } as unknown as OpenClawPluginApi);
  expect(providers).toHaveLength(1);
  return { provider: providers[0]!, warn };
}

function config(baseUrl: string, extra = {}) {
  return { plugins: { entries: { bifrost: { config: { baseUrl, ...extra } } } } };
}
function catalogCtx(baseUrl: string, key: string | undefined = KEY_A) {
  return { config: config(baseUrl), env: {}, providerIds: ["bifrost-live"],
    resolveProviderApiKey: vi.fn<() => { apiKey: string | undefined }>(() => ({ apiKey: key })) };
}
function runtimeCtx(baseUrl: string, modelId = "vendor/a") {
  return { config: config(baseUrl), provider: "bifrost-live", modelId, modelRegistry: {} as never,
    agentDir: "/isolated-test-agent", workspaceDir: "/isolated-test-workspace" };
}
async function catalog(provider: ProviderPlugin, ctx: unknown): Promise<any> {
  return provider.catalog!.run(ctx as never);
}
async function prepare(provider: ProviderPlugin, baseUrl: string, modelId = "vendor/a") {
  return provider.prepareDynamicModel!(runtimeCtx(baseUrl, modelId) as never);
}
async function authorize(provider: ProviderPlugin, baseUrl: string, key = KEY_A, modelId = "vendor/a") {
  return provider.prepareRuntimeAuth!({ ...runtimeCtx(baseUrl, modelId), apiKey: key, env: {}, authMode: "api-key",
    model: { id: modelId, provider: "bifrost-live", baseUrl, api: "openai-completions" } } as never);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
async function withGateway(run: (gateway: {
  baseUrl: string; calls: { url: string; authorization?: string }[]; setHandler: (handler: Handler) => void;
}) => Promise<void>) {
  let handler: Handler = (_req, res) => json(res, { data: rows });
  const calls: { url: string; authorization?: string }[] = [];
  const server = createServer((req, res) => {
    calls.push({ url: req.url ?? "", authorization: req.headers.authorization });
    handler(req, res);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try { await run({ baseUrl, calls, setHandler: (value) => { handler = value; } }); }
  finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); }
}
function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

beforeEach(() => { lookup.mockReset().mockResolvedValue({ apiKey: KEY_A }); });

describe("registration and projection", () => {
  it("registers the isolated live provider, preserving literal upstream ids", async () => {
    const { provider } = registered();
    expect(provider).toMatchObject({ id: "bifrost-live", preserveLiteralProviderPrefix: true, envVars: ["BIFROST_API_KEY"] });
    expect(provider.auth).toMatchObject([{ id: "api-key", kind: "api_key" }]);
    expect(await provider.staticCatalog!.run({} as never)).toEqual({ provider: { api: "openai-completions", baseUrl: DEFAULT_BASE_URL, models: [] } });
    expect(provider.resolveDynamicModel!(runtimeCtx(DEFAULT_BASE_URL) as never)).toBeNull();
  });
  it.each(["", "/", "/v1/", "/openai", "/openai/v1"])("normalizes route %s", (suffix) => {
    expect(resolveDiscoveryUrl(`https://gateway.example/prefix${suffix}`)).toBe("https://gateway.example/prefix/v1/models");
  });
  it.each(["file:///tmp/data", "https://user:secret@gateway/v1", "https://gateway/v1?q=secret", "https://gateway/v1#secret"])("rejects unsafe base URL %s", (url) => {
    expect(() => resolveDiscoveryUrl(url)).toThrow();
  });
  it("keeps all valid authorized ids without guessing capabilities from the name", () => {
    const result = projectBifrostModels([...rows, { id: "openai/text-embedding-3-small" }, { id: "vendor/guard-chat" },
      { id: "openai/whisper-1" }, { id: "vendor/a", context_length: 4000 }, { id: "bad\nid" }, {}, "bad"]);
    expect(result.map((m) => m.id)).toEqual(["openai/text-embedding-3-small", "openai/whisper-1", "vendor/a", "vendor/b", "vendor/guard-chat"]);
    expect(result.find((m) => m.id === "vendor/a")!.contextWindow).toBe(4000);
    expect(result.find((m) => m.id === "vendor/b")).toMatchObject({ name: "Model B", contextWindow: 10000, maxTokens: 2000,
      cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 } });
  });
  it("defaults missing metadata without inventing ids", () => {
    expect(projectBifrostModels([{ id: "vendor/a" }])[0]).toMatchObject({ input: ["text"], contextWindow: 128000, maxTokens: 8192 });
    expect(projectBifrostModels([{ id: "" }, { id: "x".repeat(513) }, null])).toEqual([]);
  });
});

describe("live discovery with real SDK HTTP", () => {
  it("uses /v1/models and the resolved discovery key, retaining only the host marker", async () => withGateway(async ({ baseUrl, calls }) => {
    const { provider } = registered();
    const ctx = { ...catalogCtx(baseUrl), resolveProviderApiKey: () => ({ apiKey: "BIFROST_API_KEY", discoveryApiKey: KEY_A }) };
    const result = await catalog(provider, ctx);
    expect(calls).toEqual([{ url: "/v1/models", authorization: `Bearer ${KEY_A}` }]);
    expect(result.provider.apiKey).toBe("BIFROST_API_KEY");
    expect(JSON.stringify(result)).not.toContain(KEY_A);
    expect(result.provider.models).toHaveLength(2);
  }));
  it("replaces additions, removals and an empty permission set immediately", async () => withGateway(async ({ baseUrl, setHandler }) => {
    const { provider } = registered(); const ctx = catalogCtx(baseUrl);
    expect((await catalog(provider, ctx)).provider.models).toHaveLength(2);
    setHandler((_req, res) => json(res, { data: [{ id: "vendor/c" }] }));
    expect((await catalog(provider, ctx)).provider.models.map((m: any) => m.id)).toEqual(["vendor/c"]);
    setHandler((_req, res) => json(res, { data: [] }));
    expect((await catalog(provider, ctx)).provider.models).toEqual([]);
    await expect(prepare(provider, baseUrl)).rejects.toThrow("not in the current Virtual Key catalog");
  }));
  it("rotates and removes keys without reusing a URL's previous key", async () => withGateway(async ({ baseUrl, calls, setHandler }) => {
    setHandler((req, res) => json(res, { data: [{ id: req.headers.authorization === `Bearer ${KEY_A}` ? "vendor/a" : "vendor/b" }] }));
    const { provider } = registered();
    expect((await catalog(provider, catalogCtx(baseUrl, KEY_A))).provider.models[0].id).toBe("vendor/a");
    expect((await catalog(provider, catalogCtx(baseUrl, KEY_B))).provider.models[0].id).toBe("vendor/b");
    const missing = catalogCtx(baseUrl); missing.resolveProviderApiKey.mockReturnValue({ apiKey: undefined });
    const result = await catalog(provider, missing);
    expect(result.provider.models).toEqual([]); expect(result.outcomes[0].status).toBe("auth-rejected");
    expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
  }));
  it("discards an in-flight catalog if its credential changes", async () => withGateway(async ({ baseUrl, setHandler, calls }) => {
    let key = KEY_A;
    setHandler((req, res) => { const old = req.headers.authorization === `Bearer ${KEY_A}`; key = KEY_B;
      json(res, { data: [{ id: old ? "vendor/a" : "vendor/b" }] }); });
    const { provider } = registered();
    const result = await catalog(provider, { ...catalogCtx(baseUrl), resolveProviderApiKey: () => ({ apiKey: key }) });
    expect(result.provider.models.map((m: any) => m.id)).toEqual(["vendor/b"]); expect(calls).toHaveLength(2);
  }));
  it("isolates concurrent catalogs for two credentials on one endpoint", async () => withGateway(async ({ baseUrl, setHandler }) => {
    setHandler((req, res) => json(res, { data: [{ id: req.headers.authorization === `Bearer ${KEY_A}` ? "vendor/a" : "vendor/b" }] }));
    const { provider } = registered();
    const [a, b] = await Promise.all([catalog(provider, catalogCtx(baseUrl, KEY_A)), catalog(provider, catalogCtx(baseUrl, KEY_B))]);
    expect(a.provider.models[0].id).toBe("vendor/a"); expect(b.provider.models[0].id).toBe("vendor/b");
  }));
  it.each([401, 403, 429, 500, 503])("clears prior results on HTTP %i without anonymous retry or response leakage", async (status) => withGateway(async ({ baseUrl, calls, setHandler }) => {
    const { provider, warn } = registered(); const ctx = catalogCtx(baseUrl);
    expect((await catalog(provider, ctx)).provider.models).toHaveLength(2);
    setHandler((_req, res) => json(res, { error: `secret ${KEY_A}` }, status));
    const result = await catalog(provider, ctx);
    expect(result.provider.models).toEqual([]);
    expect(result.outcomes[0].status).toBe(status === 401 || status === 403 ? "auth-rejected" : "unavailable");
    expect(calls).toHaveLength(2); expect(JSON.stringify(warn.mock.calls)).not.toContain(KEY_A);
    await expect(authorize(provider, baseUrl)).rejects.toThrow("Bifrost live:");
    setHandler((_req, res) => json(res, { data: rows }));
    expect((await catalog(provider, ctx)).provider.models).toHaveLength(2);
  }));
  it.each(["<html>dashboard</html>", "{broken", JSON.stringify({ models: rows }), JSON.stringify({ error: "bad" })])("rejects malformed envelope %s", async (body) => withGateway(async ({ baseUrl, setHandler }) => {
    setHandler((_req, res) => res.end(body));
    const result = await catalog(registered().provider, catalogCtx(baseUrl));
    expect(result.provider.models).toEqual([]); expect(result.outcomes[0].status).toBe("unavailable");
  }));
  it("times out a hung request and does not keep previous rows", async () => withGateway(async ({ baseUrl, setHandler }) => {
    const { provider } = registered(); const ctx = { ...catalogCtx(baseUrl), config: config(baseUrl, { timeoutMs: 100 }) };
    await catalog(provider, ctx); setHandler(() => {});
    const start = Date.now(); const result = await catalog(provider, ctx);
    expect(Date.now() - start).toBeLessThan(2000); expect(result.provider.models).toEqual([]);
  }));
  it("handles network disconnects", async () => withGateway(async ({ baseUrl, setHandler }) => {
    setHandler((req) => req.socket.destroy());
    expect((await catalog(registered().provider, catalogCtx(baseUrl))).provider.models).toEqual([]);
  }));
  it("joins all pages before publishing and rejects incomplete pagination", async () => withGateway(async ({ baseUrl, setHandler }) => {
    setHandler((req, res) => json(res, req.url?.includes("after=") ? { data: [{ id: "vendor/b" }] } : { data: [{ id: "vendor/a" }], has_more: true, next_cursor: "page2" }));
    const { provider } = registered(); const ctx = catalogCtx(baseUrl);
    expect((await catalog(provider, ctx)).provider.models.map((m: any) => m.id)).toEqual(["vendor/a", "vendor/b"]);
    setHandler((_req, res) => json(res, { data: [{ id: "vendor/a" }], has_more: true }));
    const result = await catalog(provider, ctx); expect(result.provider.models).toEqual([]); expect(result.outcomes[0].status).toBe("unavailable");
  }));
  it("rejects redirects instead of accepting an anonymous destination catalog", async () => withGateway(async ({ baseUrl, calls, setHandler }) => {
    setHandler((_req, res) => { res.writeHead(302, { Location: `${baseUrl}/redirected` }); res.end(); });
    const result = await catalog(registered().provider, catalogCtx(baseUrl));
    expect(result.provider.models).toEqual([]); expect(calls).toHaveLength(1);
  }));
  it("propagates cancellation without publishing a partial catalog", async () => withGateway(async ({ baseUrl }) => {
    const controller = new AbortController(); controller.abort();
    await expect(discoverModels({ baseUrl, apiKey: KEY_A, timeoutMs: 500, signal: controller.signal })).rejects.toThrow();
  }));
  it.each([undefined, "", "legacy-key", "BIFROST_API_KEY", "sk-bf-bad\nkey"])("never makes an anonymous request for invalid credential %s", async (key) => withGateway(async ({ baseUrl, calls }) => {
    await expect(discoverModels({ baseUrl, apiKey: key, timeoutMs: 500 })).rejects.toThrow("Virtual Key"); expect(calls).toHaveLength(0);
  }));
});

describe("runtime and safe coexistence", () => {
  it("re-resolves auth for every runtime discovery and honors a locked profile", async () => withGateway(async ({ baseUrl, calls, setHandler }) => {
    const { provider } = registered();
    expect(await prepare(provider, baseUrl)).toMatchObject({ id: "vendor/a", provider: "bifrost-live", contextTokens: 128000 });
    lookup.mockResolvedValue({ apiKey: KEY_B, profileId: "bifrost-live:rotated" });
    setHandler((_req, res) => json(res, { data: [{ id: "vendor/b" }] }));
    await expect(provider.prepareDynamicModel!({ ...runtimeCtx(baseUrl), authProfileId: "bifrost-live:rotated" } as never)).rejects.toThrow("not in the current");
    expect(lookup).toHaveBeenLastCalledWith(expect.objectContaining({ profileId: "bifrost-live:rotated", lockedProfile: true, secretSentinels: false }));
    expect(calls.map((c) => c.authorization)).toEqual([`Bearer ${KEY_A}`, `Bearer ${KEY_B}`]);
  }));
  it("rechecks the actual inference credential even if a registry row exists", async () => withGateway(async ({ baseUrl, calls, setHandler }) => {
    const { provider } = registered(); await prepare(provider, baseUrl);
    setHandler((req, res) => json(res, { data: req.headers.authorization === `Bearer ${KEY_B}` ? [] : rows }));
    await expect(authorize(provider, baseUrl, KEY_B)).rejects.toThrow("not in the current");
    expect(calls.at(-1)?.authorization).toBe(`Bearer ${KEY_B}`);
    expect(await authorize(provider, baseUrl, KEY_A)).toEqual({ apiKey: KEY_A, baseUrl });
  }));
  it("does not recover deleted auth from the catalog", async () => withGateway(async ({ baseUrl, calls }) => {
    const { provider } = registered(); await catalog(provider, catalogCtx(baseUrl)); lookup.mockResolvedValue({});
    await expect(prepare(provider, baseUrl)).rejects.toThrow("Virtual Key"); expect(calls).toHaveLength(1);
  }));
  it("fails closed on credential resolver errors", async () => withGateway(async ({ baseUrl, calls }) => {
    const { provider } = registered(); lookup.mockRejectedValue(new Error("auth unavailable"));
    await expect(prepare(provider, baseUrl)).rejects.toThrow(); expect(calls).toHaveLength(0);
  }));
  it("does not mutate or import a legacy static catalog or credential", async () => withGateway(async ({ baseUrl, calls }) => {
    const ctx = catalogCtx(baseUrl);
    const legacy = { models: { providers: { bifrost: { baseUrl, apiKey: "legacy-secret", headers: { "X-Existing": "keep" },
      models: [{ id: "vendor/revoked", name: "Legacy" }] }, other: { baseUrl: "https://other.invalid", models: [] } } } };
    ctx.config = { ...ctx.config, ...legacy }; const before = structuredClone(ctx.config);
    const { provider } = registered(); const result = await catalog(provider, ctx);
    expect(result.provider.models.map((m: any) => m.id)).toEqual(["vendor/a", "vendor/b"]);
    expect(ctx.config).toEqual(before); expect(JSON.stringify(result)).not.toContain("legacy-secret");
    expect(calls[0]?.authorization).toBe(`Bearer ${KEY_A}`);
  }));
  it("uses only the legacy URL as a fallback", async () => withGateway(async ({ baseUrl }) => {
    const result = await catalog(registered().provider, { ...catalogCtx(baseUrl), config: {
      models: { providers: { BIFROST: { baseUrl, models: [{ id: "vendor/stale" }] } } },
    } });
    expect(result.provider.baseUrl).toBe(baseUrl); expect(result.provider.models).toHaveLength(2);
  }));
  it.each([{ headers: { Authorization: "stale" } }, { authHeader: false }])("refuses live credential overrides %j", async (extra) => withGateway(async ({ baseUrl, calls }) => {
    const result = await catalog(registered().provider, { ...catalogCtx(baseUrl), config: { ...config(baseUrl),
      models: { providers: { "bifrost-live": { baseUrl, models: [], ...extra } } } } });
    expect(result.provider.models).toEqual([]); expect(calls).toHaveLength(0);
  }));
  it("bounds retries during constant credential churn", async () => withGateway(async ({ baseUrl, calls }) => {
    let n = 0;
    const result = await catalog(registered().provider, { ...catalogCtx(baseUrl),
      resolveProviderApiKey: () => ({ apiKey: n++ % 2 ? KEY_B : KEY_A }) });
    expect(result.provider.models).toEqual([]); expect(result.outcomes[0].status).toBe("unavailable");
    expect(calls).toHaveLength(3);
  }));
  it("retries with the new endpoint after a configuration change during I/O", async () => withGateway(async (first) => withGateway(async (second) => {
    const ctx = catalogCtx(first.baseUrl);
    first.setHandler((_req, res) => { ctx.config = config(second.baseUrl); json(res, { data: [{ id: "vendor/old" }] }); });
    second.setHandler((_req, res) => json(res, { data: [{ id: "vendor/new" }] }));
    const result = await catalog(registered().provider, ctx);
    expect(result.provider.baseUrl).toBe(second.baseUrl);
    expect(result.provider.models.map((m: any) => m.id)).toEqual(["vendor/new"]);
    expect(first.calls).toHaveLength(1); expect(second.calls).toHaveLength(1);
  })));
  it("rejects static rows in the live namespace", async () => withGateway(async ({ baseUrl, calls }) => {
    const ctx = { ...catalogCtx(baseUrl), config: { ...config(baseUrl), models: { providers: { "bifrost-live": {
      baseUrl, models: [{ id: "vendor/revoked" }],
    } } } } };
    const { provider, warn } = registered();
    expect((await catalog(provider, ctx)).provider.models).toEqual([]); expect(calls).toHaveLength(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("remove static models"));
    await expect(provider.prepareDynamicModel!({ ...runtimeCtx(baseUrl), config: ctx.config } as never)).rejects.toThrow("remove static models");
  }));
  it("refuses conflicting live endpoints before sending a key", async () => withGateway(async ({ baseUrl, calls }) => {
    const result = await catalog(registered().provider, { ...catalogCtx(baseUrl), config: { ...config(baseUrl),
      models: { providers: { "bifrost-live": { baseUrl: "https://different.invalid/v1", models: [] } } } } });
    expect(result.provider.models).toEqual([]); expect(calls).toHaveLength(0);
  }));
  it("does not send a key when inference points to a different gateway", async () => withGateway(async ({ baseUrl, calls }) => {
    const { provider } = registered();
    await expect(provider.prepareRuntimeAuth!({ ...runtimeCtx(baseUrl), apiKey: KEY_A,
      model: { baseUrl: "https://different.invalid/v1" }, env: {} } as never)).rejects.toThrow("route changed");
    expect(calls).toHaveLength(0);
  }));
  it("skips catalogs scoped to other providers", async () => {
    expect(await catalog(registered().provider, { providerIds: ["bifrost"], config: {} })).toBeNull();
  });
});
