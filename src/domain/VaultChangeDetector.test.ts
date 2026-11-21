import { describe, expect, it } from "vitest";
import {
  mergeVaultChanges,
  VaultChangeDetector,
  type AttributedVaultChange,
} from "./VaultChangeDetector";

function setup() {
  let t = 1000;
  const detector = new VaultChangeDetector({
    now: () => t,
    graceMs: 2000,
    settleMs: 1500,
    configDir: ".obsidian",
  });
  const seen: AttributedVaultChange[] = [];
  detector.subscribe((c) => seen.push(c));
  return { detector, seen, advance: (ms: number) => (t += ms) };
}

describe("VaultChangeDetector", () => {
  it("ignores events when no external tool has run", () => {
    const { detector, seen } = setup();
    expect(detector.observe({ type: "modify", path: "a.md" })).toBeNull();
    expect(seen).toEqual([]);
  });

  it("attributes events during and shortly after an external call", () => {
    const { detector, seen, advance } = setup();
    detector.externalToolStarted("sh1");
    expect(detector.observe({ type: "create", path: "new.md" })).toEqual({
      toolCallId: "sh1",
      change: { type: "created", path: "new.md" },
    });
    detector.externalToolCompleted("sh1");
    advance(1999);
    expect(detector.observe({ type: "rename", path: "b/x.md", oldPath: "x.md" })?.change).toEqual({
      type: "renamed",
      path: "b/x.md",
      oldPath: "x.md",
    });
    advance(2);
    expect(detector.observe({ type: "delete", path: "y.md" })).toBeNull();
    expect(seen.map((s) => s.change.type)).toEqual(["created", "renamed"]);
  });

  it("excludes the config folder", () => {
    const { detector } = setup();
    detector.externalToolStarted("sh1");
    expect(detector.observe({ type: "modify", path: ".obsidian/workspace.json" })).toBeNull();
    expect(detector.observe({ type: "create", path: ".obsidian/plugins/x/state.json" })).toBeNull();
    expect(detector.observe({ type: "modify", path: ".obsidianish.md" })).not.toBeNull();
  });

  it("excludes every event during a self-write span, even inside an external window", () => {
    const { detector, seen } = setup();
    detector.externalToolStarted("sh1");
    const span = detector.beginSelfWrite();
    expect(detector.observe({ type: "rename", path: "dst/n.md", oldPath: "n.md" })).toBeNull();
    expect(detector.observe({ type: "modify", path: "linker.md" })).toBeNull();
    span.end(["dst/n.md"]);
    expect(seen).toEqual([]);
  });

  it("keeps excluding self-written paths for the settle period after the span ends", () => {
    const { detector, advance } = setup();
    detector.externalToolStarted("sh1");
    const span = detector.beginSelfWrite();
    detector.observe({ type: "modify", path: "linker.md" });
    span.end(["Written.md"]);
    advance(1000);
    expect(detector.observe({ type: "modify", path: "linker.md" })).toBeNull();
    expect(detector.observe({ type: "modify", path: "written.md" })).toBeNull();
    expect(detector.observe({ type: "modify", path: "other.md" })?.toolCallId).toBe("sh1");
    advance(600);
    expect(detector.observe({ type: "modify", path: "linker.md" })?.toolCallId).toBe("sh1");
  });

  it("does not warn for a move_note during a shell call's grace period", () => {
    const { detector, seen, advance } = setup();
    detector.externalToolStarted("sh1");
    detector.externalToolCompleted("sh1");
    advance(500);
    const span = detector.beginSelfWrite();
    detector.observe({ type: "rename", path: "Archive/n.md", oldPath: "n.md" });
    detector.observe({ type: "modify", path: "refers-to-n.md" });
    span.end(["n.md", "Archive/n.md"]);
    advance(10);
    detector.observe({ type: "modify", path: "refers-to-n.md" });
    expect(seen).toEqual([]);
  });

  it("keeps spans open until every nested span has ended", () => {
    const { detector, advance } = setup();
    detector.externalToolStarted("sh1");
    const a = detector.beginSelfWrite();
    const b = detector.beginSelfWrite();
    a.end();
    a.end();
    expect(detector.observe({ type: "modify", path: "x.md" })).toBeNull();
    b.end();
    advance(1600);
    expect(detector.observe({ type: "modify", path: "y.md" })?.toolCallId).toBe("sh1");
  });

  it("skips modify events on the focused note but not other change types", () => {
    const { detector } = setup();
    detector.externalToolStarted("sh1");
    expect(detector.observe({ type: "modify", path: "open.md" }, "open.md")).toBeNull();
    expect(detector.observe({ type: "delete", path: "open.md" }, "open.md")).not.toBeNull();
    expect(detector.observe({ type: "modify", path: "other.md" }, "open.md")).not.toBeNull();
  });

  it("attributes to the most recently started active or in-grace call", () => {
    const { detector, advance } = setup();
    detector.externalToolStarted("a");
    detector.externalToolStarted("b");
    expect(detector.observe({ type: "modify", path: "1.md" })?.toolCallId).toBe("b");
    detector.externalToolCompleted("b");
    expect(detector.observe({ type: "modify", path: "2.md" })?.toolCallId).toBe("b");
    advance(2500);
    expect(detector.observe({ type: "modify", path: "3.md" })?.toolCallId).toBe("a");
    detector.externalToolStarted("a");
    expect(detector.observe({ type: "modify", path: "4.md" })?.toolCallId).toBe("a");
  });

  it("ignores completion of unknown calls and supports unsubscribe", () => {
    const { detector } = setup();
    detector.externalToolCompleted("ghost");
    expect(detector.observe({ type: "modify", path: "ghost.md" })).toBeNull();
    const got: string[] = [];
    const off = detector.subscribe((c) => got.push(c.change.path));
    detector.externalToolStarted("sh1");
    detector.observe({ type: "modify", path: "a.md" });
    off();
    detector.observe({ type: "modify", path: "b.md" });
    expect(got).toEqual(["a.md"]);
  });
});

describe("mergeVaultChanges", () => {
  it("dedupes by path, keeping the latest type except created→modified", () => {
    let r = mergeVaultChanges(undefined, undefined, { type: "created", path: "a.md" });
    r = mergeVaultChanges(r.changes, r.overflow, { type: "modified", path: "a.md" });
    expect(r.changes).toEqual([{ type: "created", path: "a.md" }]);
    r = mergeVaultChanges(r.changes, r.overflow, { type: "deleted", path: "a.md" });
    expect(r.changes).toEqual([{ type: "deleted", path: "a.md" }]);
    expect(r.overflow).toBe(0);
  });

  it("caps the list and counts overflow", () => {
    let r = { changes: [] as ReturnType<typeof mergeVaultChanges>["changes"], overflow: 0 };
    for (let i = 0; i < 23; i++) {
      r = mergeVaultChanges(r.changes, r.overflow, { type: "modified", path: `n${i}.md` }, 20);
    }
    expect(r.changes).toHaveLength(20);
    expect(r.overflow).toBe(3);
    r = mergeVaultChanges(r.changes, r.overflow, { type: "deleted", path: "n0.md" }, 20);
    expect(r.overflow).toBe(3);
    expect(r.changes[0]).toEqual({ type: "deleted", path: "n0.md" });
  });

  it("does not mutate its input", () => {
    const existing = [{ type: "modified" as const, path: "a.md" }];
    mergeVaultChanges(existing, 0, { type: "deleted", path: "a.md" });
    expect(existing).toEqual([{ type: "modified", path: "a.md" }]);
  });
});
