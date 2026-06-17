import { describe, expect, it } from "vitest";
import { normalizeServerId } from "./McpIdentity";
import { formatSyntheticId, parseSyntheticId } from "./McpToolIdentity";

describe("McpToolIdentity", () => {
  it("preserves tool names exactly, including embedded double underscores", () => {
    const parsed = parseSyntheticId("mcp__server_one__read__file__v2");
    expect(parsed).toEqual({
      serverId: "server_one",
      toolName: "read__file__v2",
    });
  });

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
