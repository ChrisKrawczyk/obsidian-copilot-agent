import { describe, expect, test, vi } from "vitest";
import {
  runUndoFlow,
  divergenceConfirmMessage,
} from "./undoFlow";
import type { UndoJournal, UndoEntry, UndoOutcome } from "../domain/UndoJournal";

/**
 * v0.3 Phase 6 (FR-012): the divergence flow lives in `undoFlow.ts`
 * (extracted from ChatView) so the confirm/retry path is unit-testable
 * without a DOM. These tests cover the orchestrator contract; the
 * journal's own divergence detection is tested in
 * UndoJournal.crossRestart.test.ts.
 */

function makeEntry(over: Partial<UndoEntry> = {}): UndoEntry {
  return {
    id: "u1",
    kind: "modify",
    scope: "vault",
    path: "n.md",
    before: "v1",
    after: "v2",
    recordedAt: 1,
    undone: false,
    ...over,
  };
}

function makeJournal(opts: {
  entry?: UndoEntry | undefined;
  outcomes: UndoOutcome[];
}): UndoJournal {
  const queue = [...opts.outcomes];
  const undo = vi.fn(async () => {
    const next = queue.shift();
    if (!next) throw new Error("undo() called more times than expected");
    return next;
  });
  return {
    get: vi.fn(() => opts.entry),
    undo,
    // unused by runUndoFlow
    record: vi.fn(),
    listAll: vi.fn(),
  } as unknown as UndoJournal;
}

describe("runUndoFlow — divergence flow (FR-012)", () => {
  test("ok:true returns success without prompting", async () => {
    const entry = makeEntry();
    const confirm = vi.fn();
    const notify = vi.fn();
    const journal = makeJournal({
      entry,
      outcomes: [{ ok: true, divergence: "ok" }],
    });
    const out = await runUndoFlow("u1", { journal, confirm, notify });
    expect(out.result).toBe("success");
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(journal.undo).toHaveBeenCalledTimes(1);
  });

  test("divergence -> confirm -> accept retries with { force: true }", async () => {
    const entry = makeEntry({ path: "note.md" });
    const confirm = vi.fn().mockResolvedValue(true);
    const notify = vi.fn();
    const journal = makeJournal({
      entry,
      outcomes: [
        { ok: false, divergence: "modified", reason: "guard" },
        { ok: true, divergence: "ok" },
      ],
    });
    const out = await runUndoFlow("u1", { journal, confirm, notify });
    expect(out.result).toBe("success");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0][0]).toBe("Undo with divergence");
    expect(confirm.mock.calls[0][1]).toMatch(/modified outside the agent/);
    expect(confirm.mock.calls[0][1]).toContain("note.md");
    expect(journal.undo).toHaveBeenNthCalledWith(2, "u1", { force: true });
    expect(notify).not.toHaveBeenCalled();
  });

  test("divergence -> confirm -> decline returns cancelled without retry", async () => {
    const entry = makeEntry();
    const confirm = vi.fn().mockResolvedValue(false);
    const notify = vi.fn();
    const journal = makeJournal({
      entry,
      outcomes: [{ ok: false, divergence: "missing", reason: "guard" }],
    });
    const out = await runUndoFlow("u1", { journal, confirm, notify });
    expect(out.result).toBe("cancelled");
    expect(journal.undo).toHaveBeenCalledTimes(1);
    expect(notify).not.toHaveBeenCalled();
  });

  test("non-divergence failure surfaces reason via notify", async () => {
    const entry = makeEntry();
    const confirm = vi.fn();
    const notify = vi.fn();
    const journal = makeJournal({
      entry,
      outcomes: [{ ok: false, reason: "no prior content" }],
    });
    const out = await runUndoFlow("u1", { journal, confirm, notify });
    expect(out.result).toBe("failed");
    expect(confirm).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("no prior content");
  });

  test("missing journal entry notifies and returns missing-entry", async () => {
    const confirm = vi.fn();
    const notify = vi.fn();
    const journal = makeJournal({ entry: undefined, outcomes: [] });
    const out = await runUndoFlow("u1", { journal, confirm, notify });
    expect(out.result).toBe("missing-entry");
    expect(notify).toHaveBeenCalled();
  });

  test("no journal returns no-journal", async () => {
    const confirm = vi.fn();
    const notify = vi.fn();
    const out = await runUndoFlow("u1", {
      journal: undefined,
      confirm,
      notify,
    });
    expect(out.result).toBe("no-journal");
    expect(notify).toHaveBeenCalled();
  });
});

describe("divergenceConfirmMessage", () => {
  test("modified mentions external modification", () => {
    expect(divergenceConfirmMessage("modified", "a.md")).toMatch(
      /modified outside the agent/,
    );
  });
  test("missing mentions recreation", () => {
    expect(divergenceConfirmMessage("missing", "a.md")).toMatch(
      /no longer exists/,
    );
  });
  test("existed mentions overwrite", () => {
    expect(divergenceConfirmMessage("existed", "a.md")).toMatch(
      /already exists/,
    );
  });
});
