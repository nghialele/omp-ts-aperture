/**
 * Aperture for omp: route LLM providers and MCP tools through Tailscale
 * Aperture.
 *
 * Ported from the Pi extension's `extensions/aperture/index.ts`. Two
 * capabilities:
 *
 * - **Dedicated** (default): a standalone `aperture` provider whose models come
 *   from the gateway, discovered with `fetchDynamicModels` so the host caches
 *   them like any built-in discovery provider.
 * - **Proxy**: reroute existing omp providers through the gateway by
 *   re-registering their model rows against an Aperture base URL.
 *
 * MCP is configured by `/aperture:settings` writing the gateway endpoint into
 * omp's `mcp.json`; omp owns the connection and per-tool exposure.
 */

import { unregisterCustomApis } from "@oh-my-pi/pi-ai";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProviderConfig,
} from "@oh-my-pi/pi-coding-agent";
import { configLoader } from "../../src/config/loader";
import { setLogger, warn } from "../../src/logger";
import { registerApertureApis } from "../../src/provider/apis";
import {
  DEDICATED_PROVIDER_ID,
  type DedicatedProviderSelection,
  fetchApertureCatalog,
} from "../../src/provider/catalog";
import {
  fetchGatewayProviders,
  gatedProxyStream,
  missingGatewayModelsWarning,
  planProxyRoutes,
  proxyRegistrations,
} from "../../src/provider/proxy";
import { resolveGatewayUrl, resolveProviderBaseUrl } from "../../src/url";
import { registerApertureSettings } from "./settings";

/** Api overrides for the dedicated selection, keyed by gateway provider id. */
function selectionApiOverrides(
  providers: DedicatedProviderSelection[],
): Map<string, Api> {
  return new Map(
    providers
      .filter((p) => p.enabled && p.api)
      .map((p) => [p.id, p.api as Api]),
  );
}

/** Stable `sourceId` for provider/api registrations owned by this extension. */
export const APERTURE_SOURCE_ID = "aperture-extension";

/** Registry rows for a provider (any kind), used to find native base URLs. */
function providerModels(
  registry: ExtensionContext["modelRegistry"],
  provider: string,
): Model<Api>[] {
  return registry.getProviderModels(provider);
}

/** Snapshot of every live model that can inform catalog metadata. */
function registrySnapshot(
  registry: ExtensionContext["modelRegistry"],
): Model<Api>[] {
  return registry.getAll("all");
}

/**
 * Build the dedicated provider config. `models` is intentionally absent so
 * omp treats the provider as discovery-backed (`fetchDynamicModels` only)
 * rather than as a static registration.
 */
function dedicatedProviderConfig(
  getRegistryModels: () => Model<Api>[],
  notify: (message: string) => void,
): ProviderConfig | undefined {
  const config = configLoader.getConfig();
  if (!config.dedicated.enabled) return undefined;
  const gatewayUrl = resolveGatewayUrl(config);
  const baseUrl = resolveProviderBaseUrl(config);
  if (!gatewayUrl || !baseUrl) return undefined;

  return {
    baseUrl,
    // The gateway injects the upstream credential. A config-sourced key also
    // counts as "configured" for availability, so the provider is listed
    // without a `/login` step and still outranks stored OAuth.
    apiKey: "-",
    api: "openai-completions",
    fetchDynamicModels: async () => {
      const current = configLoader.getConfig();
      const currentGateway = resolveGatewayUrl(current);
      const currentBase = resolveProviderBaseUrl(current);
      if (!current.dedicated.enabled || !currentGateway || !currentBase) {
        return [];
      }
      try {
        const selection = current.dedicated
          .providers as DedicatedProviderSelection[];
        return await fetchApertureCatalog({
          // Selection narrows the gateway catalog; see `filterProviders`.
          providers: [],
          selection,
          gatewayUrl: currentGateway,
          baseUrl: currentBase,
          registryModels: getRegistryModels(),
          modelsDev: null,
          apiOverrides: selectionApiOverrides(current.dedicated.providers),
          notify,
        });
      } catch (error) {
        // Fail open: an empty list keeps omp's cached rows in place instead of
        // replacing a good catalog with nothing.
        warn(
          `model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return [];
      }
    },
  } as unknown as ProviderConfig;
}

export default function apertureExtension(pi: ExtensionAPI): void {
  setLogger(pi.logger);
  configLoader.load();
  // Registered once: omp's api registry keeps them for the process lifetime.
  const adapters = registerApertureApis(APERTURE_SOURCE_ID);

  let invalidated = false;
  const registeredProxyProviders = new Set<string>();
  const upstreamBaseUrls = new Map<string, string>();
  let knownModels: Model<Api>[] = [];
  const getRegistryModels = () => knownModels;

  pi.setLabel("Aperture");

  pi.on("session_shutdown", () => {
    invalidated = true;
    // Remove wrapper registrations while the extension API is still live.
    for (const provider of registeredProxyProviders) {
      pi.unregisterProvider(provider);
    }
    registeredProxyProviders.clear();
    unregisterCustomApis(APERTURE_SOURCE_ID);
  });

  const notify = (
    ctx: ExtensionContext,
    message: string,
    type: "info" | "warning" | "error" = "info",
  ): void => {
    if (invalidated) return;
    try {
      ctx.ui.notify(message, type);
    } catch {
      // A stale ctx must never escape an async continuation.
      invalidated = true;
    }
  };

  const registerProxies = async (ctx: ExtensionContext): Promise<void> => {
    const config = configLoader.getConfig();
    const gatewayRoot = resolveGatewayUrl(config);
    if (!config.proxy.enabled || !gatewayRoot) {
      for (const provider of registeredProxyProviders) {
        pi.unregisterProvider(provider);
      }
      registeredProxyProviders.clear();
      return;
    }

    // One catalog fetch drives passthrough detection and api validation.
    const gatewayProviders = await fetchGatewayProviders(gatewayRoot);

    // A provider with no live rows has no models to rewrite; ask the registry
    // directly so a lazily composed provider is still discovered.
    const missingModels = new Map<string, Model<Api>[]>();
    for (const entry of config.proxy.upstreamProviders) {
      if (entry.enabled === false) continue;
      if (!knownModels.some((m) => m.provider === entry.id)) {
        missingModels.set(
          entry.id,
          providerModels(ctx.modelRegistry, entry.id),
        );
      }
    }
    const modelsForRouting =
      missingModels.size > 0
        ? [
            ...knownModels.filter((m) => !missingModels.has(m.provider)),
            ...[...missingModels.values()].flat(),
          ]
        : knownModels;

    const routes = planProxyRoutes({
      config,
      registryModels: modelsForRouting,
      gatewayProviders,
      upstreamBaseUrls,
      apiOverrides: new Map(
        config.proxy.upstreamProviders
          .filter((p) => p.enabled !== false && p.api)
          .map((p) => [p.id, p.api as Api]),
      ),
      notify: (message, type) => notify(ctx, message, type),
    });

    const desired = new Set(routes.keys());
    for (const provider of registeredProxyProviders) {
      if (!desired.has(provider)) {
        pi.unregisterProvider(provider);
        registeredProxyProviders.delete(provider);
        notify(ctx, `[aperture] unregistered ${provider}.`);
      }
    }

    const registrations = proxyRegistrations(
      routes,
      modelsForRouting,
      (route) =>
        route.routeApi.startsWith("aperture-")
          ? gatedProxyStream(route, adapters)?.streamSimple
          : undefined,
    );
    for (const registration of registrations) {
      pi.registerProvider(
        registration.id,
        registration.config as ProviderConfig,
      );
      registeredProxyProviders.add(registration.id);
    }

    if (gatewayProviders) {
      const warning = missingGatewayModelsWarning(
        modelsForRouting,
        gatewayProviders,
        config.proxy.upstreamProviders,
      );
      if (warning) notify(ctx, warning, "warning");
    }
  };

  const registerDedicated = (ctx: ExtensionContext): void => {
    const providerConfig = dedicatedProviderConfig(
      getRegistryModels,
      (message) => notify(ctx, message, "warning"),
    );
    if (!providerConfig) {
      pi.unregisterProvider(DEDICATED_PROVIDER_ID);
      return;
    }
    pi.registerProvider(DEDICATED_PROVIDER_ID, providerConfig);
  };

  /**
   * Kick a networked catalog refresh. omp's runtime discovery keeps the
   * previous rows when the fetch fails, and our fetcher swallows failures into
   * an empty list, so this never removes a working catalog.
   */
  const refreshModels = async (ctx: ExtensionContext): Promise<void> => {
    try {
      await ctx.modelRegistry.refreshRuntimeProviders("online");
    } catch (error) {
      if (invalidated) return;
      warn(
        `model refresh failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  let syncPromise: Promise<void> = Promise.resolve();

  /** Re-read config and reconcile both capabilities. Serialized, never throws. */
  const sync = (ctx: ExtensionContext): Promise<void> => {
    syncPromise = syncPromise.then(async () => {
      if (invalidated) return;
      configLoader.load();
      knownModels = registrySnapshot(ctx.modelRegistry);
      // Registrations are queued and drained by omp before discovery runs; the
      // dedicated provider's fetcher reads this same config at call time.
      await registerProxies(ctx);
      registerDedicated(ctx);
    });
    return syncPromise;
  };

  pi.on("session_start", async (_event, ctx) => {
    invalidated = false;
    // session_start runs after the extension factory queued its first
    // dedicated registration; a re-register here keeps config edits current.
    await sync(ctx);
    if (invalidated) return;
    await refreshModels(ctx);
  });

  registerApertureSettings(
    pi,
    async (ctx) => {
      await sync(ctx);
      if (invalidated) return;
      await refreshModels(ctx);
    },
    getRegistryModels,
  );
}
