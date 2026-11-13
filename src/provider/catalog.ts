/**
 * Builds the Aperture catalog: gateway `/v1/models` + local capability
 * metadata -> omp `ModelSpec` rows that the host turns into `Model` objects
 * via `buildModel` inside `fetchDynamicModels`.
 *
 * Ported from the Pi extension's `src/provider/catalog.ts`. Differences from
 * the Pi version are host-level only:
 *
 * - Pi registered a native `Provider` and published `ModelsStoreEntry`
 *   snapshots through `RefreshModelsContext`; omp discovers runtime models with
 *   `fetchDynamicModels(apiKey)` and caches whatever rows are returned. This
 *   module therefore returns specs and leaves persistence to the host's
 *   SQLite model cache.
 * - Pi's classifier models are omp `kind: "judge"` rows, so omp selects them
 *   through the judge role instead of a dedicated classifier surface.
 */

import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { ApertureClient } from "../api/client";
import type { ApertureProvider } from "../api/types";
import { getApiForCompatibility, isSelectableApi } from "../api-selection";
import { getBaseUrlForApi } from "../base-url-routing";
import {
  buildClassifierModelConfig,
  buildDefaultModelConfig,
} from "../model-defaults";
import {
  fetchModelsDevCatalog,
  type ModelsDevCatalog,
  resolveModelMetadata,
} from "../model-metadata";
import { APERTURE_SYSTEM_ONE_API, systemOneBaseUrl } from "./system-one";

export const DEDICATED_PROVIDER_ID = "aperture";

/* APERTURE_SYSTEM_ONE_API is pi-ai's System One wire (`{baseUrl}/v1/systemone`). */
export { APERTURE_SYSTEM_ONE_API } from "./system-one";

/**
 * Maps an upstream omp transport api onto the Aperture-specific api that
 * routes it through the gateway. Declared here (not in `apis.ts`) so catalog
 * building stays free of the runtime adapter module, which imports pi-ai's
 * stream dispatcher.
 */
export const APERTURE_API_UPSTREAM = {
  "aperture-openai-completions": "openai-completions",
  "aperture-openai-responses": "openai-responses",
  "aperture-anthropic-messages": "anthropic-messages",
  "aperture-google-generative-ai": "google-generative-ai",
  "aperture-google-vertex": "google-vertex",
  "aperture-bedrock-converse-stream": "bedrock-converse-stream",
} as const;

export type ApertureApi = keyof typeof APERTURE_API_UPSTREAM;

/** The api an upstream omp api is exposed as on the dedicated provider. */
/** Aperture api for an upstream api, or `undefined` when it is not routable. */
export function toApertureApi(api: string): ApertureApi | undefined {
  for (const [name, upstream] of Object.entries(APERTURE_API_UPSTREAM)) {
    if (upstream === api) return name as ApertureApi;
  }
  return undefined;
}

export const APERTURE_APIS = Object.keys(
  APERTURE_API_UPSTREAM,
) as ApertureApi[];

/** Placeholder credential; the gateway injects the real upstream key. */
export const APERTURE_PLACEHOLDER_API_KEY = "-";

/**
 * Resolve the route's upstream api to the Aperture api the dedicated provider
 * must declare. Unknown or non-gateway apis fall back to the OpenAI chat
 * transport, Aperture's default.
 */
function apertureRoute(api: Api): ApertureApi {
  return toApertureApi(api) ?? "aperture-openai-completions";
}

/**
 * Dedicated-provider selection: which gateway providers to include and which
 * omp API routes their models. Structurally the extension's
 * `DedicatedProviderConfig`; declared locally so the value module never pulls
 * in config code (and the config loader stays testable without the host).
 */
export interface DedicatedProviderSelection {
  id: string;
  enabled: boolean;
  api?: Api;
}

export function filterProviders(
  providers: ApertureProvider[],
  selection: readonly DedicatedProviderSelection[],
): ApertureProvider[] {
  // Passthrough providers require a client credential Aperture cannot
  // inject; the dedicated provider never sends one, so their models cannot
  // be called. Exclude them regardless of the configured filter.
  const callable = providers.filter(
    (provider) => !provider.requires_client_auth,
  );
  const selected = new Set(selection.filter((p) => p.enabled).map((p) => p.id));
  return selection.length > 0
    ? callable.filter((provider) => selected.has(provider.id))
    : callable;
}

export interface BuildModelsOptions {
  providers: ApertureProvider[];
  gatewayUrl: string;
  baseUrl: string;
  /** Snapshot of omp's registry models, used for metadata and base URLs. */
  registryModels: readonly Model<Api>[];
  modelsDev: ModelsDevCatalog | null;
  /** Api overrides keyed by gateway provider id. */
  apiOverrides?: ReadonlyMap<string, Api>;
  notify?: (warning: string) => void;
}

/**
 * Build omp `ModelSpec` rows for the dedicated `aperture` provider.
 *
 * Model ids are `provider/model-id` on the gateway. omp resolves model
 * references per provider, so the qualified id is what the picker shows and
 * what reaches Aperture; the gateway strips the routing prefix server-side.
 * Only chat rows carry the route's `api`; judge rows keep the System One api
 * but get the gateway base URL for it. Every Aperture api is a chat transport
 * (`apiServesKind(api, "chat")`), so no kind check is needed here.
 */
export function buildModels(options: BuildModelsOptions): ModelSpec[] {
  const {
    providers,
    gatewayUrl,
    baseUrl,
    registryModels,
    modelsDev,
    apiOverrides,
    notify,
  } = options;

  // Look up native upstream base URLs from omp's model registry. Prefer a
  // provider-id match (same naming as the gateway), then a model-id match
  // (model ids are upstream-standardized, so they survive provider renaming).
  // Skip models already rewritten to the gateway (the dedicated `aperture`
  // provider and proxy-rewritten providers): only native upstream URLs are
  // useful signals for the /v1 inference.
  const upstreamByProvider = new Map<string, string>();
  const upstreamByModel = new Map<string, string>();
  for (const m of registryModels) {
    if (!m.baseUrl) continue;
    if (m.baseUrl === gatewayUrl || m.baseUrl === baseUrl) continue;
    if (m.provider && !upstreamByProvider.has(m.provider)) {
      upstreamByProvider.set(m.provider, m.baseUrl);
    }
    if (!upstreamByModel.has(m.id)) {
      upstreamByModel.set(m.id, m.baseUrl);
    }
  }

  // Metadata matching excludes the dedicated provider's own registry entries:
  // they carry the safe defaults from a previous sync and would shadow real
  // metadata on re-sync.
  const metadataRegistry = registryModels.filter(
    (m) => m.provider !== DEDICATED_PROVIDER_ID && m.kind !== "judge",
  );

  const models: ModelSpec[] = [];

  for (const provider of providers) {
    const override = apiOverrides?.get(provider.id);
    let api: Api;
    if (override && isSelectableApi(override, provider.compatibility)) {
      api = override;
    } else {
      if (override) {
        notify?.(
          `[aperture] api override "${override}" for dedicated provider ${provider.id} is not served by the gateway; using the auto-picked api.`,
        );
      }
      api = getApiForCompatibility(provider.compatibility);
    }
    const providerUpstream = upstreamByProvider.get(provider.id);
    for (const modelId of provider.models) {
      const modelInfo = provider.modelInfoById[modelId];
      // Fall back to a model-id lookup when the provider id does not match a
      // native omp provider (e.g. a custom Aperture provider name).
      const upstreamBaseUrl = providerUpstream ?? upstreamByModel.get(modelId);
      const metadata = resolveModelMetadata(provider.id, modelId, {
        registryModels: metadataRegistry,
        modelsDev,
      });

      if (modelInfo?.system_one === true) {
        models.push({
          ...buildClassifierModelConfig({
            id: `${provider.id}/${modelId}`,
            name: modelId,
            pricing: modelInfo.pricing,
            limits: {
              context_window_tokens: modelInfo.context_window_tokens,
            },
            metadata,
          }),
          api: APERTURE_SYSTEM_ONE_API,
          kind: "judge",
          // The typesafe wire appends `/v1/systemone` itself, so the base URL
          // must be the gateway ROOT. Falling through `getBaseUrlForApi` would
          // yield `{gateway}/v1` and post to `/v1/v1/systemone`.
          baseUrl: systemOneBaseUrl(gatewayUrl),
        });
        continue;
      }

      // Only apis that serve `chat` may carry ordinary models. A gateway
      // provider advertising only judge endpoints still has non-system-one
      // models; their auto-picked api is openai-completions, which serves chat.
      const spec: ModelSpec = {
        ...buildDefaultModelConfig({
          id: `${provider.id}/${modelId}`,
          name: modelId,
          providerId: provider.id,
          provider: { id: provider.id, name: provider.name },
          pricing: modelInfo?.pricing,
          limits: {
            context_window_tokens: modelInfo?.context_window_tokens,
            max_output_tokens: modelInfo?.max_output_tokens,
          },
          metadata,
        }),
        api: apertureRoute(api),
        baseUrl: getBaseUrlForApi(api, gatewayUrl, baseUrl, upstreamBaseUrl),
      };
      models.push(spec);
    }
  }

  return models;
}

export interface FetchCatalogOptions extends BuildModelsOptions {
  /**
   * Which gateway providers to include. The fetched catalog is filtered with
   * this selection and the result replaces `providers`, whose shape is the
   * gateway catalog (not the selection).
   */
  readonly selection?: readonly DedicatedProviderSelection[];
  signal?: AbortSignal;
}

/**
 * Fetch the gateway catalog, resolve metadata, and build model specs.
 *
 * Network failures propagate so the host can report them; the caller keeps
 * the previous catalog (the host's cache replays the last good rows).
 */
export async function fetchApertureCatalog(
  options: FetchCatalogOptions,
): Promise<ModelSpec[]> {
  const client = new ApertureClient(options.gatewayUrl);
  const [gatewayProviders, modelsDev] = await Promise.all([
    client.providers(options.signal),
    fetchModelsDevCatalog({ signal: options.signal }),
  ]);
  // `providers` on the options are the gateway catalog; the selection is what
  // narrows it. Without a selection every callable provider is included.
  const callable = filterProviders(
    gatewayProviders,
    options.selection ?? selectionOf(options),
  );
  return buildModels({ ...options, providers: callable, modelsDev });
}

/**
 * The selection filter for a build: `apiOverrides` keys are the enabled set
 * when present, otherwise every provider the caller listed. Keeping this in
 * one place means the api override map and the filter never disagree.
 */
function selectionOf(
  options: BuildModelsOptions,
): DedicatedProviderSelection[] {
  return [...(options.apiOverrides?.keys() ?? [])].map((id) => ({
    id,
    enabled: true,
  }));
}

/**
 * Identity of the catalog a cache entry represents: gateway origin plus the
 * normalized provider selection, with api overrides recorded as `id@api` so
 * rows built for a different routing api are never replayed.
 */
export function buildCatalogKey(
  gatewayUrl: string,
  providers: readonly DedicatedProviderSelection[],
): string {
  let origin: string;
  try {
    origin = new URL(gatewayUrl).origin;
  } catch {
    origin = gatewayUrl;
  }
  const enabled = providers
    .filter((p) => p.enabled)
    .map((p) => (p.api ? `${p.id}@${p.api}` : p.id))
    .sort();
  const filter = providers.length === 0 ? "*" : enabled.join(",");
  return `${origin} ${filter} v3`;
}
