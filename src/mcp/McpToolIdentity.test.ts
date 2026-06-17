import { describe, expect, it } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import {
  formatSyntheticId,
  parseSyntheticId,
  resolveMcpToolSourceMetadata,
} from "./McpToolIdentity";
import type { McpServerConfig, McpTrustEpoch } from "./McpTypes";

describe("McpToolIdentity", () => {
  it("preserves tool names exactly, including embedded double underscores", () => {
    const parsed = parseSyntheticId("mcp__server_one__read__file__v2");
    expect(parsed).toEqual({
      serverId: "server_one",
      toolName: "read__file__v2",
    });
  });

  it("returns current source metadata for enabled servers", () => {
      const id = normalizeServerId("Server_One");
      const trustEpoch = "epoch_1" as McpTrustEpoch;
      const servers = [
        {
          id,
          name: "Server One",
          enabled: true,
          trustEpoch,
          transport: "stdio",
          command: "node",
          args: [],
        },
      ] satisfies McpServerConfig[];
      expect(resolveMcpToolSourceMetadata(formatSyntheticId(id, "read"), servers)).toEqual({
        source: "mcp",
        stableServerId: id,
        serverName: "Server One",
        toolName: "read",
        trustEpoch,
      });
  });

  it("returns no metadata for removed or disabled servers", () => {
      const id = normalizeServerId("Server_One");
      const trustEpoch = "epoch_1" as McpTrustEpoch;
      expect(resolveMcpToolSourceMetadata(formatSyntheticId(id, "read"), [])).toBeNull();
      expect(
        resolveMcpToolSourceMetadata(formatSyntheticId(id, "read"), [
          {
            id,
            name: "Server One",
            enabled: false,
            trustEpoch,
            transport: "http",
            url: "https://example.test/mcp",
          },
        ]),
      ).toBeNull();
  });

  it.each(["disconnected", "error", "reconnecting", "crashloop"] as const)(
    "returns no metadata when runtime status is %s",
    (status) => {
      const id = normalizeServerId("Server_One");
      const trustEpoch = "epoch_1" as McpTrustEpoch;
      const servers = [{
        id,
        name: "Server One",
        enabled: true,
        trustEpoch,
        transport: "stdio" as const,
        command: "node",
        args: [],
      }];
      expect(
        resolveMcpToolSourceMetadata(
          formatSyntheticId(id, "read"),
          servers,
          new Map([[id, status]]),
        ),
      ).toBeNull();
    },
  );

  it("round-trips format and parse symmetrically", () => {
    const id = normalizeServerId("Server_One");
    const synthetic = formatSyntheticId(id, " Tool Name__Case ");
    expect(parseSyntheticId(synthetic)).toEqual({
      serverId: id,
      toolName: " Tool Name__Case ",
    });
  });

  it("rejects names with path separators or control characters", () => {
    expect(parseSyntheticId("mcp__server__bad/name")).toBeNull();
    expect(parseSyntheticId("mcp__server__bad\\name")).toBeNull();
    expect(parseSyntheticId("mcp__server__bad\nname")).toBeNull();
    expect(parseSyntheticId("mcp__server__bad\u0000name")).toBeNull();
  });

  it("rejects non-MCP or incomplete synthetic ids", () => {
    expect(parseSyntheticId("view")).toBeNull();
    expect(parseSyntheticId("mcp__server")).toBeNull();
    expect(parseSyntheticId("mcp____tool")).toBeNull();
    expect(parseSyntheticId("mcp__server__")).toBeNull();
  });
});
