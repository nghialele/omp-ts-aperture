import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMcpServer } from "../extensions/aperture/settings";
import { getAgentDir, setAgentDir } from "../src/agent-dir";

/**
 * The MCP toggle is the one part of `/aperture:settings` that mutates a file
 * omp also reads, so its ownership rules get direct coverage: write our entry,
 * never clobber a user's same-name entry, and remove only what we wrote.
 */

const GATEWAY = "https://ai.pango-lin.ts.net";

describe("writeMcpServer", () => {
  let dir: string;
  let file: string;

  let originalAgentDir: string;

  beforeEach(() => {
    originalAgentDir = getAgentDir();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aperture-mcp-"));
    // omp snapshots its agent dir at module load, so the supported way to move
    // it (in tests) is `setAgentDir`, not the env var.
    setAgentDir(dir);
    file = path.join(dir, "mcp.json");
  });

  afterEach(() => {
    setAgentDir(originalAgentDir);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function readServers(): Record<string, { url?: string; type?: string }> {
    return JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers;
  }

  test("writes the gateway endpoint as an http server", () => {
    writeMcpServer(GATEWAY, true);
    expect(readServers().aperture).toEqual({
      url: `${GATEWAY}/v1/mcp`,
      type: "http",
    });
  });

  test("preserves unrelated servers and extra fields on its own entry", () => {
    writeMcpServer(GATEWAY, true);
    const servers = readServers();
    servers.github = { url: "https://example.test/mcp" };
    (servers.aperture as Record<string, unknown>).instructions = false;
    fs.writeFileSync(file, JSON.stringify({ mcpServers: servers }));

    writeMcpServer(GATEWAY, false);
    const after = readServers();
    expect(after.aperture).toBeUndefined();
    expect(after.github).toBeDefined();
  });

  test("leaves a user-owned same-name entry alone when disabling", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: { aperture: { url: "https://mine.test/v1/mcp" } },
      }),
    );
    writeMcpServer(GATEWAY, false);
    expect(readServers().aperture.url).toBe("https://mine.test/v1/mcp");
  });

  test("enabling updates the URL of an existing aperture entry", () => {
    fs.writeFileSync(
      file,
      JSON.stringify({
        mcpServers: {
          aperture: { url: "https://old.test/v1/mcp", timeout: 5000 },
        },
      }),
    );
    writeMcpServer(GATEWAY, true);
    expect(readServers().aperture).toMatchObject({
      url: `${GATEWAY}/v1/mcp`,
      timeout: 5000,
    });
  });
});
