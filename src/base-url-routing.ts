/**
 * Shared base-URL routing logic for proxy and dedicated modes.
 *
 * Ported from the Pi extension. omp models carry the same `api`/`baseUrl`
 * pair, so the gateway URL construction (Aperture appends the incoming
 * request path to the provider's `baseurl`) is unchanged.
 *
 * Two exports:
 *
 * - `shouldUseGatewayRoot` — the low-level gateway-root-vs-`gateway/v1`
 *   decision, kept for direct testing.
 * - `getBaseUrlForApi` — the per-API resolver both modes call. It maps
 *   Anthropic/Gemini/Vertex/Bedrock to their fixed gateway paths and falls
 *   back to `shouldUseGatewayRoot` for the OpenAI-SDK APIs.
 */

import type { Api } from "@oh-my-pi/pi-ai";

const ROOT_BASE_URL_APIS = new Set<Api>([
  // The Anthropic adapter uses Anthropic's SDK, which appends /v1/messages
  // itself. Registering /v1 would produce /v1/v1/messages.
  "anthropic-messages",
  // The Codex adapter appends /codex/responses itself.
  "openai-codex-responses",
]);

// omp passes `model.baseUrl` straight to the OpenAI SDK for these APIs, which
// then appends /chat/completions or /responses.
const OPENAI_SDK_APIS = new Set<Api>([
  "openai-completions",
  "openai-responses",
  "azure-openai-responses",
]);

/**
 * `true` when `baseUrl`'s pathname ends in a version segment that is NOT `/v1`
 * (e.g. `/v4`, `/v4beta`, `/v2rc1`). Such providers need a versionless client
 * path because Aperture would otherwise double the version (`/v4/v1/...`).
 */
export function hasNonV1VersionPath(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false;
  try {
    const path = new URL(baseUrl).pathname.replace(/\/+$/u, "");
    const match = path.match(/\/(v\d+\w*)$/u);
    return match !== null && match[1] !== "v1";
  } catch {
    return false;
  }
}

/**
 * Whether a model should register against the Aperture gateway root instead of
 * `gateway/v1`.
 *
 * - Anthropic and Codex always use the root (their SDKs/adapter append the full
 *   API path themselves).
 * - OpenAI SDK APIs use the root only when the upstream base URL ends in a
 *   non-`/v1` version segment (e.g. Z.ai `/api/coding/paas/v4`).
 * - Other APIs keep the conservative `gateway/v1` behavior.
 */
export function shouldUseGatewayRoot(
  api: Api,
  upstreamBaseUrl?: string,
): boolean {
  if (ROOT_BASE_URL_APIS.has(api)) return true;
  if (!OPENAI_SDK_APIS.has(api)) return false;
  return hasNonV1VersionPath(upstreamBaseUrl);
}

/**
 * Whether the given API embeds the model id in the request URL path
 * (Gemini `/v1beta/models/{id}:...`, Vertex, Bedrock `/model/{id}/...`)
 * instead of the JSON body.
 *
 * Aperture strips the `provider/` routing prefix from body-carried model
 * fields but only accepts bare ids in URL paths.
 */
export function embedsModelIdInPath(api: string): boolean {
  switch (api) {
    case "google-generative-ai":
    case "google-vertex":
    case "bedrock-converse-stream":
      return true;
    default:
      return false;
  }
}

/**
 * Per-API gateway base URL shared by proxy and dedicated modes.
 *
 * `gatewayUrl` is the bare gateway origin (no path); `baseUrl` is the
 * conservative `${gatewayUrl}/v1` used as the OpenAI-SDK fallback.
 */
export function getBaseUrlForApi(
  api: Api,
  gatewayUrl: string,
  baseUrl: string,
  upstreamBaseUrl?: string,
): string {
  switch (api) {
    case "anthropic-messages":
      return gatewayUrl;
    case "google-generative-ai":
      return `${gatewayUrl}/v1beta`;
    case "google-vertex":
      return `${gatewayUrl}/v1`;
    // Aperture's native Bedrock-compatible surface lives at /bedrock, not /v1.
    case "bedrock-converse-stream":
      return `${gatewayUrl}/bedrock`;
    default:
      return shouldUseGatewayRoot(api, upstreamBaseUrl) ? gatewayUrl : baseUrl;
  }
}
