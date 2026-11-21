import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  boundPreview,
  describeVaultBatchApproval,
  extractBatchVaultPaths,
  formatUpdateTasksPreview,
  MAX_PREVIEW_CHARS,
} from "./approvalPreview";
import type { TFileLike } from "./ReadTools";
import type { WriteNoteToolsDeps } from "./WriteNoteTools";

let vaultRoot: string;
beforeAll(() => {
  vaultRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "copilot-agent-preview-")));
});
afterAll(() => {
  fs.rmSync(vaultRoot, { recursive: true, force: true });
});

function deps(seed: Record<string, string>): Pick<WriteNoteToolsDeps, "vault" | "workspace" | "now"> {
  const files = new Map(Object.entries(seed).map(([p, c]) => [p, { path: p, content: c }]));
  return {
    vault: {
      adapter: { getBasePath: () => vaultRoot },
      getAbstractFileByPath: (p: string) => files.get(p) ?? null,
      read: async (f: TFileLike) => files.get(f.path)!.content,
    } as unknown as WriteNoteToolsDeps["vault"],
    workspace: { getLeavesOfType: () => [] },
    now: () => new Date(2026, 5, 9, 12),
  };
}

describe("boundPreview", () => {
  test("returns everything when under the limit", () => {
    expect(boundPreview(["a", "b"], 10)).toBe("a\nb");
  });
  test("truncates with an 'and N more' line", () => {
    expect(boundPreview(["aaaa", "bbbb", "cccc", "dddd"], 10)).toBe("aaaa\nbbbb\n… and 2 more");
  });
  test("default limit keeps output near the approval detail cap", () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
    const out = boundPreview(lines);
    expect(out.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS + 30);
    expect(out).toMatch(/… and \d+ more$/);
  });
});

describe("formatUpdateTasksPreview", () => {
  test("lists failures first, then before/after pairs and no-ops", () => {
    const out = formatUpdateTasksPreview({
      failures: [{ index: 2, path: "c.md", line: 4, reason: "task_not_found" }],
      rows: [
        { path: "a.md", line: 2, before: "- [ ] a", after: "- [x] a", changedFields: ["status"], changed: true },
        { path: "b.md", line: 1, before: "- [x] b", after: "- [x] b", changedFields: [], changed: false },
      ],
    });
    expect(out.split("\n")).toEqual([
      "✗ c.md:4 — task_not_found",
      "a.md:2",
      "  - - [ ] a",
      "  + - [x] a",
      "b.md:1 (no change)  - [x] b",
    ]);
  });
});

describe("extractBatchVaultPaths", () => {
  test("returns the distinct target paths for update_tasks", () => {
    expect(
      extractBatchVaultPaths("update_tasks", {
        targets: [{ path: "a.md" }, { path: "b.md" }, { path: "a.md" }, { nope: 1 }],
      }),
    ).toEqual(["a.md", "b.md"]);
  });
  test("is undefined for other tools or malformed args", () => {
    expect(extractBatchVaultPaths("edit_note", { path: "a.md" })).toBeUndefined();
    expect(extractBatchVaultPaths("update_tasks", { targets: "a.md" })).toBeUndefined();
  });
});

describe("describeVaultBatchApproval", () => {
  test("summarises update_tasks scale and previews each line from current content", async () => {
    const d = await describeVaultBatchApproval(
      "update_tasks",
      {
        targets: [
          { path: "a.md", line: 1, expectedRawLine: "- [ ] one" },
          { path: "b.md", line: 1, expectedRawLine: "- [ ] stale" },
        ],
        patch: { setStatus: "done" },
      },
      deps({ "a.md": "- [ ] one", "b.md": "- [ ] two" }),
    );
    expect(d?.summary).toBe("update_tasks: 2 tasks in 2 notes");
    expect(d?.detail).toContain("✗ b.md:1 — task_not_found");
    expect(d?.detail).toContain("  + - [x] one (completed: 2026-06-09)");
  });
  test("returns undefined for tools without a preview", async () => {
    expect(await describeVaultBatchApproval("edit_note", {}, deps({}))).toBeUndefined();
  });
});
