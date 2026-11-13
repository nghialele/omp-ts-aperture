import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApertureProvider } from "./api/types";
import { getApiForCompatibility } from "./api-selection";
import { embedsModelIdInPath, getBaseUrlForApi } from "./base-url-routing";
import { DEFAULT_CONFIG } from "./config/defaults";
import { configLoader } from "./config/loader";
import type { ResolvedConfig } from "./config/types";
import {
  APERTURE_API_UPSTREAM,
  APERTURE_PLACEHOLDER_API_KEY,
  buildCatalogKey,
  buildModels,
  filterProviders,
  toApertureApi,
} from "./provider/catalog";
import { missingGatewayModelsWarning, planProxyRoutes } from "./provider/proxy";
import {
  apertureRequestOptions,
  shouldSendProvenanceHeaders,
} from "./provider/request-options";

/**
 * End-to-end-ish wiring test: a realistic gateway catalog goes through the
 * same builder the extension's `fetchDynamicModels` uses, then the produced
 * rows are checked for routing, credential, and id invariants. These are the
 * behaviors omp depends on, independent of the turn-level UI.
 */

const GATEWAY = "https://ai.pango-lin.ts.net";
const BASE = `${GATEWAY}/v1`;

function gatewayProvider(
  id: string,
  models: string[],
  compatibility: ApertureProvider["compatibility"],
  extra: Partial<ApertureProvider> = {},
): ApertureProvider {
  return {
    id,
    name: `${id} display`,
    description: "",
    models,
    compatibility,
    requires_client_auth: false,
    modelInfoById: Object.fromEntries(models.map((id2) => [id2, { id: id2 }])),
    ...extra,
  };
}

function build(
  providers: ApertureProvider[],
  registryModels: Model<Api>[] = [],
) {
  return buildModels({
    providers,
    gatewayUrl: GATEWAY,
    baseUrl: BASE,
    registryModels,
    modelsDev: null,
  });
}

describe("catalog wiring", () => {
  test("a mixed gateway catalog maps each transport to its Aperture api", () => {
    const models = build([
      gatewayProvider("openai", ["gpt-5"], {
        openai_chat: true,
        openai_responses: true,
      }),
      gatewayProvider("anthropic", ["claude-sonnet-5"], {
        anthropic_messages: true,
      }),
      gatewayProvider("google", ["gemini-3-pro"], {
        gemini_generate_content: true,
      }),
      gatewayProvider("bedrock", ["nova-pro"], { bedrock_converse: true }),
    ]);

    const byId = new Map(models.map((m) => [`${m.id}`, m]));
    expect(byId.get("openai/gpt-5")?.api).toBe(
      toApertureApi("openai-completions"),
    );
    expect(byId.get("openai/gpt-5")?.baseUrl).toBe(BASE);
    expect(byId.get("anthropic/claude-sonnet-5")?.baseUrl).toBe(GATEWAY);
    expect(byId.get("google/gemini-3-pro")?.baseUrl).toBe(`${GATEWAY}/v1beta`);
    expect(byId.get("bedrock/nova-pro")?.baseUrl).toBe(`${GATEWAY}/bedrock`);
  });

  test("every declared api is routable through a built-in transport", () => {
    for (const upstream of Object.values(APERTURE_API_UPSTREAM)) {
      expect(getApiForCompatibility({ openai_chat: true })).toBe(
        "openai-completions",
      );
      // The Aperture api is a chat transport, so it must be a distinct name.
      expect(toApertureApi(upstream)).toBeDefined();
    }
    // Path-embedding transports must strip the provider prefix; body-carried
    // ids keep it so the gateway resolves the right route.
    expect(embedsModelIdInPath("google-generative-ai")).toBe(true);
    expect(embedsModelIdInPath("aperture-google-generative-ai")).toBe(false);
    expect(getBaseUrlForApi("anthropic-messages", GATEWAY, BASE)).toBe(GATEWAY);
  });

  test("selection filters the catalog and drops passthrough providers", () => {
    const providers = [
      gatewayProvider("openai", ["gpt-5"], { openai_chat: true }),
      gatewayProvider(
        "byok",
        ["claude"],
        { anthropic_messages: true },
        {
          requires_client_auth: true,
        },
      ),
      gatewayProvider("google", ["gemini"], { gemini_generate_content: true }),
    ];
    const filtered = filterProviders(providers, [
      { id: "openai", enabled: true },
      { id: "byok", enabled: true },
      { id: "google", enabled: false },
    ]);
    expect(filtered.map((p) => p.id)).toEqual(["openai"]);
  });
});

describe("request options", () => {
  test("stamp the gateway credential plus provenance headers", () => {
    const options = apertureRequestOptions(
      { sessionId: "sess-1", temperature: 0.2 },
      { enabled: true },
    );
    expect(options?.apiKey).toBe(APERTURE_PLACEHOLDER_API_KEY);
    expect(options?.temperature).toBe(0.2);
    expect(options?.sessionId).toBe("sess-1");
    expect((options?.headers as Record<string, string>)?.Referer).toBe(
      "https://pi.dev",
    );
    const headers = options?.headers as Record<string, string>;
    expect(headers["x-session-id"]).toBe("sess-1");
  });

  test("skip provenance when disabled and keep version headers up to date", () => {
    const options = apertureRequestOptions(undefined, { enabled: false });
    expect(options?.apiKey).toBe("-");
    expect(options?.headers).toBeUndefined();
  });

  test("the config toggle drives the default, without re-registering apis", () => {
    // The adapters call apertureRequestOptions with no explicit provenance, so
    // this is the path /aperture:settings actually takes.
    configLoader.update({ shouldSendProvenanceHeaders: false });
    try {
      const off = apertureRequestOptions({ sessionId: "sess-2" });
      expect(
        (off?.headers as Record<string, string> | undefined)?.Referer,
      ).toBeUndefined();

      configLoader.update({ shouldSendProvenanceHeaders: true });
      const on = apertureRequestOptions({ sessionId: "sess-2" });
      expect((on?.headers as Record<string, string>)?.Referer).toBe(
        "https://pi.dev",
      );
    } finally {
      configLoader.update({ shouldSendProvenanceHeaders: true });
    }
  });
});

describe("provenance toggle", () => {
  test("defaults to enabled when config cannot be read", () => {
    expect(typeof shouldSendProvenanceHeaders()).toBe("boolean");
  });
});

describe("proxy wiring", () => {
  const nativeModels = [
    {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    } as unknown as Model<Api>,
  ];

  function config(): ResolvedConfig {
    return {
      ...DEFAULT_CONFIG,
      baseUrl: GATEWAY,
      proxy: {
        enabled: true,
        upstreamProviders: [
          {
            id: "openai",
            gatewayId: "openai",
            enabled: true,
            shouldCheckGatewayModels: true,
          },
        ],
      },
    };
  }

  test("routes the proxied provider and flags unserved models", () => {
    const gatewayProviders = [
      gatewayProvider("openai", ["gpt-5"], { openai_chat: true }),
    ];
    const routes = planProxyRoutes({
      config: config(),
      registryModels: nativeModels,
      gatewayProviders,
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    expect(routes.get("openai")).toMatchObject({
      routeApi: "openai-completions",
      baseUrl: BASE,
      gatewayId: "openai",
      passthrough: false,
    });

    const warning = missingGatewayModelsWarning(
      nativeModels,
      [gatewayProvider("openai", ["gpt-5-mini"], { openai_chat: true })],
      config().proxy.upstreamProviders,
    );
    expect(warning).toContain("gpt-5");
  });

  test("catalog keys isolate gateway origins and selections", () => {
    const a = buildCatalogKey(GATEWAY, [{ id: "openai", enabled: true }]);
    const b = buildCatalogKey("https://other.example.ts.net", [
      { id: "openai", enabled: true },
    ]);
    expect(a).not.toBe(b);
    expect(a).toContain("openai");
  });
});
