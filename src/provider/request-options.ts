/**
 * Per-request options shared by every Aperture-routed transport.
 *
 * Everything here is read at request time, not baked into model rows: the
 * gateway credential is a placeholder the gateway replaces, the session id
 * changes on fork/resume, and the provenance toggle can be flipped from
 * `/aperture:settings` mid-session.
 */

import type { SimpleStreamOptions, StreamOptions } from "@oh-my-pi/pi-ai";
import { configLoader } from "../config/loader";
import { APERTURE_PLACEHOLDER_API_KEY } from "./catalog";

/**
 * Whether provenance headers should go out on the next request.
 *
 * Read live so a settings change applies without re-registering the apis.
 * Failures fall back to the default (`true`), matching the config default.
 */
export function shouldSendProvenanceHeaders(): boolean {
  try {
    return configLoader.getConfig().shouldSendProvenanceHeaders !== false;
  } catch {
    return true;
  }
}

/**
 * Force the gateway credential and provenance headers onto a request.
 *
 * Aperture injects the upstream key, so the placeholder is the whole
 * credential (routed providers have no stored key to leak). The session id is
 * read from the live session options on every request, matching Pi's
 * per-request `x-session-id` injection: it changes on fork/resume, so it
 * cannot be baked into model rows.
 */
export function apertureRequestOptions<
  TOptions extends SimpleStreamOptions | StreamOptions,
>(
  options: TOptions | undefined,
  provenance: { enabled: boolean } = { enabled: shouldSendProvenanceHeaders() },
): TOptions {
  if (!provenance.enabled) {
    return {
      ...(options ?? {}),
      apiKey: APERTURE_PLACEHOLDER_API_KEY,
    } as TOptions;
  }
  const headers: Record<string, string> = { ...(options?.headers ?? {}) };
  const sessionId = (options as { sessionId?: unknown } | undefined)?.sessionId;
  headers.Referer = "https://pi.dev";
  if (typeof sessionId === "string" && sessionId) {
    headers["x-session-id"] = sessionId;
  }
  return {
    ...(options ?? {}),
    apiKey: APERTURE_PLACEHOLDER_API_KEY,
    headers,
  } as TOptions;
}
