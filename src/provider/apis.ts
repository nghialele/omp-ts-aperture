/**
 * Custom omp APIs that route a model through the Aperture gateway.
 *
 * omp dispatches on `model.api`. Aperture is a gateway, not a provider
 * protocol: the right wire format and URL path depend on the *upstream*
 * provider, and the credential is injected server-side. The dedicated
 * `aperture` provider therefore registers each supported upstream transport
 * under an Aperture-specific api name and points it at the gateway
 * (`catalog.ts` decides which api a model gets).
 *
 * Each adapter delegates to the matching built-in transport in pi-ai's
 * `stream()` dispatcher and stamps the gateway credential on the request.
 * This mirrors the Pi extension's delegation through pi-ai's compat registry.
 */

import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ModelSpec,
  SimpleStreamOptions,
  StreamOptions,
} from "@oh-my-pi/pi-ai";
import { registerCustomApi, stream } from "@oh-my-pi/pi-ai";
import { embedsModelIdInPath } from "../base-url-routing";
import {
  APERTURE_API_UPSTREAM,
  APERTURE_APIS,
  APERTURE_PLACEHOLDER_API_KEY,
  type ApertureApi,
} from "./catalog";
import type { ApertureStreamAdapter } from "./proxy";
import { apertureRequestOptions } from "./request-options";

/**
 * Re-enter omp's provider dispatch for a model whose `api` names a built-in
 * transport. pi-ai's non-custom `streamDispatch` is not exported, but the
 * public `stream()` routes by api and only consults the custom registry for
 * non-built-in names, so rewriting the api first is enough.
 */
function streamDispatch(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | StreamOptions,
): AssistantMessageEventStream {
  return stream(model, context, options as Parameters<typeof stream>[2]);
}

export {
  APERTURE_API_UPSTREAM,
  APERTURE_APIS,
  APERTURE_PLACEHOLDER_API_KEY,
  type ApertureApi,
};

/**
 * Strip the `provider/` catalog prefix for path-embedding APIs. The gateway
 * forwards Gemini/Vertex/Bedrock URL paths verbatim upstream, so the qualified
 * id the picker shows would 404; the bare id still routes because the gateway
 * resolves it provider-side.
 *
 * `upstreamApi` decides this, not `model.api`: adapters receive the model
 * still tagged with its Aperture api (`aperture-google-generative-ai`), and
 * only the underlying transport knows whether the id travels in the path.
 */
export function requestModel<TApi extends Api>(
  model: Model<TApi>,
  upstreamApi: string = model.api,
): Model<TApi> {
  if (!embedsModelIdInPath(upstreamApi)) return model;
  const slash = model.id.indexOf("/");
  if (slash === -1) return model;
  return { ...model, id: model.id.slice(slash + 1) };
}

/** Force the gateway credential onto a request without disturbing caller options. */
function withGatewayAuth<TOptions extends SimpleStreamOptions | StreamOptions>(
  options: TOptions | undefined,
): TOptions {
  return apertureRequestOptions(options);
}

/** Build the delegate for one Aperture api. */
export function createApertureAdapter(api: ApertureApi): ApertureStreamAdapter {
  const upstream = APERTURE_API_UPSTREAM[api];
  return {
    upstream,
    streamSimple: (model, context, options) =>
      streamDispatch(
        { ...requestModel(model, upstream), api: upstream },
        context,
        withGatewayAuth(options),
      ),
    stream: (model, context, options) =>
      streamDispatch(
        { ...requestModel(model, upstream), api: upstream },
        context,
        withGatewayAuth(options),
      ),
  };
}

/** The registered adapters, keyed by Aperture api. */
export function createApertureAdapters(): Map<Api, ApertureStreamAdapter> {
  return new Map(APERTURE_APIS.map((api) => [api, createApertureAdapter(api)]));
}

/**
 * Register every Aperture transport with omp. Safe to call repeatedly: a
 * repeated registration replaces the adapter for the same api.
 *
 * `sourceId` ties the registrations to the extension so omp can clear them
 * when the extension unloads (`unregisterCustomApis(sourceId)`).
 */
export function registerApertureApis(
  sourceId: string,
): Map<Api, ApertureStreamAdapter> {
  const adapters = createApertureAdapters();
  for (const [api, adapter] of adapters) {
    registerCustomApi(api, adapter.streamSimple, sourceId, adapter.stream);
  }
  return adapters;
}

/** Model-row transformation used by tests and diagnostics. */
export type { AssistantMessageEventStream, ModelSpec };
