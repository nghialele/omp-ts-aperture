import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ApertureProvider } from "../api/types";
import {
  APERTURE_SYSTEM_ONE_API,
  buildCatalogKey,
  buildModels,
  DEDICATED_PROVIDER_ID,
  filterProviders,
} from "./catalog";

function provider(
  id: string,
  models: string[],
  extra: Partial<ApertureProvider> = {},
): ApertureProvider {
  return {
    id,
    name: id,
    description: "",
    models,
    compatibility: { openai_chat: true },
    requires_client_auth: false,
    modelInfoById: Object.fromEntries(
      models.map((m) => [
        m,
        {
          id: m,
          pricing: { input: "0.000003", output: "0.000015" },
          context_window_tokens: 200_000,
          max_output_tokens: 64_000,
          system_one: false,
        },
      ]),
    ),
    ...extra,
  };
}

const GATEWAY = "https://ai.pango-lin.ts.net";
const BASE = `${GATEWAY}/v1`;

function build(
  providers: ApertureProvider[],
  extra: Partial<Parameters<typeof buildModels>[0]> = {},
) {
  return buildModels({
    providers,
    gatewayUrl: GATEWAY,
    baseUrl: BASE,
    registryModels: [],
    modelsDev: null,
    ...extra,
  });
}

describe("filterProviders", () => {
  test("drops passthrough providers no matter the selection", () => {
    const filtered = filterProviders(
      [
        provider("openai", ["gpt-5"], { requires_client_auth: true }),
        provider("anthropic", ["claude"]),
      ],
      [],
    );
    expect(filtered.map((p) => p.id)).toEqual(["anthropic"]);
  });

  test("an empty selection includes every callable provider", () => {
    const filtered = filterProviders(
      [provider("a", ["m"]), provider("b", ["n"])],
      [],
    );
    expect(filtered.map((p) => p.id)).toEqual(["a", "b"]);
  });

  test("a non-empty selection keeps only enabled entries", () => {
    const filtered = filterProviders(
      [provider("a", ["m"]), provider("b", ["n"])],
      [
        { id: "a", enabled: true },
        { id: "b", enabled: false },
      ],
    );
    expect(filtered.map((p) => p.id)).toEqual(["a"]);
  });
});

describe("buildModels", () => {
  test("builds qualified chat models routed through the Aperture api", () => {
    const [model] = build([provider("openai", ["gpt-5"])]);
    expect(model.id).toBe("openai/gpt-5");
    expect(model.api).toBe("aperture-openai-completions");
    expect(model.baseUrl).toBe(BASE);
    // Gateway pricing converted from per-token strings to per-million rates.
    expect(model.cost?.input).toBeCloseTo(3);
    expect(model.cost?.output).toBeCloseTo(15);
    expect(model.contextWindow).toBe(200_000);
    expect(model.maxTokens).toBe(64_000);
  });

  test("routes Anthropic chat models to the gateway root", () => {
    const [model] = build([
      provider("anthropic", ["claude"], {
        compatibility: { anthropic_messages: true },
      }),
    ]);
    expect(model.api).toBe("aperture-anthropic-messages");
    expect(model.baseUrl).toBe(GATEWAY);
  });

  test("routes Gemini models to the /v1beta surface and strips the id prefix", () => {
    const [model] = build([
      provider("google", ["gemini-3-pro"], {
        compatibility: { gemini_generate_content: true },
      }),
    ]);
    expect(model.api).toBe("aperture-google-generative-ai");
    expect(model.baseUrl).toBe(`${GATEWAY}/v1beta`);
  });

  test("routes Bedrock models to /bedrock", () => {
    const [model] = build([
      provider("bedrock", ["nova"], {
        compatibility: { bedrock_converse: true },
      }),
    ]);
    expect(model.baseUrl).toBe(`${GATEWAY}/bedrock`);
  });

  test("System One models become judge rows on the System One api", () => {
    const p = provider("typesafe", ["jev"]);
    p.modelInfoById.jev = { id: "jev", system_one: true };
    const [model] = build([p]);
    expect(model.kind).toBe("judge");
    expect(model.api).toBe(APERTURE_SYSTEM_ONE_API);
    expect(model.baseUrl).toBe(GATEWAY);
  });

  test("the judge row's base URL makes the wire land on /v1/systemone", () => {
    // Regression: judge rows used to get `{gateway}/v1` from getBaseUrlForApi,
    // so pi-ai's typesafe wire (which appends /v1/systemone itself) posted to
    // /v1/v1/systemone and 404'd.
    const p = provider("typesafe", ["jev"]);
    p.modelInfoById.jev = { id: "jev", system_one: true };
    const [model] = build([p]);
    expect(`${model.baseUrl}/v1/systemone`).toBe(`${GATEWAY}/v1/systemone`);
  });

  test("judge rows never appear as chat models", () => {
    const p = provider("mixed", ["chat-model", "jev"]);
    p.modelInfoById.jev = { id: "jev", system_one: true };
    const models = build([p]);
    expect(models.map((m) => [m.id, m.kind ?? "chat"])).toEqual([
      ["mixed/chat-model", "chat"],
      ["mixed/jev", "judge"],
    ]);
  });

  test("api overrides apply when the gateway serves them", () => {
    const [model] = build(
      [
        provider("openai", ["gpt-5"], {
          compatibility: { openai_chat: true, openai_responses: true },
        }),
      ],
      {
        apiOverrides: new Map<string, Api>([["openai", "openai-responses"]]),
      },
    );
    expect(model.api).toBe("aperture-openai-responses");
  });

  test("unsupported api overrides fall back with a warning", () => {
    const warnings: string[] = [];
    const [model] = build([provider("openai", ["gpt-5"])], {
      apiOverrides: new Map<string, Api>([["openai", "anthropic-messages"]]),
      notify: (message) => warnings.push(message),
    });
    expect(model.api).toBe("aperture-openai-completions");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("not served by the gateway");
  });

  test("pulls capability metadata from the registry when present", () => {
    const registry = [
      {
        provider: "openai",
        id: "gpt-5",
        name: "GPT-5",
        baseUrl: "https://api.openai.com/v1",
        reasoning: true,
        input: ["text", "image"],
        contextWindow: 400_000,
        maxTokens: 128_000,
        cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
        api: "openai-completions",
      } as unknown as Model<Api>,
    ];
    const [model] = build([provider("openai", ["gpt-5"])], {
      registryModels: registry,
    });
    expect(model.name).toBe("GPT-5");
    expect(model.reasoning).toBe(true);
    expect(model.input).toEqual(["text", "image"]);
    // Gateway limits outrank the registry's.
    expect(model.contextWindow).toBe(200_000);
    // Gateway pricing outranks the registry's.
    expect(model.cost?.input).toBeCloseTo(3);
  });

  test("ignores the dedicated provider's own registry entries for metadata", () => {
    const registry = [
      {
        provider: DEDICATED_PROVIDER_ID,
        id: "openai/gpt-5",
        name: "stale",
        baseUrl: BASE,
        reasoning: false,
        input: ["text"],
        contextWindow: 1000,
        maxTokens: 1000,
        cost: { input: 9, output: 9, cacheRead: 9, cacheWrite: 9 },
        api: "aperture-openai-completions",
      } as unknown as Model<Api>,
    ];
    const [model] = build([provider("openai", ["gpt-5"])], {
      registryModels: registry,
    });
    expect(model.name).toBe("gpt-5");
    expect(model.contextWindow).toBe(200_000);
  });
});

describe("buildCatalogKey", () => {
  test("records gateway origin and the normalized selection", () => {
    expect(buildCatalogKey(GATEWAY, [])).toBe(`${GATEWAY} * v3`);
    expect(
      buildCatalogKey(GATEWAY, [
        { id: "openai", enabled: true },
        { id: "anthro", enabled: false },
        { id: "google", enabled: true, api: "google-generative-ai" },
      ]),
    ).toBe(`${GATEWAY} google@google-generative-ai,openai v3`);
  });

  test("different gateway origins never share a key", () => {
    expect(buildCatalogKey("https://a.example", [])).not.toBe(
      buildCatalogKey("https://a.example.evil", []),
    );
  });
});
