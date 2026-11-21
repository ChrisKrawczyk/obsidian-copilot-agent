import { describe, test, expect, beforeAll, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  boundPreview,
  countLinkingNotes,
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
  test("truncation keeps each task's before/after together and counts tasks", () => {
    const rows = Array.from({ length: 200 }, (_, i) => ({
      path: "a.md",
      line: i + 1,
      before: `- [ ] task ${i} ${"x".repeat(40)}`,
      after: `- [x] task ${i} ${"x".repeat(40)}`,
      changedFields: ["status"],
      changed: true,
    }));
    const lines = formatUpdateTasksPreview({ failures: [], rows }).split("\n");
    const shown = lines.filter((l) => /^a\.md:\d+$/.test(l)).length;
    expect(lines[lines.length - 1]).toBe(`… and ${200 - shown} more`);
    expect(lines[lines.length - 2]).toMatch(/^ {2}\+ /);
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
  test("returns every source and destination for move_note", () => {
    expect(
      extractBatchVaultPaths("move_note", {
        moves: [
          { from: "a.md", to: "x/a.md" },
          { from: "F", to: "G" },
          { from: "a.md", to: "" },
        ],
      }),
    ).toEqual(["a.md", "x/a.md", "F", "G"]);
  });
  test("returns the distinct paths for bulk_edit", () => {
    expect(extractBatchVaultPaths("bulk_edit", { paths: ["a.md", "a.md", 3, "b.md"] })).toEqual(["a.md", "b.md"]);
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
  test("previews move_note items with link counts and failures", async () => {
    const base = deps({ "a.md": "", "b.md": "", "F/n.md": "", "taken.md": "" });
    const vault = base.vault as unknown as { getAbstractFileByPath: (p: string) => unknown };
    const lookup = vault.getAbstractFileByPath;
    vault.getAbstractFileByPath = (p) => (p === "F" ? { path: "F", children: [] } : lookup(p));
    const d = await describeVaultBatchApproval(
      "move_note",
      {
        moves: [
          { from: "a.md", to: "x/a.md" },
          { from: "F", to: "G" },
          { from: "b.md", to: "taken.md" },
        ],
      },
      {
        ...base,
        metadataCache: {
          resolvedLinks: {
            "b.md": { "a.md": 2, "F/n.md": 1 },
            "taken.md": { "a.md": 1 },
            "F/n.md": { "F/n.md": 1 },
          },
        },
      },
    );
    expect(d?.summary).toBe("move_note: 3 items");
    expect(d?.detail.split("\n")).toEqual([
      "✗ b.md → taken.md — target_exists",
      "a.md → x/a.md — links in 2 notes",
      "F → G (folder) — links in 1 note",
    ]);
  });
  test("previews bulk_edit with per-note counts, samples and the total", async () => {
    const d = await describeVaultBatchApproval(
      "bulk_edit",
      { paths: ["a.md", "b.md", "c.md"], find: "#old", replace: "#new" },
      deps({ "a.md": "one #old\ntwo #old", "b.md": "#old", "c.md": "none" }),
    );
    expect(d?.summary).toBe("bulk_edit: 3 replacements in 2 notes");
    expect(d?.detail.split("\n")).toEqual([
      "a.md — 2 replacements",
      "  - one #old",
      "  + one #new",
      "  - two #old",
      "  + two #new",
      "b.md — 1 replacement",
      "  - #old",
      "  + #new",
      "c.md (no matches)",
      "Total: 3 replacements in 2 notes",
    ]);
  });
  test("bulk_edit preview lists failures and invalid patterns", async () => {
    const d = await describeVaultBatchApproval(
      "bulk_edit",
      { paths: ["a.md", "x.png"], find: "a", replace: "b" },
      deps({ "a.md": "a" }),
    );
    expect(d?.detail.split("\n")[0]).toBe("✗ x.png — not_a_note (Only .md and .txt notes can be bulk-edited.)");
    const bad = await describeVaultBatchApproval("bulk_edit", { paths: ["a.md"], find: "(", replace: "", regex: true }, deps({}));
    expect(bad?.summary).toBe("bulk_edit: invalid find");
  });
  test("bulk_edit preview keeps the total line when truncated", async () => {
    const seed: Record<string, string> = {};
    for (let i = 0; i < 50; i++) seed[`note-${i}.md`] = `${"long line ".repeat(10)}#old\nmore #old\nagain #old`;
    const d = await describeVaultBatchApproval("bulk_edit", { paths: Object.keys(seed), find: "#old", replace: "#new" }, deps(seed));
    const lines = d!.detail.split("\n");
    expect(d!.detail.length).toBeLessThanOrEqual(MAX_PREVIEW_CHARS);
    expect(lines.at(-2)).toMatch(/^… and \d+ more$/);
    expect(lines.at(-1)).toBe("Total: 150 replacements in 50 notes");
  });
  test("skips reading when a call is over its cap", async () => {
    const paths = Array.from({ length: 51 }, (_, i) => `n${i}.md`);
    expect(await describeVaultBatchApproval("bulk_edit", { paths, find: "a", replace: "b" }, deps({}))).toBeUndefined();
    const targets = Array.from({ length: 201 }, (_, i) => ({ path: "a.md", line: i + 1, expectedRawLine: "- [ ] x" }));
    expect(
      await describeVaultBatchApproval("update_tasks", { targets, patch: { setStatus: "done" } }, deps({})),
    ).toBeUndefined();
  });
  test("returns undefined for tools without a preview", async () => {
    expect(await describeVaultBatchApproval("edit_note", {}, deps({}))).toBeUndefined();
  });
});

describe("countLinkingNotes", () => {
  const index = {
    resolvedLinks: {
      "a.md": { "F/x.md": 1, "b.md": 0 },
      "F/y.md": { "F/x.md": 3 },
      "c.md": { "b.md": 1 },
    },
  };
  test("counts notes that link to a file", () => {
    expect(countLinkingNotes(index, "b.md", "file")).toBe(1);
    expect(countLinkingNotes(index, "F/x.md", "file")).toBe(2);
  });
  test("for a folder, ignores links from inside it", () => {
    expect(countLinkingNotes(index, "F", "folder")).toBe(1);
  });
  test("is zero without a link index", () => {
    expect(countLinkingNotes(undefined, "a.md", "file")).toBe(0);
  });
});
