import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApertureProvider } from "../api/types";
import { DEFAULT_CONFIG } from "../config/defaults";
import type { ResolvedConfig } from "../config/types";
import {
  missingGatewayModelsWarning,
  planProxyRoutes,
  proxyRegistrations,
} from "./proxy";

const GATEWAY = "https://ai.pango-lin.ts.net";
const BASE = `${GATEWAY}/v1`;

function nativeModel(overrides: Partial<Model<Api>>): Model<Api> {
  return {
    id: "gpt-5",
    name: "GPT-5",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 400_000,
    maxTokens: 128_000,
    ...overrides,
  } as unknown as Model<Api>;
}

function gatewayProvider(
  id: string,
  extra: Partial<ApertureProvider> = {},
): ApertureProvider {
  return {
    id,
    name: id,
    description: "",
    models: ["gpt-5"],
    compatibility: { openai_chat: true, openai_responses: true },
    requires_client_auth: false,
    modelInfoById: {},
    ...extra,
  };
}

function config(overrides: Partial<ResolvedConfig> = {}): ResolvedConfig {
  return {
    ...DEFAULT_CONFIG,
    baseUrl: GATEWAY,
    proxy: {
      enabled: true,
      upstreamProviders: [
        { id: "openai", gatewayId: "openai" },
      ] as ResolvedConfig["proxy"]["upstreamProviders"],
    },
    ...overrides,
  };
}

describe("planProxyRoutes", () => {
  test("routes a proxied provider through the gateway with bare model ids", () => {
    const routes = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({})],
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    const route = routes.get("openai");
    expect(route).toBeDefined();
    expect(route?.baseUrl).toBe(BASE);
    expect(route?.routeApi).toBe("openai-completions");
    expect(route?.gatewayId).toBe("openai");
  });

  test("keeps the provider's native api when the gateway catalog failed", () => {
    const routes = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({})],
      gatewayProviders: undefined,
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    expect(routes.get("openai")?.routeApi).toBe("openai-completions");
  });

  test("warns and skips a provider whose gateway target is unknown", () => {
    const warnings: string[] = [];
    const routes = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({ provider: "openai" })],
      gatewayProviders: [gatewayProvider("some-other")],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
      notify: (message) => warnings.push(message),
    });
    expect(routes.size).toBe(0);
    expect(warnings[0]).toContain("not found");
  });

  test("an unsupported api override falls back with a warning", () => {
    const warnings: string[] = [];
    const routes = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({})],
      gatewayProviders: [
        gatewayProvider("openai", { compatibility: { openai_chat: true } }),
      ],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map<string, Api>([["openai", "anthropic-messages"]]),
      notify: (message) => warnings.push(message),
    });
    expect(routes.get("openai")?.routeApi).toBe("openai-completions");
    expect(warnings[0]).toContain("not served by the gateway");
  });

  test("an api override routes through the Aperture api", () => {
    const routes = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({})],
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map<string, Api>([["openai", "openai-responses"]]),
    });
    expect(routes.get("openai")?.routeApi).toBe("aperture-openai-responses");
  });

  test("caches the upstream base URL once the rows are gateway-rewritten", () => {
    const upstream = new Map<string, string>();
    planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({})],
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: upstream,
      apiOverrides: new Map(),
    });
    expect(upstream.get("openai")).toBe("https://api.openai.com/v1");

    const second = planProxyRoutes({
      config: config(),
      registryModels: [nativeModel({ baseUrl: BASE })],
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: upstream,
      apiOverrides: new Map(),
    });
    expect(second.get("openai")?.baseUrl).toBe(BASE);
  });

  test("proxy disabled plans nothing", () => {
    const routes = planProxyRoutes({
      config: config({ proxy: { enabled: false, upstreamProviders: [] } }),
      registryModels: [nativeModel({})],
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    expect(routes.size).toBe(0);
  });
});

describe("proxyRegistrations", () => {
  test("registers routed providers with a placeholder key and request-qualified ids", () => {
    const registry = [nativeModel({})];
    const routes = planProxyRoutes({
      config: config(),
      registryModels: registry,
      gatewayProviders: [gatewayProvider("openai")],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    const [registration] = proxyRegistrations(routes, registry);
    expect(registration.id).toBe("openai");
    expect(registration.config.apiKey).toBe("-");
    expect(registration.config.models[0]).toMatchObject({
      id: "gpt-5",
      requestModelId: "openai/gpt-5",
      api: "openai-completions",
      baseUrl: BASE,
    });
  });

  test("passthrough providers stay native unless an api override reroutes them", () => {
    const registry = [nativeModel({})];
    const first = planProxyRoutes({
      config: config(),
      registryModels: registry,
      gatewayProviders: [
        gatewayProvider("openai", { requires_client_auth: true }),
      ],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map(),
    });
    expect(proxyRegistrations(first, registry)).toHaveLength(0);

    const second = planProxyRoutes({
      config: config(),
      registryModels: registry,
      gatewayProviders: [
        gatewayProvider("openai", { requires_client_auth: true }),
      ],
      upstreamBaseUrls: new Map(),
      apiOverrides: new Map<string, Api>([["openai", "openai-responses"]]),
    });
    const [registration] = proxyRegistrations(second, registry);
    expect(registration.config.apiKey).toBeUndefined();
    expect(registration.config.models[0].api).toBe("aperture-openai-responses");
  });
});

describe("missingGatewayModelsWarning", () => {
  test("reports checked models the gateway does not serve", () => {
    const warning = missingGatewayModelsWarning(
      [nativeModel({ id: "gpt-5" }), nativeModel({ id: "gpt-4.1" })],
      [gatewayProvider("openai", { models: ["gpt-5"] })],
      [{ id: "openai", gatewayId: "openai", shouldCheckGatewayModels: true }],
    );
    expect(warning).toContain("gpt-4.1");
    expect(warning).not.toContain("gpt-5,");
  });

  test("returns undefined when everything is served or unchecked", () => {
    expect(
      missingGatewayModelsWarning(
        [nativeModel({})],
        [gatewayProvider("openai", { models: ["gpt-5"] })],
        [{ id: "openai", gatewayId: "openai", shouldCheckGatewayModels: true }],
      ),
    ).toBeUndefined();
    expect(
      missingGatewayModelsWarning(
        [nativeModel({ id: "gpt-4.1" })],
        [gatewayProvider("openai")],
        [{ id: "openai", gatewayId: "openai" }],
      ),
    ).toBeUndefined();
  });
});
