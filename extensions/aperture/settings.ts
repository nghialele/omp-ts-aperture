/**
 * `/aperture:settings` for omp.
 *
 * The Pi extension shipped a tabbed TUI editor (@aliou/pi-utils-settings).
 * omp's extension UI is dialog-based (`select`/`input`/`confirm`), so the
 * settings flow here is a short sequential wizard that writes the same config
 * file (`~/.omp/agent/aperture.json`) and immediately re-syncs providers.
 *
 * MCP differs from Pi: omp discovers MCP servers from its own `mcp.json`, so
 * enabling MCP writes the gateway endpoint there (same-name entries win) and
 * the user restarts the session to connect.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@oh-my-pi/pi-coding-agent";
import { getMCPConfigPath } from "../../src/agent-dir";
import { ApertureClient } from "../../src/api/client";
import type { ApertureProvider } from "../../src/api/types";
import { apertureConfigPath, configLoader } from "../../src/config/loader";
import type {
  ApertureConfig,
  ProxiedProviderConfig as ProxiedProvider,
} from "../../src/config/types";
import { warn } from "../../src/logger";
import { DEDICATED_PROVIDER_ID } from "../../src/provider/catalog";
import { resolveGatewayUrl } from "../../src/url";

export interface SettingsDeps {
  /** Snapshot of live registry models (used to list local providers). */
  getRegistryModels: () => readonly Model<Api>[];
}

/** Ping the gateway catalog so a typo'd URL is caught before it is saved. */
async function gatewayReachable(gatewayUrl: string): Promise<boolean> {
  try {
    await new ApertureClient(gatewayUrl).health();
    return true;
  } catch {
    return false;
  }
}

async function fetchProviders(gatewayUrl: string): Promise<ApertureProvider[]> {
  try {
    return await new ApertureClient(gatewayUrl).providers();
  } catch {
    return [];
  }
}

function localProviderIds(
  getRegistryModels: SettingsDeps["getRegistryModels"],
): string[] {
  const ids = new Set<string>();
  for (const model of getRegistryModels()) {
    const provider = model.provider;
    if (typeof provider === "string" && provider !== DEDICATED_PROVIDER_ID) {
      ids.add(provider);
    }
  }
  return [...ids].sort();
}

/** Merge a patch into the on-disk raw config and reload the loader. */
function save(patch: Partial<ApertureConfig>): void {
  configLoader.update(patch);
}

/**
 * Edit one dedicated provider selection via comma-separated gateway ids.
 * An empty answer keeps every gateway provider.
 */
async function editDedicatedProviders(
  ctx: ExtensionCommandContext,
  gatewayUrl: string,
): Promise<ApertureProvider[] | undefined> {
  const providers = await fetchProviders(gatewayUrl);
  if (providers.length === 0) {
    ctx.ui.notify("[aperture] gateway returned no providers.", "warning");
    return undefined;
  }
  const names = providers.map((p) => p.id).join(", ");
  const answer = await ctx.ui.input(
    "Dedicated providers",
    `Include which gateway providers? (blank = all: ${names})`,
  );
  if (answer === undefined) return undefined;
  const selected = answer
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const known = new Set(providers.map((p) => p.id));
  const unknown = selected.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    ctx.ui.notify(
      `[aperture] unknown gateway providers: ${unknown.join(", ")}`,
      "warning",
    );
  }
  save({
    dedicated: {
      enabled: true,
      providers: selected
        .filter((id) => known.has(id))
        .map((id) => ({ id, enabled: true })),
    },
  });
  return providers;
}

/** Pick which local providers to proxy, one confirmation per provider. */
async function editProxyProviders(
  ctx: ExtensionCommandContext,
  gatewayUrl: string,
): Promise<void> {
  const config = configLoader.getConfig();
  const enable = await ctx.ui.confirm(
    "Proxy providers",
    `Reroute existing omp providers through ${gatewayUrl}?`,
  );
  if (!enable) {
    save({ proxy: { enabled: false, upstreamProviders: [] } });
    return;
  }

  const current = new Map(config.proxy.upstreamProviders.map((p) => [p.id, p]));
  const available = localProviderIds(settingsDepsGetModels);
  const upstream: NonNullable<ApertureConfig["proxy"]>["upstreamProviders"] =
    [];
  for (const id of available) {
    const existing = current.get(id) as ProxiedProvider | undefined;
    const selected = await ctx.ui.confirm(
      `Proxy ${id}`,
      existing
        ? `Is already routed through the gateway (gateway id "${existing.gatewayId}"). Keep it routed?`
        : "Route this provider's models through Aperture?",
    );
    if (!selected) continue;
    if (existing) {
      upstream.push(existing);
      continue;
    }
    const gatewayId = await ctx.ui.input(
      `Gateway id for ${id}`,
      `Gateway provider id that serves ${id} (blank = "${id}")`,
    );
    upstream.push({
      id,
      gatewayId: gatewayId?.trim() || id,
      enabled: true,
    });
  }
  save({
    proxy: { enabled: upstream.length > 0, upstreamProviders: upstream },
  });
}

let settingsDepsGetModels: SettingsDeps["getRegistryModels"] = () => [];

async function editMcp(
  ctx: ExtensionCommandContext,
  gatewayUrl: string,
): Promise<void> {
  const enabled = await ctx.ui.confirm(
    "MCP tools",
    `Register ${gatewayUrl}/v1/mcp as the "aperture" MCP server in omp's mcp.json?`,
  );
  save({ mcp: { enabled } });
  writeMcpServer(gatewayUrl, enabled);
  ctx.ui.notify(
    enabled
      ? "[aperture] wrote the aperture MCP server to mcp.json; restart the session to connect."
      : "[aperture] removed the aperture MCP server from mcp.json.",
    "info",
  );
}

/**
 * Add (or remove) the `aperture` entry in the user-scope `mcp.json`. A
 * same-name entry the user added is preserved when enabling is skipped and
 * removed only when it matches what this extension writes.
 */
export function writeMcpServer(gatewayUrl: string, enabled: boolean): void {
  // omp resolves the user-scope mcp.json (profile-aware), so the entry lands
  // exactly where its MCP discovery looks.
  const file = getMCPConfigPath("user");
  let raw: { mcpServers?: Record<string, unknown> } = {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object") {
      raw = parsed as { mcpServers?: Record<string, unknown> };
    }
  } catch (error) {
    // Missing `mcp.json` is normal; a parse failure is the user's file to fix
    // and must not stop us from writing our entry. Log the latter.
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code !== "ENOENT") {
      warn(
        `could not read ${file}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const servers = { ...(raw.mcpServers ?? {}) } as Record<string, unknown>;
  const url = `${gatewayUrl.replace(/\/+$/u, "")}/v1/mcp`;
  const ours = { url, type: "http" };

  if (enabled) {
    servers.aperture = { ...(servers.aperture as object | undefined), ...ours };
  } else {
    const existing = servers.aperture as { url?: unknown } | undefined;
    if (!existing || existing.url === url) delete servers.aperture;
  }

  const next = { ...raw, mcpServers: servers };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
}

/** Register the `/aperture:settings` command. */
export function registerApertureSettings(
  pi: ExtensionAPI,
  resync: (ctx: ExtensionCommandContext) => Promise<void>,
  getRegistryModels: SettingsDeps["getRegistryModels"],
): void {
  settingsDepsGetModels = getRegistryModels;

  pi.registerCommand("aperture:settings", {
    description: "Configure the Aperture gateway (connection, providers, MCP)",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify(
          "[aperture] settings need an interactive session.",
          "warning",
        );
        return;
      }
      configLoader.load();
      const config = configLoader.getConfig();

      const url = await ctx.ui.input(
        "Aperture gateway URL",
        config.baseUrl || "https://ai.pango-lin.ts.net",
      );
      if (url === undefined) return;
      const trimmed = url.trim();
      if (!trimmed) return;
      const gatewayUrl = resolveGatewayUrl({ baseUrl: trimmed });
      if (!gatewayUrl) {
        ctx.ui.notify("[aperture] that URL could not be parsed.", "error");
        return;
      }
      const reachable = await gatewayReachable(gatewayUrl);
      if (!reachable) {
        const proceed = await ctx.ui.confirm(
          "Unreachable gateway",
          `Could not reach ${gatewayUrl}. Save anyway?`,
        );
        if (!proceed) return;
      }
      save({ baseUrl: gatewayUrl, onboardingDone: true });

      const mode = await ctx.ui.select("Capabilities", [
        "Dedicated provider (models from the gateway)",
        "Proxy existing providers",
        "Both",
      ]);
      if (mode === undefined) return;
      const dedicated = mode !== "Proxy existing providers";
      const proxy = mode !== "Dedicated provider (models from the gateway)";
      save({ dedicated: { ...config.dedicated, enabled: dedicated } });

      if (dedicated) await editDedicatedProviders(ctx, gatewayUrl);
      if (proxy) await editProxyProviders(ctx, gatewayUrl);

      const provenance = await ctx.ui.confirm(
        "Provenance headers",
        "Send Referer and session-id headers on gateway requests?",
      );
      save({ shouldSendProvenanceHeaders: provenance });

      await editMcp(ctx, gatewayUrl);

      configLoader.load();
      await resync(ctx);
      ctx.ui.notify(
        "[aperture] settings saved. Providers re-registered; MCP changes apply on restart.",
        "info",
      );
    },
  });

  pi.registerCommand("aperture:proxy", {
    description: "Shortcut: configure Aperture proxied providers",
    handler: async (_args, ctx) => {
      configLoader.load();
      const gatewayUrl = resolveGatewayUrl(configLoader.getConfig());
      if (!gatewayUrl) {
        warn("gateway URL is not configured; run /aperture:settings first");
        return;
      }
      await editProxyProviders(ctx, gatewayUrl);
      await resync(ctx);
      ctx.ui.notify("[aperture] proxy settings saved.", "info");
    },
  });
}

export { apertureConfigPath };
