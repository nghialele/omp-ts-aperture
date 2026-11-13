import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import extension from "../extensions/aperture/index";
import { getAgentDir, setAgentDir } from "../src/agent-dir";
import { configLoader } from "../src/config/loader";

/**
 * Loads the real extension factory against a fake `ExtensionAPI` and checks the
 * registrations omp will act on. This is the closest unit-level proof that the
 * module shape, imports, event wiring, and config plumbing are valid.
 */

function fakePi() {
  const providers = new Map<string, Record<string, unknown>>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<
    string,
    { handler: (...args: never[]) => unknown }
  >();
  const label: string[] = [];
  const pi = {
    logger: { warn: () => {} },
    setLabel: (value: string) => label.push(value),
    on: (event: string, handler: (...args: never[]) => unknown) => {
      handlers.set(event, handler as never);
    },
    registerProvider: (name: string, config: unknown) => {
      providers.set(name, config as Record<string, unknown>);
    },
    unregisterProvider: (name: string) => {
      providers.delete(name);
    },
    registerCommand: (
      name: string,
      options: { handler: (...args: never[]) => unknown },
    ) => {
      commands.set(name, options);
    },
    events: { on: () => {}, emit: () => {} },
  };
  return { pi, providers, handlers, commands, label };
}

function fakeCtx() {
  const notifications: string[] = [];
  const storedRows: unknown[] = [];
  return {
    notifications,
    storedRows,
    ctx: {
      ui: { notify: (message: string) => notifications.push(message) },
      modelRegistry: {
        getAll: () => [],
        getProviderModels: () => [],
        refreshRuntimeProviders: async () => {},
      },
    },
  };
}

describe("extension module", () => {
  let dir: string;
  let originalAgentDir: string;

  beforeEach(() => {
    originalAgentDir = getAgentDir();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-smoke-"));
    setAgentDir(dir);
    // The extension shares the process-wide loader; point it at this test's
    // temp agent dir so each case starts from a clean config.
    configLoader.reloadForTests(path.join(dir, "aperture.json"));
  });

  afterEach(() => {
    setAgentDir(originalAgentDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("registers commands and the label before any session exists", () => {
    const { pi, providers, commands, label } = fakePi();
    extension(pi as never);
    expect(label).toEqual(["Aperture"]);
    expect([...commands.keys()].sort()).toEqual([
      "aperture:proxy",
      "aperture:settings",
    ]);
    // No gateway URL configured yet, so nothing is registered.
    expect(providers.size).toBe(0);
  });

  test("registers the dedicated provider from on-disk config on session_start", async () => {
    // `invalidated` is set by session_shutdown and cleared on session_start;
    // a previous case in this file ends without a shutdown, so each test owns
    // its own factory instance.
    fs.writeFileSync(
      path.join(dir, "aperture.json"),
      JSON.stringify({
        baseUrl: "https://ai.pango-lin.ts.net",
        onboardingDone: true,
      }),
    );
    const { pi, providers, handlers } = fakePi();
    extension(pi as never);
    const { ctx, notifications } = fakeCtx();
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);

    const dedicated = providers.get("aperture");
    expect(dedicated).toBeDefined();
    expect(dedicated?.baseUrl).toBe("https://ai.pango-lin.ts.net/v1");
    expect(dedicated?.apiKey).toBe("-");
    expect(typeof dedicated?.fetchDynamicModels).toBe("function");
    // Gateway unreachable in tests: the fetcher fails open with no rows.
    const fetcher = dedicated?.fetchDynamicModels;
    const rows = await (fetcher as unknown as () => Promise<unknown>)();
    expect(rows).toEqual([]);
    // Warnings from the fetcher go to the logger (`warn`), not the UI; the
    // failure is swallowed so the host keeps its cached rows.
    expect(notifications.join("\n")).not.toContain("fetch failed");
  });

  test("fetchDynamicModels maps a live gateway catalog to per-transport rows", async () => {
    fs.writeFileSync(
      path.join(dir, "aperture.json"),
      JSON.stringify({
        baseUrl: "https://ai.pango-lin.ts.net",
        onboardingDone: true,
      }),
    );
    const { pi, providers, handlers } = fakePi();
    extension(pi as never);

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/v1/models")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "gpt-5",
                metadata: { provider: { id: "openai", name: "OpenAI" } },
                supported_endpoints: ["/v1/chat/completions"],
              },
              {
                id: "claude",
                metadata: { provider: { id: "anthropic", name: "Anthropic" } },
                supported_endpoints: ["/v1/messages"],
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      // models.dev is best-effort; a 500 must only drop enrichment.
      return new Response("{}", { status: 500 });
    }) as unknown as typeof fetch;

    try {
      const { ctx } = fakeCtx();
      await handlers.get("session_start")?.({ type: "session_start" }, ctx);
      const dedicated = providers.get("aperture") as Record<string, unknown>;
      const fetchModels = dedicated.fetchDynamicModels as () => Promise<
        Array<Record<string, unknown>>
      >;
      const rows = await fetchModels();

      expect(rows.map((row) => row.id)).toEqual([
        "openai/gpt-5",
        "anthropic/claude",
      ]);
      // Each upstream transport keeps its own wire format and gateway path.
      expect(rows[0]).toMatchObject({
        api: "aperture-openai-completions",
        baseUrl: "https://ai.pango-lin.ts.net/v1",
      });
      expect(rows[1]).toMatchObject({
        api: "aperture-anthropic-messages",
        baseUrl: "https://ai.pango-lin.ts.net",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a settings resync picks up a changed gateway URL", async () => {
    fs.writeFileSync(
      path.join(dir, "aperture.json"),
      JSON.stringify({ baseUrl: "https://gw-one.pango-lin.ts.net" }),
    );
    const { pi, providers, handlers } = fakePi();
    extension(pi as never);
    const { ctx } = fakeCtx();
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(providers.get("aperture")?.baseUrl).toBe(
      "https://gw-one.pango-lin.ts.net/v1",
    );

    // What /aperture:settings does after saving: the config changes in place,
    // then sync runs again. No process restart is involved.
    configLoader.update({ baseUrl: "https://gw-two.pango-lin.ts.net" });
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(providers.get("aperture")?.baseUrl).toBe(
      "https://gw-two.pango-lin.ts.net/v1",
    );
  });

  test("disabling the dedicated provider unregisters it on the next sync", async () => {
    fs.writeFileSync(
      path.join(dir, "aperture.json"),
      JSON.stringify({ baseUrl: "https://ai.pango-lin.ts.net" }),
    );
    const { pi, providers, handlers } = fakePi();
    extension(pi as never);
    const { ctx } = fakeCtx();
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(providers.has("aperture")).toBe(true);

    configLoader.update({ dedicated: { enabled: false, providers: [] } });
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);
    expect(providers.has("aperture")).toBe(false);
  });

  test("proxy mode registers routed providers with placeholder credentials", async () => {
    fs.writeFileSync(
      path.join(dir, "aperture.json"),
      JSON.stringify({
        baseUrl: "https://ai.pango-lin.ts.net",
        proxy: {
          enabled: true,
          upstreamProviders: [
            { id: "openai", gatewayId: "openai", enabled: true },
          ],
        },
        dedicated: { enabled: false },
      }),
    );
    const { pi, providers, handlers } = fakePi();
    extension(pi as never);

    const nativeModel = {
      id: "gpt-5",
      name: "GPT-5",
      provider: "openai",
      api: "openai-completions",
      baseUrl: "https://api.openai.com/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 8_192,
    };
    const ctx = {
      ui: { notify: () => {} },
      modelRegistry: {
        getAll: () => [nativeModel],
        getProviderModels: () => [nativeModel],
        refreshRuntimeProviders: async () => {},
      },
    };
    await handlers.get("session_start")?.({ type: "session_start" }, ctx);

    const proxied = providers.get("openai");
    expect(proxied).toBeDefined();
    expect(proxied?.apiKey).toBe("-");
    expect(proxied?.baseUrl).toBe("https://ai.pango-lin.ts.net/v1");
    const models = proxied?.models as Array<Record<string, unknown>>;
    expect(models[0].requestModelId).toBe("openai/gpt-5");
    expect(models[0].id).toBe("gpt-5");
    // Dedicated is disabled in config, so nothing else is registered.
    expect(providers.has("aperture")).toBe(false);
  });
});
