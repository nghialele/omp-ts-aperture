/**
 * Config migrations. Existing user config must keep working across releases,
 * so every format change adds a migration here instead of silently dropping
 * fields.
 */

import type { ApertureConfig, RoutableApi } from "./types";

export interface Migration<TFrom = Record<string, unknown>, TTo = TFrom> {
  name: string;
  /** Version that shipped this migration. */
  version?: string;
  shouldRun: (config: TFrom) => boolean;
  run: (config: TFrom) => TTo;
}

interface LegacyProviderEntry {
  id: string;
  gatewayId?: string;
  enabled?: boolean;
  api?: RoutableApi;
}

interface LegacyProxy {
  enabled?: boolean;
  upstreamProviders?: LegacyProviderEntry[];
}

interface LegacyDedicated {
  enabled?: boolean;
  providers?: {
    id: string;
    name?: string;
    enabled: boolean;
    api?: RoutableApi;
  }[];
  cachedModels?: unknown[];
}

/** Any historical on-disk shape; migrations narrow it toward `ApertureConfig`. */
interface LegacyConfig extends Omit<ApertureConfig, "proxy" | "dedicated"> {
  mode?: "proxy" | "dedicated";
  providers?: string[];
  checkGatewayModels?: string[];
  apertureProvider?: boolean;
  connectors?: {
    enabled?: boolean;
    pinnedTools?: { connectorId: string; toolName: string }[];
    discoveryTools?: boolean;
  };
  proxy?: LegacyProxy;
  dedicated?: LegacyDedicated;
}

/**
 * Pre-multi-capability configs (`providers`, `checkGatewayModels`,
 * `apertureProvider`) and pre-`mode` configs collapse into capabilities.
 */
const legacyToCapabilities: Migration<LegacyConfig> = {
  name: "001-legacy-to-capabilities",
  version: "0.6.0",
  shouldRun: (config) =>
    config.providers !== undefined ||
    config.checkGatewayModels !== undefined ||
    config.apertureProvider !== undefined ||
    (config.onboardingDone === undefined && config.baseUrl !== undefined),
  run: (config) => {
    const migrated: LegacyConfig = { ...config };
    const hadProviders =
      config.providers !== undefined || config.checkGatewayModels !== undefined;

    if (hadProviders) {
      const providers = config.providers ?? [];
      migrated.proxy = {
        ...migrated.proxy,
        enabled: true,
        upstreamProviders: providers.map((id) => ({ id, gatewayId: id })),
      };
      delete migrated.providers;
      delete migrated.checkGatewayModels;
    }
    if (config.apertureProvider !== undefined) {
      migrated.dedicated = {
        ...migrated.dedicated,
        enabled: config.apertureProvider,
      };
      delete migrated.apertureProvider;
    }
    if (migrated.onboardingDone === undefined && config.baseUrl !== undefined) {
      migrated.onboardingDone = true;
    }
    return migrated;
  },
};

/** `mode: "proxy" | "dedicated"` becomes the corresponding capability toggle. */
const modeToCapabilities: Migration<LegacyConfig> = {
  name: "002-mode-to-capabilities",
  version: "0.7.0",
  shouldRun: (config) => config.mode !== undefined,
  run: (config) => {
    const { mode, ...rest } = config;
    const migrated: LegacyConfig = { ...rest };
    if (mode === "proxy") {
      migrated.proxy = { ...migrated.proxy, enabled: true };
      migrated.dedicated = { ...migrated.dedicated, enabled: false };
    } else if (mode === "dedicated") {
      migrated.dedicated = { ...migrated.dedicated, enabled: true };
      migrated.proxy = { ...migrated.proxy, enabled: false };
    }
    return migrated;
  },
};

/** Fill capability defaults and drop the legacy cached-model snapshot. */
const normalizeCapabilities: Migration<LegacyConfig> = {
  name: "003-normalize-capabilities",
  version: "0.8.0",
  shouldRun: (config) =>
    config.proxy?.enabled === undefined ||
    config.proxy?.upstreamProviders === undefined ||
    config.dedicated?.enabled === undefined ||
    config.dedicated?.providers === undefined ||
    config.dedicated?.cachedModels !== undefined,
  run: (config) => {
    const { cachedModels: _dropped, ...dedicated } = config.dedicated ?? {};
    return {
      ...config,
      proxy: {
        ...config.proxy,
        enabled: config.proxy?.enabled ?? false,
        upstreamProviders: config.proxy?.upstreamProviders ?? [],
      },
      dedicated: {
        ...dedicated,
        enabled: config.dedicated?.enabled ?? true,
        providers: config.dedicated?.providers ?? [],
      },
    } satisfies LegacyConfig;
  },
};

/** `proxy.upstreamProviders[].gatewayId` becomes required, defaulting to `id`. */
const gatewayId: Migration<LegacyConfig> = {
  name: "004-gateway-id",
  version: "0.16.0",
  shouldRun: (config) =>
    config.proxy?.upstreamProviders?.some((p) => p.gatewayId === undefined) ??
    false,
  run: (config) => ({
    ...config,
    proxy: {
      ...config.proxy,
      upstreamProviders: config.proxy?.upstreamProviders?.map((p) => ({
        ...p,
        gatewayId: p.gatewayId ?? p.id,
      })),
    },
  }),
};

/** Tool pinning moved to omp's `mcp.json`; drop the extension-side lists. */
const nativeMcpConnectors: Migration<LegacyConfig> = {
  name: "005-native-mcp-connectors",
  version: "0.17.0",
  shouldRun: (config) =>
    config.connectors?.pinnedTools !== undefined ||
    config.connectors?.discoveryTools !== undefined,
  run: (config) => {
    const {
      pinnedTools: _pinnedTools,
      discoveryTools: _discoveryTools,
      ...connectors
    } = config.connectors ?? {};
    return { ...config, connectors };
  },
};

/** `connectors` is renamed to `mcp`. */
const mcpRename: Migration<LegacyConfig> = {
  name: "006-mcp-rename",
  version: "0.18.0",
  shouldRun: (config) => config.connectors !== undefined && !("mcp" in config),
  run: (config) => {
    const { connectors, ...rest } = config;
    return { ...rest, mcp: connectors };
  },
};

export const migrations: Migration<LegacyConfig>[] = [
  legacyToCapabilities,
  modeToCapabilities,
  normalizeCapabilities,
  gatewayId,
  nativeMcpConnectors,
  mcpRename,
];
