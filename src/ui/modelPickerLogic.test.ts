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
    if (!r.ok) {
      expect(r.reason).toContain("Not connected");
      expect(r.kind).toBe("connection-loss");
    }
  });
  test("streaming → blocked", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: true,
      isPending: false,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("streaming");
      expect(r.kind).toBe("streaming");
    }
  });
  test("pending → blocked", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: true,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toContain("pending");
      expect(r.kind).toBe("pending");
    }
  });
});

describe("modelPickerLogic — canSend (Phase 5: catalog/model blocked states)", () => {
  test("catalog error + connected → catalog-error reason", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: false,
      catalogState: { kind: "error", message: "fetch failed" },
      activeModelId: "gpt-4.1",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("catalog-error");
      expect(r.reason).toContain("fetch failed");
    }
  });

  test("catalog empty + connected → catalog-empty reason", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: false,
      catalogState: { kind: "empty" },
      activeModelId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("catalog-empty");
      expect(r.reason).toContain("No chat models");
    }
  });

  test("ready catalog + activeModelId not in catalog → unavailable-model with id in reason", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: false,
      catalogState: readyCatalog([{ id: "gpt-4o" }]),
      activeModelId: "gpt-deprecated",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.kind).toBe("unavailable-model");
      expect(r.reason).toContain("gpt-deprecated");
    }
  });

  test("ready catalog + activeModelId in catalog → ok", () => {
    expect(
      canSend({
        isConnected: true,
        isStreaming: false,
        isPending: false,
        catalogState: readyCatalog([{ id: "gpt-4o" }]),
        activeModelId: "gpt-4o",
      }),
    ).toEqual({ ok: true });
  });

  test("non-ready catalog + no activeModelId → unresolved-model", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: false,
      catalogState: { kind: "loading" },
      activeModelId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unresolved-model");
  });

  test("precedence: streaming wins over catalog-error", () => {
    const r = canSend({
      isConnected: true,
      isStreaming: true,
      isPending: false,
      catalogState: { kind: "error", message: "x" },
      activeModelId: null,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("streaming");
  });

  test("precedence: unavailable-model wins over catalog-error (model takes precedence over catalog-state)", () => {
    // Ready catalog with the conv-bound id missing — model-unavailable
    // is selected because the catalog IS ready (no catalog-error fires).
    const r = canSend({
      isConnected: true,
      isStreaming: false,
      isPending: false,
      catalogState: readyCatalog([{ id: "gpt-4o" }]),
      activeModelId: "gpt-deprecated",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("unavailable-model");
  });
});

describe("modelPickerLogic — buildModelPickerViewModel (Phase 5: unavailable-id sentinel)", () => {
  test("active conv's id not in ready catalog → sentinel row prepended with unavailable flag", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4o", name: "GPT-4o" }]),
      "gpt-deprecated",
    );
    expect(vm.kind).toBe("ready");
    if (vm.kind !== "ready") return;
    expect(vm.rows[0]).toEqual({
      id: "gpt-deprecated",
      label: "gpt-deprecated (unavailable)",
      isCurrent: true,
      unavailable: true,
    });
    // The real models still follow.
    expect(vm.rows[1].id).toBe("gpt-4o");
    expect(vm.rows[1].isCurrent).toBe(false);
    // currentLabel uses the sentinel's label so the picker button shows
    // "(unavailable)" — making the FR-010 condition visually obvious.
    expect(vm.currentLabel).toBe("gpt-deprecated (unavailable)");
  });

  test("active conv's id IS in ready catalog → no sentinel row", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4o" }, { id: "gpt-4.1" }]),
      "gpt-4o",
    );
    if (vm.kind !== "ready") throw new Error("expected ready");
    expect(vm.rows.some((r) => r.unavailable)).toBe(false);
    expect(vm.rows).toHaveLength(2);
  });

  test("no active modelId + ready catalog → no sentinel row", () => {
    const vm = buildModelPickerViewModel(
      readyCatalog([{ id: "gpt-4o" }]),
      null,
    );
    if (vm.kind !== "ready") throw new Error("expected ready");
    expect(vm.rows).toHaveLength(1);
    expect(vm.rows[0].unavailable).toBeUndefined();
  });
});
