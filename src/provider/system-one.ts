/**
 * System One judge support for the dedicated Aperture provider.
 *
 * Aperture advertises per-model endpoints in `/v1/models`; a model served over
 * `/v1/systemone` is a *judgment* model, not a chat model. omp runs the judge
 * role through pi-ai's native wires, which dispatch by api (`typesafe`,
 * `liquid-systemone`, ...) and post `{model, state, questions}` to a fixed path
 * under the model's base URL.
 *
 * The dedicated `aperture` provider reuses pi-ai's `typesafe` wire verbatim,
 * so the only thing this module owns is the base URL: that wire appends
 * `/v1/systemone` to the model's base URL, which must therefore be the gateway
 * root, not the gateway's `/v1`.
 *
 * Credentials, headers, and routing all come from the model row and stream
 * options like any other judge model; there is no extension-side state.
 */

import type { Api } from "@oh-my-pi/pi-ai";

/** omp api the dedicated provider declares for System One judge models. */
export const APERTURE_SYSTEM_ONE_API = "typesafe" satisfies Api;

/** Base URL the model declares so the wire lands on `{gateway}/v1/systemone`. */
export function systemOneBaseUrl(gatewayUrl: string): string {
  return gatewayUrl.replace(/\/+$/u, "");
}
