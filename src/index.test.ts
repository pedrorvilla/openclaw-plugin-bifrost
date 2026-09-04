import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { beforeEach, describe, expect, it } from "vitest";
import type { OpenClawPluginApi, ProviderPlugin } from "openclaw/plugin-sdk/plugin-entry";
import entry from "./index.js";
import {
  DEFAULT_BASE_URL,
  clearDiscoveredModels,
  projectBifrostModels,
  resolveDiscoveryUrl,
} from "./models.js";

/** A trimmed capture of a real `GET http://<gateway>/v1/models` response. */
const BIFROST_ROWS = [
  {
    id: "cerebras/gemma-4-31b",
    normalized_name: "Gemma 4 31B",
    created: 0,
    context_length: 131072,
    max_input_tokens: 131072,
    max_output_tokens: 40960,
    pricing: { prompt: "0.0000009900", completion: "0.0000014900" },
    owned_by: "Cerebras",
  },
  {
    id: "cerebras/gpt-oss-120b",
    normalized_name: "Gpt Oss 120B",
    created: 0,
    context_length: 131072,
    max_input_tokens: 131072,
    max_output_tokens: 32768,
    pricing: { prompt: "0.0000003500", completion: "0.0000007500" },
    owned_by: "Cerebras",
  },
  // Real gateways return rows with no limits and no pricing at all.
  { id: "cerebras/qwen-3.8-27b", created: 0, owned_by: "Cerebras" },
];

function registerProviders(): ProviderPlugin[] {
  const providers: ProviderPlugin[] = [];
  const api = {
    registerProvider(provider: ProviderPlugin) {
      providers.push(provider);
    },
  } as Partial<OpenClawPluginApi>;
  entry.register(api as OpenClawPluginApi);
  return providers;
}

beforeEach(() => {
  clearDiscoveredModels();
});

describe("registration", () => {
  it("registers a single bifrost provider with API-key auth", () => {
    const providers = registerProviders();
    expect(providers.map((provider) => provider.id)).toEqual(["bifrost"]);
    expect(providers[0]?.label).toBe("Bifrost");
    expect(providers[0]?.envVars).toEqual(["BIFROST_API_KEY"]);
    expect(providers[0]?.auth).toMatchObject([{ id: "api-key", kind: "api_key" }]);
  });

  it("serves a static catalog without contacting the gateway", async () => {
    const provider = registerProviders()[0];
    await expect(provider?.staticCatalog?.run({} as never)).resolves.toEqual({
      provider: { api: "openai-completions", baseUrl: DEFAULT_BASE_URL, models: [] },
    });
  });
});

describe("resolveDiscoveryUrl", () => {
  it("appends models to the gateway's own /v1 surface", () => {
    expect(resolveDiscoveryUrl(DEFAULT_BASE_URL)).toBe("http://localhost:8080/v1/models");
    expect(resolveDiscoveryUrl("http://gateway:8080/v1")).toBe("http://gateway:8080/v1/models");
  });

  it("redirects the /openai passthrough namespace back to /v1", () => {
    // `/openai/models` drops pricing and context limits, and
    // `/openai/v1/models` answers 200 with the dashboard SPA.
    for (const baseUrl of ["http://gateway:8080/openai/v1", "http://gateway:8080/openai"]) {
      expect(resolveDiscoveryUrl(baseUrl)).toBe("http://gateway:8080/v1/models");
    }
  });

  it("tolerates trailing slashes and a bare gateway origin", () => {
    expect(resolveDiscoveryUrl("http://gateway:8080/openai/v1/")).toBe(
      "http://gateway:8080/v1/models",
    );
    expect(resolveDiscoveryUrl("http://gateway:8080")).toBe("http://gateway:8080/v1/models");
  });
});

describe("projectBifrostModels", () => {
  const models = projectBifrostModels(BIFROST_ROWS);

  it("keeps the provider-qualified id verbatim", () => {
    // OpenClaw resolves the full ref as bifrost/cerebras/gpt-oss-120b.
    expect(models.map((model) => model.id)).toEqual([
      "cerebras/gemma-4-31b",
      "cerebras/gpt-oss-120b",
      "cerebras/qwen-3.8-27b",
    ]);
  });

  it("converts per-token prices to USD per million tokens", () => {
    expect(models[1]).toMatchObject({
      name: "Gpt Oss 120B",
      cost: { input: 0.35, output: 0.75, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 131072,
      maxTokens: 32768,
    });
  });

  it("falls back to zero cost and default limits for rows without metadata", () => {
    expect(models[2]).toEqual({
      id: "cerebras/qwen-3.8-27b",
      name: "cerebras/qwen-3.8-27b",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 8192,
    });
  });

  it("infers reasoning from the model id", () => {
    expect(models.map((model) => model.reasoning)).toEqual([false, true, false]);
  });

  it("drops non-text models and unusable ids", () => {
    expect(
      projectBifrostModels([
        { id: "openai/text-embedding-3-small" },
        { id: "openai/whisper-1" },
        { id: "black-forest-labs/flux-1.1-pro" },
        { id: "bad\nid" },
        { id: "" },
        {},
        "not-a-row",
      ]),
    ).toEqual([]);
  });

  it("de-duplicates ids and sorts the catalog", () => {
    const projected = projectBifrostModels([
      { id: "z/model", context_length: 1000 },
      { id: "a/model", context_length: 1000 },
      { id: "z/model", context_length: 2000 },
    ]);
    expect(projected.map((model) => model.id)).toEqual(["a/model", "z/model"]);
    expect(projected[1]?.contextWindow).toBe(2000);
  });
});

describe("catalog", () => {
  /**
   * Discovery runs through the SDK's SSRF-guarded fetch, which does its own DNS
   * resolution, so these tests serve the fixture from a real loopback server
   * instead of stubbing `globalThis.fetch`.
   */
  async function withGateway(
    handler: (req: IncomingMessage, res: ServerResponse) => void,
    run: (baseUrl: string, calls: { url: string; authorization?: string }[]) => Promise<void>,
  ) {
    const calls: { url: string; authorization?: string }[] = [];
    const server = createServer((req, res) => {
      calls.push({ url: req.url ?? "", authorization: req.headers.authorization });
      handler(req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}/v1`, calls);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function serveModels(_req: IncomingMessage, res: ServerResponse) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: BIFROST_ROWS }));
  }

  function runCatalog(ctx: Record<string, unknown>) {
    const provider = registerProviders()[0];
    if (!provider?.catalog) throw new Error("bifrost provider registered no catalog");
    return provider.catalog.run(ctx as never) as Promise<any>;
  }

  /** Base URL configured the supported way: the plugin's own config section. */
  function catalogCtx(baseUrl: string | undefined, apiKey?: string) {
    return {
      providerIds: ["bifrost"],
      env: {},
      resolveProviderApiKey: () => (apiKey ? { apiKey } : {}),
      config: baseUrl
        ? { plugins: { entries: { bifrost: { config: { baseUrl } } } } }
        : {},
    };
  }

  it("skips work when the catalog is scoped to other providers", async () => {
    await expect(runCatalog({ providerIds: ["openai"], config: {} })).resolves.toBeNull();
  });

  it("discovers models unauthenticated when gateway auth is off", async () => {
    await withGateway(serveModels, async (baseUrl, calls) => {
      const result = await runCatalog(catalogCtx(baseUrl));
      // Discovery must hit the gateway root, not `{baseUrl}/v1/models`.
      expect(calls[0]?.url).toBe("/v1/models");
      expect(calls[0]?.authorization).toBeUndefined();
      expect(result.provider.apiKey).toBeUndefined();
      expect(result.provider.baseUrl).toBe(baseUrl);
      expect(result.provider.models.map((model: any) => model.id)).toEqual([
        "cerebras/gemma-4-31b",
        "cerebras/gpt-oss-120b",
        "cerebras/qwen-3.8-27b",
      ]);
      expect(result.provider.models[1]).toMatchObject({
        cost: { input: 0.35, output: 0.75 },
        contextWindow: 131072,
        maxTokens: 32768,
      });
    });
  });

  it("sends the virtual key as a bearer token and keeps it on the provider", async () => {
    await withGateway(serveModels, async (baseUrl, calls) => {
      const result = await runCatalog(catalogCtx(baseUrl, "bifrost-virtual-key"));
      expect(calls[0]?.authorization).toBe("Bearer bifrost-virtual-key");
      expect(result.provider.apiKey).toBe("bifrost-virtual-key");
    });
  });

  it("falls back to the default base URL when none is configured", async () => {
    const result = await runCatalog(catalogCtx(undefined));
    expect(result.provider.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it("still honours a hand-written models.providers.bifrost overlay", async () => {
    await withGateway(serveModels, async (baseUrl) => {
      const result = await runCatalog({
        providerIds: ["bifrost"],
        env: {},
        resolveProviderApiKey: () => ({}),
        config: { models: { providers: { BIFROST: { baseUrl, models: [] } } } },
      });
      expect(result.provider.baseUrl).toBe(baseUrl);
      expect(result.provider.models).toHaveLength(3);
    });
  });

  it("prefers the plugin config base URL over a provider overlay", async () => {
    await withGateway(serveModels, async (baseUrl) => {
      const result = await runCatalog({
        providerIds: ["bifrost"],
        env: {},
        resolveProviderApiKey: () => ({}),
        config: {
          plugins: { entries: { bifrost: { config: { baseUrl } } } },
          models: { providers: { bifrost: { baseUrl: "http://stale:1/v1", models: [] } } },
        },
      });
      expect(result.provider.baseUrl).toBe(baseUrl);
      expect(result.provider.models).toHaveLength(3);
    });
  });

  it("keeps the provider usable when discovery fails", async () => {
    await withGateway(
      (_req, res) => {
        res.writeHead(500);
        res.end("upstream unavailable");
      },
      async (baseUrl) => {
        const result = await runCatalog(catalogCtx(baseUrl));
        expect(result.provider).toMatchObject({ api: "openai-completions", baseUrl });
        expect(result.provider.models).toEqual([]);
      },
    );
  });
});

describe("runtime model resolution", () => {
  /**
   * OpenClaw resolves a model per request through these hooks rather than the
   * catalog, so without them every Bifrost model falls back to generic defaults.
   */
  async function withGateway(run: (baseUrl: string) => Promise<void>) {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: BIFROST_ROWS }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      await run(`http://127.0.0.1:${port}/v1`);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  }

  function runtimeCtx(baseUrl: string, modelId: string) {
    return {
      provider: "bifrost",
      modelId,
      providerConfig: { baseUrl },
      modelRegistry: {} as never,
      config: {},
    };
  }

  it("returns nothing before discovery has run", () => {
    const provider = registerProviders()[0];
    expect(
      provider?.resolveDynamicModel?.(runtimeCtx("http://cold:8080/v1", "a/b") as never),
    ).toBeNull();
  });

  it("prepares a model from the gateway, then serves it synchronously", async () => {
    await withGateway(async (baseUrl) => {
      const provider = registerProviders()[0];
      const ctx = runtimeCtx(baseUrl, "cerebras/gpt-oss-120b") as never;

      const prepared: any = await provider?.prepareDynamicModel?.(ctx);
      expect(prepared).toMatchObject({
        id: "cerebras/gpt-oss-120b",
        provider: "bifrost",
        api: "openai-completions",
        baseUrl,
        contextWindow: 131072,
        contextTokens: 131072,
        maxTokens: 32768,
        cost: { input: 0.35, output: 0.75 },
      });

      // The sync hook is what the runner calls on later turns.
      expect(provider?.resolveDynamicModel?.(ctx)).toMatchObject({
        id: "cerebras/gpt-oss-120b",
        contextTokens: 131072,
      });
    });
  });

  it("does not invent models the gateway never returned", async () => {
    await withGateway(async (baseUrl) => {
      const provider = registerProviders()[0];
      const ctx = runtimeCtx(baseUrl, "cerebras/does-not-exist") as never;
      await expect(provider?.prepareDynamicModel?.(ctx)).resolves.toBeUndefined();
      expect(provider?.resolveDynamicModel?.(ctx)).toBeNull();
    });
  });

  it("resolves without a reachable gateway once the catalog has run", async () => {
    let baseUrl = "";
    await withGateway(async (url) => {
      baseUrl = url;
      const provider = registerProviders()[0];
      await provider?.catalog?.run({
        providerIds: ["bifrost"],
        env: {},
        resolveProviderApiKey: () => ({}),
        config: { plugins: { entries: { bifrost: { config: { baseUrl } } } } },
      } as never);
    });
    // Gateway is down again here; the catalog run already cached the rows.
    const provider = registerProviders()[0];
    expect(
      provider?.resolveDynamicModel?.(runtimeCtx(baseUrl, "cerebras/gemma-4-31b") as never),
    ).toMatchObject({ id: "cerebras/gemma-4-31b", contextTokens: 131072 });
  });
});
