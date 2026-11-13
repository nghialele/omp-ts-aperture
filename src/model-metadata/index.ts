/**
 * Model metadata resolution for the Aperture catalog.
 *
 * Aperture's `/v1/models` only reports model ids and pricing, so capability
 * metadata (vision input, reasoning, thinking levels, names) must come from
 * elsewhere. This module layers two sources on top of the safe defaults:
 *
 * 1. models.dev catalog (`models-dev.ts`) - broad coverage, fetched
 *    best-effort at refresh time.
 * 2. omp's native model registry (`pi-registry.ts`) - authoritative when it
 *    knows the model (includes canonical `thinking` metadata and `compat`,
 *    which models.dev lacks).
 *
 * The registry wins over models.dev; gateway pricing is applied later by the
 * caller and wins over both.
 */

import type { Api, Model } from "@oh-my-pi/pi-ai";
import { applyModelsDevMetadata, type ModelsDevCatalog } from "./models-dev";
import { applyRegistryMetadata } from "./pi-registry";
import type { ModelMetadata } from "./types";

export {
  fetchModelsDevCatalog,
  MODELS_DEV_URL,
  type ModelsDevCatalog,
  type ModelsDevModel,
} from "./models-dev";
export type { ModelMetadata } from "./types";

export interface ModelMetadataSources {
  /**
   * omp registry models to match against. The caller must pre-filter models
   * that would self-reference (e.g. the dedicated `aperture` provider's own
   * previously registered models, which carry the safe defaults).
   */
  registryModels?: readonly Model<Api>[];
  modelsDev?: ModelsDevCatalog | null;
}

/**
 * Resolve capability metadata for one gateway model.
 *
 * Applies models.dev first, then the omp registry on top (registry wins where
 * both know the model). Returns only the fields a source actually provided;
 * the caller merges over safe defaults and applies gateway pricing last.
 */
export function resolveModelMetadata(
  providerId: string,
  modelId: string,
  sources: ModelMetadataSources,
): ModelMetadata {
  const metadata: ModelMetadata = {};

  if (sources.modelsDev) {
    applyModelsDevMetadata(metadata, sources.modelsDev, providerId, modelId);
  }

  if (sources.registryModels && sources.registryModels.length > 0) {
    applyRegistryMetadata(
      metadata,
      sources.registryModels,
      providerId,
      modelId,
    );
  }

  return metadata;
}
