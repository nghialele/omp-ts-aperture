import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getCustomApi, registerCustomApi } from "@oh-my-pi/pi-ai";
import {
  APERTURE_API_UPSTREAM,
  APERTURE_APIS,
  createApertureAdapters,
  requestModel,
} from "./apis";
import { APERTURE_PLACEHOLDER_API_KEY } from "./catalog";
import { apertureRequestOptions } from "./request-options";

/**
 * The adapters are the only place omp hands control back to Aperture, so their
 * contract is small but load-bearing: a distinct non-builtin api name, the
 * upstream api it borrows, the id shape that api expects on the wire, and the
 * gateway credential.
 */

function model(overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "google/gemini-3-pro",
    api: "aperture-google-generative-ai",
    provider: "aperture",
    baseUrl: "https://ai.pango-lin.ts.net/v1beta",
    name: "gemini-3-pro",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
    ...overrides,
  } as unknown as Model<Api>;
}

describe("aperture api table", () => {
  test("every Aperture api is distinct, non-builtin, and maps to one upstream", () => {
    expect(new Set(APERTURE_APIS).size).toBe(APERTURE_APIS.length);
    for (const api of APERTURE_APIS) {
      expect(api.startsWith("aperture-")).toBe(true);
      // The upstream must be a real omp transport name, and never itself an
      // Aperture api (that would recurse).
      expect(APERTURE_API_UPSTREAM[api].startsWith("aperture-")).toBe(false);
    }
  });

  test("registering an upstream name is rejected, so dispatch cannot recurse", () => {
    const adapters = createApertureAdapters();
    const adapter = adapters.get(APERTURE_APIS[0]);
    expect(adapter).toBeDefined();
    if (!adapter) return;
    expect(() =>
      registerCustomApi(adapter.upstream, adapter.streamSimple, "probe"),
    ).toThrow(/built-in API names are reserved/);
  });

  test("registration makes the Aperture api resolvable while upstream stays builtin", () => {
    const adapters = createApertureAdapters();
    for (const api of APERTURE_APIS) {
      const adapter = adapters.get(api);
      if (!adapter) throw new Error(`missing adapter for ${api}`);
      registerCustomApi(
        api,
        adapter.streamSimple,
        "aperture-test",
        adapter.stream,
      );
      expect(getCustomApi(api)?.sourceId).toBe("aperture-test");
      // Built-in names never resolve to a custom entry: that is what makes the
      // "rewrite the api, then call stream()" delegation terminate.
      expect(getCustomApi(adapter.upstream)).toBeUndefined();
    }
  });
});

describe("requestModel prefix handling", () => {
  test("strips the provider prefix for path-embedding upstreams", () => {
    // Regression: the strip used to test `model.api`, which at adapter time is
    // `aperture-google-generative-ai` (not path-embedding), so qualified Gemini
    // ids reached /v1beta/models/google/... and 404'd.
    expect(requestModel(model(), "google-generative-ai").id).toBe(
      "gemini-3-pro",
    );
    expect(requestModel(model(), "google-vertex").id).toBe("gemini-3-pro");
    expect(
      requestModel(model({ id: "aws/nova-pro" }), "bedrock-converse-stream").id,
    ).toBe("nova-pro");
  });

  test("keeps the qualified id for body-carried transports", () => {
    for (const upstream of ["openai-completions", "anthropic-messages"]) {
      expect(requestModel(model({ id: "openai/gpt-5" }), upstream).id).toBe(
        "openai/gpt-5",
      );
    }
  });

  test("strips only the first segment, preserving nested upstream ids", () => {
    expect(
      requestModel(model({ id: "acme/hf:org/some-model" }), "google-vertex").id,
    ).toBe("hf:org/some-model");
  });

  test("leaves an unqualified id alone", () => {
    expect(
      requestModel(model({ id: "gemini-3-pro" }), "google-vertex").id,
    ).toBe("gemini-3-pro");
  });
});

describe("adapter credential", () => {
  test("nested adapters always stamp the gateway placeholder", () => {
    // `stream()` is stubbed out by the host in tests, so assert the option
    // shaping the adapter relies on directly.
    const options = apertureRequestOptions(
      { apiKey: "stored-oauth-token", sessionId: "s1" },
      { enabled: true },
    );
    expect(options?.apiKey).toBe(APERTURE_PLACEHOLDER_API_KEY);
    const headers = options?.headers as Record<string, string>;
    expect(headers.Referer).toBe("https://pi.dev");
  });
});
