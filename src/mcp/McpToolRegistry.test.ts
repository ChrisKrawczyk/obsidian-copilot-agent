import { describe, expect, test, vi } from "vitest";
import { buildMcpToolRegistrySnapshot } from "./McpToolRegistry";
import { normalizeServerId } from "./McpIdentity";
import type { McpServerConfig, McpToolInventoryEntry } from "./McpTypes";

describe("McpToolRegistry", () => {
  test("cross-server duplicate names get distinct synthetic ids", () => {
    const a = server("a");
    const b = server("b");
    const snap = buildMcpToolRegistrySnapshot({ inventory: [tool(a, "read_file"), tool(b, "read_file")] });
    expect(snap.tools.map((t) => t.syntheticId)).toEqual(["mcp__a__read_file", "mcp__b__read_file"]);
  });

  test("same-server duplicates reject that server inventory", () => {
    const a = server("a");
    const snap = buildMcpToolRegistrySnapshot({ inventory: [tool(a, "x"), tool(a, "x")] });
    expect(snap.tools).toHaveLength(0);
    expect(snap.rejected[0].reason).toMatch(/duplicate/);
  });

  test("case-sensitive and embedded separators are preserved", () => {
    const a = server("a");
    const snap = buildMcpToolRegistrySnapshot({ inventory: [tool(a, "Read__File"), tool(a, "read__file")] });
    expect(snap.tools.map((t) => t.toolName)).toEqual(["Read__File", "read__file"]);
  });

  test("hostile names and built-in collisions are rejected", () => {
    const a = server("a");
    const notify = vi.fn();
    const snap = buildMcpToolRegistrySnapshot({
      inventory: [tool(a, "bad/path"), tool(a, "safe")],
      builtinToolNames: ["mcp__a__safe"],
      notify,
    });
    expect(snap.tools).toHaveLength(0);
    expect(snap.rejected).toHaveLength(2);
    expect(notify).toHaveBeenCalled();
  });

  test("absent inventory from disabled/disconnected/removed servers contributes zero tools", () => {
    expect(buildMcpToolRegistrySnapshot({ inventory: [] }).tools).toHaveLength(0);
  });

  test("instructions metadata is surfaced per server", () => {
    const a = server("a");
    const snap = buildMcpToolRegistrySnapshot({
      inventory: [tool(a, "x")],
      statuses: [{ id: a.id, status: "connected", instructions: "Use carefully" }],
    });
    expect(snap.tools[0].instructions).toBe("Use carefully");
  });
});

function server(id: string): McpServerConfig {
  return { id: normalizeServerId(id), name: id, enabled: true, trustEpoch: "e" as never, transport: "stdio", command: "node", args: [] };
}

function tool(server: McpServerConfig, name: string): McpToolInventoryEntry {
  return { serverId: server.id, serverName: server.name, toolName: name, syntheticId: `mcp__${server.id}__${name}` };
}
