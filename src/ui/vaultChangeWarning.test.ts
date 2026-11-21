import { describe, expect, it } from "vitest";
import { externalWindowSignal, formatVaultChangeWarning } from "./vaultChangeWarning";

describe("formatVaultChangeWarning", () => {
  it("returns null with nothing to report", () => {
    expect(formatVaultChangeWarning([])).toBeNull();
  });

  it("uses hedged copy and omits the link note for edits only", () => {
    const v = formatVaultChangeWarning([
      { type: "modified", path: "a.md" },
      { type: "created", path: "b.md" },
    ])!;
    expect(v.headline).toBe("2 vault files may have been changed outside the vault tools while this ran.");
    expect(v.lines).toEqual(["modified: a.md", "created: b.md"]);
    expect(v.footnote).toContain("skip the approval prompts");
    expect(v.footnote).toContain("can't be undone from chat");
    expect(v.footnote).not.toContain("links");
  });

  it("mentions links when a rename or delete is present and lists overflow", () => {
    const v = formatVaultChangeWarning([{ type: "renamed", path: "b/x.md", oldPath: "x.md" }], 4)!;
    expect(v.headline.startsWith("More than 1 vault files")).toBe(true);
    expect(v.lines).toEqual(["renamed: x.md → b/x.md", "…plus 4 more changes not listed"]);
    expect(formatVaultChangeWarning([{ type: "modified", path: "a.md" }], 1)!.lines[1]).toBe(
      "…plus 1 more change not listed",
    );
    expect(v.footnote).toContain("don't update links");
    expect(formatVaultChangeWarning([{ type: "deleted", path: "z.md" }])!.footnote).toContain("links");
  });

  it("uses the singular form for one file", () => {
    expect(formatVaultChangeWarning([{ type: "modified", path: "a.md" }])!.headline).toMatch(/^1 vault file may/);
  });
});

describe("externalWindowSignal", () => {
  const none = () => undefined;

  it("opens a window for running built-in and MCP calls", () => {
    for (const source of ["builtin", "mcp"] as const) {
      expect(
        externalWindowSignal({ type: "tool_call_start", toolCall: { id: "t", source, outcome: "approved" } }, none),
      ).toEqual({ kind: "start", toolCallId: "t" });
    }
  });

  it("never opens a window for vault tools", () => {
    expect(
      externalWindowSignal({ type: "tool_call_start", toolCall: { id: "t", source: "custom", outcome: "approved" } }, none),
    ).toBeNull();
  });

  it.each(["denied", "cancelled", "pending_approval", "completed", "errored"] as const)(
    "does not open a window for %s calls",
    (outcome) => {
      expect(
        externalWindowSignal({ type: "tool_call_start", toolCall: { id: "t", source: "builtin", outcome } }, none),
      ).toBeNull();
    },
  );

  it("opens a window when an approval for an external call is granted", () => {
    const sourceOf = (id: string) => (id === "sh" ? ("builtin" as const) : ("custom" as const));
    expect(externalWindowSignal({ type: "approval_resolved", id: "sh", choice: { kind: "approve-once" } }, sourceOf)).toEqual({
      kind: "start",
      toolCallId: "sh",
    });
    expect(
      externalWindowSignal({ type: "approval_resolved", id: "sh", choice: { kind: "approve-for-session" } }, sourceOf),
    ).not.toBeNull();
    expect(externalWindowSignal({ type: "approval_resolved", id: "sh", choice: { kind: "reject" } }, sourceOf)).toBeNull();
    expect(externalWindowSignal({ type: "approval_resolved", id: "sh", choice: { kind: "cancelled" } }, sourceOf)).toBeNull();
    expect(
      externalWindowSignal({ type: "approval_resolved", id: "vault", choice: { kind: "approve-once" } }, sourceOf),
    ).toBeNull();
    expect(externalWindowSignal({ type: "approval_resolved", id: "unknown", choice: { kind: "approve-once" } }, none)).toBeNull();
  });

  it("falls back to the known source when the start event lacks one", () => {
    expect(
      externalWindowSignal({ type: "tool_call_start", toolCall: { id: "t", outcome: "approved" } }, () => "mcp"),
    ).toEqual({ kind: "start", toolCallId: "t" });
  });

  it("closes on completion and ignores other events", () => {
    expect(externalWindowSignal({ type: "tool_call_complete", id: "t" }, none)).toEqual({ kind: "end", toolCallId: "t" });
    expect(externalWindowSignal({ type: "delta" }, none)).toBeNull();
  });
});
