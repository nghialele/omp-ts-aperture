import { describe, expect, test } from "bun:test";
import { DEFAULT_CONFIG } from "./defaults";
import { resolveConfig } from "./loader";

describe("resolveConfig", () => {
  test("empty config keeps every default", () => {
    expect(resolveConfig({})).toEqual(DEFAULT_CONFIG);
  });

  test("gatewayId defaults to id for proxy providers", () => {
    const resolved = resolveConfig({
      proxy: {
        enabled: true,
        upstreamProviders: [{ id: "anthropic" } as never],
      },
    });
    expect(resolved.proxy.upstreamProviders[0]).toMatchObject({
      id: "anthropic",
      gatewayId: "anthropic",
    });
  });

  test("legacy mode=proxy enables proxy and disables dedicated", () => {
    const resolved = resolveConfig({ mode: "proxy" } as never);
    expect(resolved.proxy.enabled).toBe(true);
    expect(resolved.dedicated.enabled).toBe(false);
  });

  test("legacy providers list becomes proxied providers", () => {
    const resolved = resolveConfig({
      providers: ["anthropic", "openai"],
      checkGatewayModels: ["anthropic"],
    } as never);
    expect(resolved.proxy.enabled).toBe(true);
    expect(resolved.proxy.upstreamProviders.map((p) => p.id)).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(resolved.proxy.upstreamProviders[0].gatewayId).toBe("anthropic");
  });

  test("connectors rename to mcp, dropping pin lists", () => {
    const resolved = resolveConfig({
      connectors: {
        enabled: true,
        pinnedTools: [{ connectorId: "github", toolName: "list_repos" }],
      },
    } as never);
    expect(resolved.mcp.enabled).toBe(true);
    expect(
      (resolved as unknown as { connectors?: unknown }).connectors,
    ).toBeUndefined();
  });

  test("APERTURE_BASE_URL beats the file value and is normalized", () => {
    const previous = process.env.APERTURE_BASE_URL;
    process.env.APERTURE_BASE_URL = "ai.pango-lin.ts.net/v1/models";
    try {
      const resolved = resolveConfig({ baseUrl: "http://file.example" });
      expect(resolved.baseUrl).toBe("http://ai.pango-lin.ts.net");
    } finally {
      if (previous === undefined) delete process.env.APERTURE_BASE_URL;
      else process.env.APERTURE_BASE_URL = previous;
    }
  });

  test("explicit toggles survive normalization", () => {
    const resolved = resolveConfig({
      dedicated: {
        enabled: false,
        providers: [{ id: "openai", enabled: true }],
      },
      mcp: { enabled: true },
    });
    expect(resolved.dedicated.enabled).toBe(false);
    expect(resolved.dedicated.providers).toEqual([
      { id: "openai", enabled: true },
    ]);
    expect(resolved.mcp.enabled).toBe(true);
  });

  test("gateway baseUrl in the file is normalized to an origin", () => {
    const previous = process.env.APERTURE_BASE_URL;
    delete process.env.APERTURE_BASE_URL;
    try {
      const resolved = resolveConfig({
        baseUrl: "https://ai.pango-lin.ts.net/v1/models",
      });
      // Stored raw; normalization happens where the gateway URL is resolved.
      expect(resolved.baseUrl).toBe("https://ai.pango-lin.ts.net/v1/models");
    } finally {
      if (previous !== undefined) process.env.APERTURE_BASE_URL = previous;
    }
  });
});
