/**
 * Aperture config loader.
 *
 * Stores config at `~/.omp/agent/aperture.json` (respecting omp's agent-dir
 * env overrides), global scope only. Pi's `@aliou/pi-utils-settings` loader is
 * not available in omp, so this module implements the equivalent: read + parse
 * + migrations + defaults merge, with `APERTURE_BASE_URL` winning over the file
 * value (never persisted back).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "../agent-dir";
import { warn } from "../logger";
import { normalizeInputUrl } from "../url";
import { DEFAULT_CONFIG } from "./defaults";
import { type Migration, migrations } from "./migrations";
import type {
  ApertureConfig,
  DedicatedProviderConfig,
  ResolvedConfig,
} from "./types";

export const CONFIG_FILE_NAME = "aperture.json";

export function apertureConfigPath(): string {
  return path.join(getAgentDir(), CONFIG_FILE_NAME);
}

/** Deep-ish merge: nested objects merge, arrays replace. */
function mergeConfig(
  base: ResolvedConfig,
  raw: Partial<ApertureConfig>,
): ResolvedConfig {
  return {
    baseUrl: raw.baseUrl ?? base.baseUrl,
    onboardingDone: raw.onboardingDone ?? base.onboardingDone,
    shouldSendProvenanceHeaders:
      raw.shouldSendProvenanceHeaders ?? base.shouldSendProvenanceHeaders,
    onboarding: {
      enabled: raw.onboarding?.enabled ?? base.onboarding.enabled,
    },
    proxy: {
      enabled: raw.proxy?.enabled ?? base.proxy.enabled,
      upstreamProviders: raw.proxy?.upstreamProviders
        ? raw.proxy.upstreamProviders.map((p) => ({
            id: p.id,
            gatewayId: p.gatewayId || p.id,
            enabled: p.enabled,
            api: p.api,
            shouldCheckGatewayModels: p.shouldCheckGatewayModels,
          }))
        : base.proxy.upstreamProviders,
    },
    dedicated: {
      enabled: raw.dedicated?.enabled ?? base.dedicated.enabled,
      providers: (raw.dedicated?.providers ?? base.dedicated.providers).map(
        (p): DedicatedProviderConfig & { enabled: boolean } => ({
          id: p.id,
          name: p.name,
          enabled: p.enabled,
          api: p.api,
        }),
      ),
    },
    mcp: {
      enabled: raw.mcp?.enabled ?? base.mcp.enabled,
    },
  };
}

/** Apply migrations in order, stopping when none applies. */
export function migrate(raw: Record<string, unknown>): Record<string, unknown> {
  let current = raw;
  for (const migration of migrations as unknown as Migration<
    Record<string, unknown>,
    Record<string, unknown>
  >[]) {
    if (!migration.shouldRun(current)) continue;
    current = migration.run(current);
  }
  return current;
}

/** Resolve a raw config object into the effective runtime config. */
export function resolveConfig(raw: ApertureConfig): ResolvedConfig {
  const migrated = migrate(raw as Record<string, unknown>) as ApertureConfig;
  const merged = mergeConfig(DEFAULT_CONFIG, migrated);
  const envUrl = process.env.APERTURE_BASE_URL?.trim();
  if (envUrl) {
    return { ...merged, baseUrl: normalizeInputUrl(envUrl) };
  }
  return merged;
}

/** A missing config file is normal; anything else is worth a log line. */
function debugReadFailure(error: unknown): void {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") return;
  warn(
    `could not read config: ${error instanceof Error ? error.message : String(error)}`,
  );
}

function parseConfigFile(text: string): ApertureConfig {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as ApertureConfig;
    }
  } catch (error) {
    warn(
      `[aperture] failed to parse ${apertureConfigPath()}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {};
}

export class ConfigLoader {
  #resolved: ResolvedConfig;
  /**
   * Explicit path, or `undefined` to resolve `aperture.json` under the active
   * agent dir on every access. Resolving lazily matters: omp snapshots the
   * agent dir at module load, but tests and profile switches reposition it, and
   * a path captured in the constructor would silently keep reading the old one.
   */
  #explicitPath: string | undefined;

  constructor(filePath?: string) {
    this.#explicitPath = filePath;
    this.#resolved = resolveConfig({});
  }

  get path(): string {
    return this.#explicitPath ?? apertureConfigPath();
  }

  getConfig(): ResolvedConfig {
    return this.#resolved;
  }

  /** Re-read from disk, applying migrations and env overrides. */
  load(): ResolvedConfig {
    let raw: ApertureConfig = {};
    try {
      raw = parseConfigFile(fs.readFileSync(this.path, "utf-8"));
    } catch (error) {
      // Missing or unreadable file: defaults win. `parseConfigFile` already
      // logs malformed JSON, so this only reports an unreadable path.
      debugReadFailure(error);
    }
    this.#resolved = resolveConfig(raw);
    return this.#resolved;
  }

  /**
   * Merge a patch into the on-disk config and reload. Returns the effective
   * resolved config (including env overrides).
   */
  update(patch: Partial<ApertureConfig>): ResolvedConfig {
    let existing: ApertureConfig = {};
    try {
      existing = parseConfigFile(fs.readFileSync(this.path, "utf-8"));
    } catch (error) {
      // No existing file to merge into: the patch becomes the whole config.
      debugReadFailure(error);
    }
    const next = { ...existing, ...patch };
    this.write(next);
    return this.load();
  }

  /**
   * Repoint the loader at another file and drop cached state (tests only:
   * the extension shares the process-wide instance).
   */
  reloadForTests(filePath: string | undefined): void {
    this.#explicitPath = filePath;
    this.#resolved = resolveConfig({});
  }

  /** Persist a full config object. Parent directories are created. */
  write(config: ApertureConfig): void {
    const target = this.path;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
    fs.renameSync(tmp, target);
  }
}

/** Process-wide loader, shared by the extension and the settings command. */
export const configLoader = new ConfigLoader();

export type {
  ApertureConfig,
  DedicatedProviderConfig,
  McpConfig,
  ProxiedProviderConfig,
  ResolvedConfig,
  RoutableApi,
} from "./types";
