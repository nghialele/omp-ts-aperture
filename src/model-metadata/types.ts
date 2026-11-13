import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { ModelCost, ThinkingConfig } from "@oh-my-pi/pi-catalog";

/** Resolved metadata overrides for one gateway model. */
export interface ModelMetadata {
  name?: string;
  reasoning?: boolean;
  /** Canonical thinking capability metadata (omp effort surface). */
  thinking?: ThinkingConfig;
  input?: ("text" | "image")[];
  contextWindow?: number;
  maxTokens?: number;
  /** Only set from provider-exact matches; per-million-token USD rates. */
  cost?: ModelCost;
  /** Only set from a provider-exact omp registry match. */
  compat?: Model<Api>["compat"];
}
