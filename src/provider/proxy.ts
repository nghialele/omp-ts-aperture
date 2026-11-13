/**
 * Proxy mode: reroute existing omp providers through Aperture.
 *
 * Ported from the Pi extension's `extensions/aperture/proxy/runtime.ts`.
 *
 * omp has no native-`Provider` registration for extensions: `registerProvider`
 * takes a declarative config (baseUrl/api/apiKey/models/fetchDynamicModels).
 * The proxy therefore swaps each routed provider's model rows instead of
 * wrapping its stream. Gateway-injected credentials are modeled with
 * `apiKey: "-"` (config-sourced keys deliberately outrank stored OAuth, so a
 * routed provider stops sending its own credential); passthrough gateway
 * providers keep the provider native so omp's own credential still flows.
 *
 * Model ids stay bare (`gpt-5`, not `openai/gpt-5`). Aperture needs the
 * provider-qualified id on the wire, so the routing prefix is added per model
 * through `requestModelId`, which every omp transport sends verbatim.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelSpec,
  SimpleStreamOptions,
  StreamOptions,
} from "@oh-my-pi/pi-ai/types";
import { ApertureClient } from "../api/client";
import type { ApertureProvider } from "../api/types";
import { isSelectableApi } from "../api-selection";
import { getBaseUrlForApi } from "../base-url-routing";
import type { ResolvedConfig } from "../config/types";
import { resolveGatewayUrl, resolveProviderBaseUrl } from "../url";
import { APERTURE_PLACEHOLDER_API_KEY, toApertureApi } from "./catalog";
import { apertureRequestOptions } from "./request-options";

/** Base URL omp's ChatGPT sign-in detection keys on. */
export const OPENAI_BASE_URL = "https://api.openai.com/v1";

/**
 * Streaming implementation a routed provider declares when the gateway owns
 * protocol translation (api override) or the provider has no stream of its
 * own. Set by the extension from the registered Aperture apis.
 */
export type ProxyStreamFn = (
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream;

/**
 * One entry of the Aperture api table (see `apis.ts`): the upstream transport
 * an api borrows plus the option shape it accepts.
 */
export interface ApertureStreamAdapter {
  upstream: Api;
  stream(
    model: Model<Api>,
    context: Context,
    options?: StreamOptions,
  ): AssistantMessageEventStream;
  streamSimple: ProxyStreamFn;
}

export interface ProxyModelRoute {
  /** Upstream omp api for the provider. */
  api: Api;
  /** omp api the routed models declare. */
  routeApi: Api;
  /** Gateway base URL for `routeApi`. */
  baseUrl: string;
  /** Gateway provider id prefixed onto request model ids. */
  gatewayId: string;
  /** Keep the provider's own credential (passthrough gateway provider). */
  passthrough: boolean;
}

export interface ProxyRouteOptions {
  config: ResolvedConfig;
  /** Snapshot of omp's registry models, used to find each provider's native base URL. */
  registryModels: readonly Model<Api>[];
  /** Gateway catalog; `undefined` means the fetch failed (fail open). */
  gatewayProviders?: readonly ApertureProvider[];
  /** Caches upstream base URLs across syncs. */
  upstreamBaseUrls: Map<string, string>;
  /** Api override per local provider id. */
  apiOverrides: ReadonlyMap<string, Api>;
  notify?: (message: string, type: "info" | "warning") => void;
}

/**
 * Compute the routing decision for each enabled proxied provider. Providers
 * that omp does not list, or whose gateway target is unknown, are left out
 * (and reported).
 */
export function planProxyRoutes(
  options: ProxyRouteOptions,
): Map<string, ProxyModelRoute> {
  const { config, registryModels, gatewayProviders, upstreamBaseUrls } =
    options;
  const routes = new Map<string, ProxyModelRoute>();
  if (!config.proxy.enabled) return routes;

  const gatewayRoot = resolveGatewayUrl(config);
  const baseUrl = resolveProviderBaseUrl(config);
  if (!gatewayRoot || !baseUrl) return routes;

  const gatewayIds = gatewayProviders
    ? new Set(gatewayProviders.map((p) => p.id))
    : undefined;
  const compatibilityByProvider = new Map(
    (gatewayProviders ?? []).map((p) => [p.id, p.compatibility]),
  );
  const passthrough = new Set(
    (gatewayProviders ?? [])
      .filter((p) => p.requires_client_auth)
      .map((p) => p.id),
  );

  const modelsByProvider = new Map<string, Model<Api>[]>();
  for (const model of registryModels) {
    if (model.provider === "aperture") continue;
    const list = modelsByProvider.get(model.provider) ?? [];
    list.push(model);
    modelsByProvider.set(model.provider, list);
  }

  const warnedUnknown = new Set<string>();
  for (const entry of config.proxy.upstreamProviders) {
    if (entry.enabled === false) continue;
    const { gatewayId } = entry;
    if (gatewayIds && !gatewayIds.has(gatewayId)) {
      if (!warnedUnknown.has(gatewayId)) {
        warnedUnknown.add(gatewayId);
        options.notify?.(
          `[aperture] gateway provider "${gatewayId}" not found; provider "${entry.id}" left unrouted.`,
          "warning",
        );
      }
      continue;
    }
    const providerModels = modelsByProvider.get(entry.id);
    if (!providerModels || providerModels.length === 0) continue;

    // Capture the native upstream base URL on the first sync. Later syncs read
    // the registered (gateway) rows, which no longer describe the upstream.
    const liveBaseUrl = providerModels[0].baseUrl;
    const isAlreadyGateway =
      liveBaseUrl === gatewayRoot || liveBaseUrl === baseUrl;
    const upstreamBaseUrl = isAlreadyGateway
      ? upstreamBaseUrls.get(entry.id)
      : liveBaseUrl;
    if (!isAlreadyGateway && upstreamBaseUrl) {
      upstreamBaseUrls.set(entry.id, upstreamBaseUrl);
    }

    const sourceApi =
      (providerModels[0].api as Api | undefined) ?? "openai-completions";
    const override = options.apiOverrides.get(entry.id);
    const compatibility = compatibilityByProvider.get(gatewayId);
    let apiOverride: Api | undefined;
    if (override && compatibility !== undefined) {
      if (isSelectableApi(override, compatibility)) {
        apiOverride = override;
      } else {
        options.notify?.(
          `[aperture] api override "${override}" for proxied provider ${entry.id} is not served by the gateway; falling back to the provider's own api (${sourceApi}).`,
          "warning",
        );
      }
    }
    const api = apiOverride ?? sourceApi;
    const isPassthrough = passthrough.has(gatewayId);
    routes.set(entry.id, {
      api,
      // An override means the gateway owns protocol translation: the model
      // declares the Aperture api instead of the provider's own.
      routeApi: apiOverride ? (toApertureApi(api) ?? api) : api,
      baseUrl: getBaseUrlForApi(api, gatewayRoot, baseUrl, upstreamBaseUrl),
      gatewayId,
      passthrough: isPassthrough,
    });
  }
  return routes;
}

/** Rewrite one native model row for the Aperture route. */
export function proxyModelSpec(
  model: Model<Api>,
  route: ProxyModelRoute,
): ModelSpec {
  const spec = {
    id: model.id,
    name: model.name,
    api: route.routeApi,
    baseUrl: route.baseUrl,
    // Explicit so buildModel re-derives glyph tokenization from the routed
    // transport instead of inheriting the native api's identity.
    providerType: route.api,
    reasoning: model.reasoning,
    ...(model.thinking ? { thinking: model.thinking } : {}),
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow ?? 128_000,
    maxTokens: model.maxTokens ?? 8_192,
    ...(model.compat ? { compat: model.compat } : {}),
    // Bare id locally; Aperture gets the provider-qualified id on the wire.
    requestModelId: `${route.gatewayId}/${model.id}`,
  } as ModelSpec;
  return spec;
}

/** Build `registerProvider` models for one routed provider. */
export function proxyProviderModels(
  registryModels: readonly Model<Api>[],
  providerId: string,
  route: ProxyModelRoute,
): ModelSpec[] {
  return registryModels
    .filter((m) => m.provider === providerId && m.kind !== "judge")
    .map((m) => proxyModelSpec(m, route));
}

export interface ProxyRegistration {
  id: string;
  config: {
    baseUrl: string;
    api?: Api;
    apiKey?: string;
    models: ModelSpec[];
    /**
     * Custom stream for gated providers. Registered with the gateway
     * credential stamped in (`apiKey: "-"`): omp's config-key precedence means
     * a gated provider has no key of its own to send. Passthrough providers
     * omit it and keep omp's native transport and credential.
     */
    streamSimple?: (
      model: Model<Api>,
      context: Context,
      options?: SimpleStreamOptions,
    ) => AssistantMessageEventStream;
  };
}

/**
 * Adapter for a gated proxy provider: swap the model to the Aperture api and
 * hand it to the Aperture stream for that transport.
 */
export function gatedProxyStream(
  route: ProxyModelRoute,
  streams: ReadonlyMap<Api, ApertureStreamAdapter>,
): { streamSimple: ProxyStreamFn } | undefined {
  const upstream = streams.get(route.routeApi);
  if (!upstream) return undefined;
  return {
    streamSimple: (model, context, options) =>
      upstream.streamSimple(
        { ...model, api: route.routeApi },
        context,
        apertureRequestOptions(options),
      ),
  };
}

/**
 * Decide which `registerProvider` calls to issue for the current plan.
 * Passthrough providers with no api override stay native: their rows keep
 * their own base URL and credential, so nothing is registered.
 */
export function proxyRegistrations(
  routes: ReadonlyMap<string, ProxyModelRoute>,
  registryModels: readonly Model<Api>[],
  streamFor?: (
    route: ProxyModelRoute,
  ) => ProxyRegistration["config"]["streamSimple"],
): ProxyRegistration[] {
  const registrations: ProxyRegistration[] = [];
  for (const [id, route] of routes) {
    const models = proxyProviderModels(registryModels, id, route);
    if (models.length === 0) continue;
    if (route.passthrough && route.routeApi === route.api) continue;
    const streamSimple =
      !route.passthrough || route.routeApi !== route.api
        ? streamFor?.(route)
        : undefined;
    registrations.push({
      id,
      config: {
        baseUrl: route.baseUrl,
        api: route.api,
        ...(route.passthrough ? {} : { apiKey: APERTURE_PLACEHOLDER_API_KEY }),
        models,
        ...(streamSimple ? { streamSimple } : {}),
      },
    });
  }
  return registrations;
}

/** One gateway catalog fetch shared by proxy routing decisions. */
export async function fetchGatewayProviders(
  gatewayUrl: string,
  signal?: AbortSignal,
): Promise<ApertureProvider[] | undefined> {
  try {
    return await new ApertureClient(gatewayUrl).providers(signal);
  } catch {
    // Fail open: routing decisions fall back to each provider's own api.
    return undefined;
  }
}

const MAX_MISSING_MODELS_PER_PROVIDER = 5;

/**
 * Warn about routed models the gateway does not serve. Mirrors the Pi
 * extension's opt-in per-provider verification; returns the warning text so
 * the caller can surface it (omp's extension context owns the notification).
 */
export function missingGatewayModelsWarning(
  registryModels: readonly Model<Api>[],
  gatewayProviders: readonly ApertureProvider[],
  entries: readonly {
    id: string;
    gatewayId: string;
    shouldCheckGatewayModels?: boolean;
  }[],
): string | undefined {
  const checked = entries.filter(
    (p) => p.shouldCheckGatewayModels && p.id !== "aperture",
  );
  if (checked.length === 0 || gatewayProviders.length === 0) return undefined;

  const modelIdsByProvider = new Map(
    gatewayProviders.map((p) => [p.id, new Set(p.models)]),
  );
  const gatewayIdByLocalId = new Map(checked.map((p) => [p.id, p.gatewayId]));
  const missingByProvider = new Map<string, string[]>();
  for (const model of registryModels) {
    const gatewayId = gatewayIdByLocalId.get(model.provider);
    if (!gatewayId) continue;
    const served = modelIdsByProvider.get(gatewayId);
    if (!served || served.has(model.id)) continue;
    const list = missingByProvider.get(model.provider) ?? [];
    list.push(model.id);
    missingByProvider.set(model.provider, list);
  }
  if (missingByProvider.size === 0) return undefined;

  const summary = [...missingByProvider.entries()]
    .map(([provider, ids]) => {
      const shown = ids.slice(0, MAX_MISSING_MODELS_PER_PROVIDER);
      const remaining = ids.length - shown.length;
      return `${provider}: ${shown.join(", ")}${remaining > 0 ? `, ${remaining} more` : ""}`;
    })
    .join("; ");
  return `[aperture] models not available on gateway: ${summary}. Add them to the gateway configuration.`;
}
