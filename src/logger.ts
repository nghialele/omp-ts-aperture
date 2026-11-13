/**
 * Extension-side logging.
 *
 * `warn` intentionally avoids `@oh-my-pi/pi-utils`'s logger at module scope:
 * that package's `dirs.ts` imports the native path helper, and pi-natives loads
 * its `.node` addon eagerly on import. Inside the omp binary that is fine, but
 * it makes the config loader impossible to exercise from plain unit tests
 * (and from any host that does not ship the addon). `pi.logger` is still used
 * where a host-owned logger is already available.
 */

export type LogFn = (
  message: string,
  context?: Record<string, unknown>,
) => void;

function stderrWrite(message: string): void {
  process.stderr.write(`${message}\n`);
}

/** Warning sink; replaced by the extension with `pi.logger.warn` at load. */
let warnImpl: LogFn = (message) => stderrWrite(`[aperture] ${message}`);

export function setLogger(impl: { warn: LogFn } | undefined): void {
  warnImpl = impl?.warn ?? ((message) => stderrWrite(`[aperture] ${message}`));
}

export function warn(message: string, context?: Record<string, unknown>): void {
  const suffix = context
    ? ` ${Object.entries(context)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ")}`
    : "";
  warnImpl(`${message}${suffix}`);
}
