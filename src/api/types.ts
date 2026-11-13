/**
 * Aperture gateway API shapes, validated with omptype.
 *
 * Ported from the Pi extension's pi-schema definitions. omp validates tool
 * inputs with omptype (ArkType-compatible), so the same declarations are
 * expressed against `@oh-my-pi/omptype`; the field semantics are unchanged and
 * intentionally permissive (`+` allows extra upstream fields).
 */
import { type } from "@oh-my-pi/omptype";

export const ProviderCompatibilitySchema = type({
  "openai_chat?": "boolean",
  "openai_responses?": "boolean",
  "anthropic_messages?": "boolean",
  "gemini_generate_content?": "boolean",
  "google_generate_content?": "boolean",
  "google_raw_predict?": "boolean",
  "bedrock_model_invoke?": "boolean",
  "bedrock_converse?": "boolean",
  "experimental_gemini_cli_vertex_compat?": "boolean",
  "+": "ignore",
});

export type ProviderCompatibility = typeof ProviderCompatibilitySchema.infer;

/**
 * Per-token USD pricing for a model, as reported by Aperture's `/v1/models`.
 *
 * All fields are per-token USD strings (e.g. `"0.00000100"`).
 * `web_search` and `input_cache_write_1h` have no direct mapping in omp's
 * model `cost` and are ignored when building model specs.
 */
export const ApertureModelPricingSchema = type({
  "input?": "string",
  "input_cache_read?": "string",
  "input_cache_write?": "string",
  "input_cache_write_1h?": "string",
  "output?": "string",
  "web_search?": "string",
  "+": "ignore",
});

export type ApertureModelPricing = typeof ApertureModelPricingSchema.infer;

export const ApertureModelInfoSchema = type({
  id: "string",
  "pricing?": ApertureModelPricingSchema,
  /** Maximum input the model accepts, as advertised for this route. */
  "context_window_tokens?": "number.integer >= 0",
  /** Maximum tokens the model can produce, as advertised for this route. */
  "max_output_tokens?": "number.integer >= 0",
  /** The gateway serves this model over the System One classifier protocol. */
  "system_one?": "boolean",
  "+": "ignore",
});

export type ApertureModelInfo = typeof ApertureModelInfoSchema.infer;

/**
 * Token limits a gateway entry advertises for a model. They describe the
 * route the request takes, not the model, so they outrank catalog metadata.
 * Non-positive values mean "not reported" (the gateway clamps zeroed limits
 * to absent).
 */
export type ApertureModelLimits = Pick<
  ApertureModelInfo,
  "context_window_tokens" | "max_output_tokens"
>;

/** A `/v1/models` entry. */
export const ApertureModelEntrySchema = type({
  id: "string",
  metadata: {
    provider: {
      id: "string",
      "name?": "string",
      "description?": "string",
      "requires_client_auth?": "boolean",
      "+": "ignore",
    },
    "+": "ignore",
  },
  "supported_endpoints?": "string[]",
  "pricing?": ApertureModelPricingSchema,
  "context_window_tokens?": "number.integer >= 0",
  "max_output_tokens?": "number.integer >= 0",
  "+": "ignore",
});

export type ApertureModelEntry = typeof ApertureModelEntrySchema.infer;

export const ApertureProviderSchema = type({
  id: "string",
  name: "string",
  description: "string",
  models: "string[]",
  compatibility: ProviderCompatibilitySchema,
  // Set by `auth_mode: "passthrough"` providers: the gateway forwards the
  // client's own credential, so the client must send a real one.
  "requires_client_auth?": "boolean",
  // Per-model info from `/v1/models` (pricing), keyed by model id.
  modelInfoById: type({ "[string]": ApertureModelInfoSchema }),
  "+": "ignore",
});

export type ApertureProvider = typeof ApertureProviderSchema.infer;

export const ConnectorInfoSchema = type({
  id: "string",
  "description?": "string",
  "protocol?": "string",
  "provider?": "string",
  "category?": "string",
  "status?": "string",
  "auth_type?": "string",
  "+": "ignore",
});

export type ConnectorInfo = typeof ConnectorInfoSchema.infer;
