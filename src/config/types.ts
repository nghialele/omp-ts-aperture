/**
 * Aperture config as stored on disk (`~/.omp/agent/aperture.json`).
 *
 * Global-only: Aperture is a network concern, not a project one, so there is
 * no project scope and no per-cwd override. Ported from the Pi extension's
 * `extensions/shared/config/types.ts`; the capability model
 * (dedicated/proxy/mcp) is unchanged.
 */

/** omp APIs derivable from a gateway provider's compatibility map. */
export type RoutableApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai"
  | "google-vertex"
  | "bedrock-converse-stream";

export interface ProxiedProviderConfig {
  /** Local omp provider id. */
  id: string;
  /** Gateway provider id used for routing; may differ from the local id. */
  gatewayId: string;
  /**
   * Proxy this provider through Aperture (default true). Set false to
   * keep per-provider settings without proxying the provider.
   */
  enabled?: boolean;
  /**
   * Route this provider's models through a specific omp API instead of the
   * auto-detected one. Validated against the gateway compatibility map on
   * every sync; falls back to auto with a warning when not served.
   */
  api?: RoutableApi;
  /** Warn when configured local models are missing from the Aperture gateway. */
  shouldCheckGatewayModels?: boolean;
}

export interface DedicatedProviderConfig {
  /** Aperture provider id. */
  id: string;
  /** Optional display name override. */
  name?: string;
  /** Include this provider's models in the dedicated provider. */
  enabled: boolean;
  /**
   * Route this provider's models through a specific omp API instead of the
   * one auto-picked from the compatibility map. Validated on every catalog
   * refresh; falls back to auto with a warning when not served.
   */
  api?: RoutableApi;
}

/**
 * MCP tools configuration.
 *
 * `enabled` gates the whole feature. When true, `/aperture:settings` writes
 * the gateway's `/v1/mcp` endpoint into omp's `mcp.json` as the `aperture`
 * server; omp then owns the connection and per-tool exposure.
 */
export interface McpConfig {
  enabled?: boolean;
}

export interface ApertureConfig {
  /** Config schema version, stamped by content-gated migrations. */
  version?: string;
  /** Aperture gateway base URL (e.g. `https://aperture.example.com`). */
  baseUrl?: string;
  /** Whether onboarding has been completed. */
  onboardingDone?: boolean;
  /**
   * Inject provenance headers (`Referer: https://pi.dev`, `x-session-id`)
   * on provider requests routed through Aperture. Defaults to `true`.
   */
  shouldSendProvenanceHeaders?: boolean;
  onboarding?: {
    /** Whether the onboarding command is offered. */
    enabled?: boolean;
  };
  proxy?: {
    /** Reroute selected omp providers through Aperture. */
    enabled?: boolean;
    upstreamProviders?: ProxiedProviderConfig[];
  };
  dedicated?: {
    /** Register a standalone `aperture` provider from gateway models. */
    enabled?: boolean;
    providers?: DedicatedProviderConfig[];
  };
  mcp?: McpConfig;
}

export interface ResolvedConfig {
  baseUrl: string;
  onboardingDone: boolean;
  shouldSendProvenanceHeaders: boolean;
  onboarding: {
    enabled: boolean;
  };
  proxy: {
    enabled: boolean;
    upstreamProviders: (Required<
      Omit<
        ProxiedProviderConfig,
        "api" | "enabled" | "shouldCheckGatewayModels"
      >
    > &
      Pick<
        ProxiedProviderConfig,
        "api" | "enabled" | "shouldCheckGatewayModels"
      >)[];
  };
  dedicated: {
    enabled: boolean;
    providers: DedicatedProviderConfig[];
  };
  mcp: {
    enabled: boolean;
  };
}

/** Narrows a gateway-provided pi api onto a `RoutableApi` value. */
export function isRoutableApi(value: string): value is RoutableApi {
  return (
    value === "openai-completions" ||
    value === "openai-responses" ||
    value === "anthropic-messages" ||
    value === "google-generative-ai" ||
    value === "google-vertex" ||
    value === "bedrock-converse-stream"
  );
}
