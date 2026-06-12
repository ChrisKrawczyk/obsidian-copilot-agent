// v0.4 Phase 4: pure-logic tests for the model picker reducer.
//
// These tests exercise modelPickerLogic.ts in node (no DOM, no
// Obsidian) — matching the pattern of chatKeydown.test.ts and
// conversationPickerLogic.test.ts.

import { describe, expect, test } from "vitest";
import {
  buildModelPickerViewModel,
  buildSwapConfirmCopy,
  canSend,
  decidePickerKeydown,
  isIdentitySwap,
  shouldConfirmSwap,
} from "./modelPickerLogic";
import type { CatalogModelInfo, ModelCatalogState } from "../sdk/ModelCatalog";
import type { Message } from "../domain/types";

function readyCatalog(models: CatalogModelInfo[]): ModelCatalogState {
  return { kind: "ready", models, chatModels: models };
}

describe("modelPickerLogic — buildModelPickerViewModel", () => {
  test("loading state yields { kind: 'loading' }", () => {
    const vm = buildModelPickerViewModel({ kind: "loading" }, "gpt-4.1");
    expect(vm.kind).toBe("loading");
  });

  test("ready state yields rows with current row marked", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([
        { id: "gpt-4.1", name: "GPT-4.1" },
        { id: "gpt-4o" },
      ]),
      "gpt-4o",
    );
    expect(vm.kind).toBe("ready");
    if (vm.kind !== "ready") return;
    expect(vm.currentId).toBe("gpt-4o");
    expect(vm.currentLabel).toBe("gpt-4o");
    expect(vm.rows.map((r) => r.id)).toEqual(["gpt-4.1", "gpt-4o"]);
    expect(vm.rows.find((r) => r.id === "gpt-4o")?.isCurrent).toBe(true);
    expect(vm.rows.find((r) => r.id === "gpt-4.1")?.isCurrent).toBe(false);
    expect(vm.rows[0].label).toBe("GPT-4.1");
  });

  test("ready state with no active modelId still renders rows", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4.1" }]),
      null,
    );
    expect(vm.kind).toBe("ready");
    if (vm.kind !== "ready") return;
    expect(vm.currentId).toBeNull();
    expect(vm.currentLabel).toBeNull();
    expect(vm.rows[0].isCurrent).toBe(false);
  });

  test("empty catalog degrades to label = bound id", () => {
    const vm = buildModelPickerViewModel({ kind: "empty" }, "gpt-4.1");
    expect(vm.kind).toBe("degraded");
    if (vm.kind !== "degraded") return;
    expect(vm.label).toBe("gpt-4.1");
  });

  test("error catalog degrades, with null label when no bound id", () => {
    const vm = buildModelPickerViewModel(
      { kind: "error", message: "boom" },
      null,
    );
    expect(vm.kind).toBe("degraded");
    if (vm.kind !== "degraded") return;
    expect(vm.label).toBeNull();
  });

  test("rows with empty id are filtered out", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4.1" }, { id: "" }, {}]),
      "gpt-4.1",
    );
    if (vm.kind !== "ready") throw new Error("not ready");
    expect(vm.rows.map((r) => r.id)).toEqual(["gpt-4.1"]);
  });

  // NFR-002: the active-conversation switch path is structurally
  // synchronous — pins the ≤16ms budget without a wall-clock probe.
  test("buildModelPickerViewModel is a synchronous (non-async) function", () => {
    expect(buildModelPickerViewModel.constructor.name).toBe("Function");
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4.1" }]),
      "gpt-4.1",
    );
    // Result must not be a thenable.
    expect(
      typeof (vm as unknown as { then?: unknown }).then,
    ).toBe("undefined");
  });
});

describe("modelPickerLogic — isIdentitySwap", () => {
  test("returns true for matching ids", () => {
    expect(isIdentitySwap("gpt-4.1", "gpt-4.1")).toBe(true);
  });
  test("returns false for differing ids", () => {
    expect(isIdentitySwap("gpt-4.1", "gpt-4o")).toBe(false);
  });
  test("returns false when current is null or empty", () => {
    expect(isIdentitySwap(null, "gpt-4.1")).toBe(false);
    expect(isIdentitySwap(undefined, "gpt-4.1")).toBe(false);
    expect(isIdentitySwap("", "gpt-4.1")).toBe(false);
  });
});

describe("modelPickerLogic — shouldConfirmSwap", () => {
  function msg(over: Partial<Message>): Message {
    return {
      id: over.id ?? "m",
      role: over.role ?? "assistant",
      content: over.content ?? "",
      status: over.status ?? "complete",
      createdAt: over.createdAt ?? 1,
    };
  }
  test("empty conversation: no confirmation", () => {
    expect(shouldConfirmSwap([])).toBe(false);
  });
  test("only user message: no confirmation", () => {
    expect(shouldConfirmSwap([msg({ role: "user", status: "complete" })])).toBe(
      false,
    );
  });
  test("streaming assistant turn does NOT count", () => {
    expect(
      shouldConfirmSwap([
        msg({ role: "user", status: "complete" }),
        msg({ role: "assistant", status: "streaming" }),
      ]),
    ).toBe(false);
  });
  test("pending assistant turn does NOT count", () => {
    expect(
      shouldConfirmSwap([msg({ role: "assistant", status: "pending" })]),
    ).toBe(false);
  });
  test("interrupted assistant turn does NOT count", () => {
    expect(
      shouldConfirmSwap([msg({ role: "assistant", status: "interrupted" })]),
    ).toBe(false);
  });
  test("error assistant turn does NOT count", () => {
    expect(
      shouldConfirmSwap([msg({ role: "assistant", status: "error" })]),
    ).toBe(false);
  });
  test("one completed assistant turn triggers confirmation", () => {
    expect(
      shouldConfirmSwap([
        msg({ role: "user", status: "complete" }),
        msg({ role: "assistant", status: "complete" }),
      ]),
    ).toBe(true);
  });
});

describe("modelPickerLogic — decidePickerKeydown", () => {
  test("closed + Enter / Space / ArrowDown / ArrowUp opens", () => {
    for (const key of ["Enter", " ", "ArrowDown", "ArrowUp"]) {
      expect(
        decidePickerKeydown({
          key,
          isOpen: false,
          rowCount: 3,
          highlightedIndex: -1,
        }),
      ).toEqual({ kind: "open" });
    }
  });

  test("closed + arbitrary key is passthrough", () => {
    expect(
      decidePickerKeydown({
        key: "a",
        isOpen: false,
        rowCount: 3,
        highlightedIndex: -1,
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test("open + Escape closes", () => {
    expect(
      decidePickerKeydown({
        key: "Escape",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 1,
      }),
    ).toEqual({ kind: "close" });
  });

  test("open + ArrowDown moves highlight (wraps at end)", () => {
    expect(
      decidePickerKeydown({
        key: "ArrowDown",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: -1,
      }),
    ).toEqual({ kind: "highlight", index: 0 });
    expect(
      decidePickerKeydown({
        key: "ArrowDown",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 2,
      }),
    ).toEqual({ kind: "highlight", index: 0 });
    expect(
      decidePickerKeydown({
        key: "ArrowDown",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 0,
      }),
    ).toEqual({ kind: "highlight", index: 1 });
  });

  test("open + ArrowUp moves highlight (wraps to last)", () => {
    expect(
      decidePickerKeydown({
        key: "ArrowUp",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: -1,
      }),
    ).toEqual({ kind: "highlight", index: 2 });
    expect(
      decidePickerKeydown({
        key: "ArrowUp",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 0,
      }),
    ).toEqual({ kind: "highlight", index: 2 });
    expect(
      decidePickerKeydown({
        key: "ArrowUp",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 2,
      }),
    ).toEqual({ kind: "highlight", index: 1 });
  });

  test("open + Home / End jump", () => {
    expect(
      decidePickerKeydown({
        key: "Home",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 2,
      }),
    ).toEqual({ kind: "highlight", index: 0 });
    expect(
      decidePickerKeydown({
        key: "End",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 0,
      }),
    ).toEqual({ kind: "highlight", index: 2 });
  });

  test("open + Enter on a highlighted row selects", () => {
    expect(
      decidePickerKeydown({
        key: "Enter",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: 1,
      }),
    ).toEqual({ kind: "select", index: 1 });
  });

  test("open + Enter with no highlight is passthrough (no accidental select)", () => {
    expect(
      decidePickerKeydown({
        key: "Enter",
        isOpen: true,
        rowCount: 3,
        highlightedIndex: -1,
      }),
    ).toEqual({ kind: "passthrough" });
  });

  test("open + zero rows: keys other than Escape are passthrough", () => {
    expect(
      decidePickerKeydown({
        key: "ArrowDown",
        isOpen: true,
        rowCount: 0,
        highlightedIndex: -1,
      }),
    ).toEqual({ kind: "passthrough" });
  });
});

describe("modelPickerLogic — buildSwapConfirmCopy", () => {
  test("base copy mentions the new model and history preservation", () => {
    const body = buildSwapConfirmCopy("GPT-4o", false);
    expect(body).toContain("GPT-4o");
    expect(body).toContain("history is preserved");
    expect(body).not.toContain("pending tool approvals");
  });

  test("pending approvals append warns about cancellation", () => {
    const body = buildSwapConfirmCopy("GPT-4o", true);
    expect(body).toContain("pending tool approvals will be cancelled");
  });
});

describe("modelPickerLogic — canSend (Phase 4 scaffold)", () => {
  test("connected, not streaming, not pending → ok", () => {
    expect(
      canSend({ isConnected: true, isStreaming: false, isPending: false }),
    ).toEqual({ ok: true });
  });
  test("disconnected → blocked with notice copy", () => {
    const r = canSend({
      isConnected: false,
      isStreaming: false,
      isPending: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("Not connected");
  });
  test("streaming → blocked", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: true,
      isPending: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("streaming");
  });
  test("pending → blocked", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("pending");
  });
});
