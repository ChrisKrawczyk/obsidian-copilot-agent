// v0.4 Phase 4: pure (DOM-free) helpers for ModelPicker.
//
// Extracted into its own module so we can unit-test render-state /
// keyboard / identity-swap / confirmation-derivation logic in node
// (per vitest.config.ts), without dragging Obsidian's DOM into the
// test environment. Mirrors the pattern used for
// `src/ui/conversationPickerLogic.ts` and `src/ui/chatKeydown.ts`.
//
// Anything that produces or mutates HTML lives in `ModelPicker.ts`;
// anything that decides what items to show, whether to confirm, or
// what keyboard action to take, lives here.

import type {
  CatalogModelInfo,
  ModelCatalogState,
} from "../sdk/ModelCatalog";
import type { Message } from "../domain/types";

/** Compact row type the picker renders for each chat-capable model. */
export interface ModelRow {
  id: string;
  /** Display label — prefers `model.name`, falls back to `model.id`. */
  label: string;
  /** True iff this is the active conversation's currently-bound model. */
  isCurrent: boolean;
}

/**
 * Render view-model produced by {@link buildModelPickerViewModel}.
 *
 * `kind` enumerates the four states the picker can present in Phase 4:
 *  - `loading` — initial state before the first catalog refresh resolves.
 *    Picker renders a disabled label ("…") with no menu.
 *  - `ready` — happy path. Picker renders the active model's label and
 *    a clickable menu of `rows`.
 *  - `degraded` — Phase 4 explicitly degrades to v0.3-equivalent UX
 *    when the catalog is `empty` or `error`. Picker renders the active
 *    conversation's bound model id as a non-interactive label (or
 *    hides if there is no bound id). Phase 5 will replace this with
 *    proper error/empty banners + retry affordances.
 */
export type PickerViewModel =
  | { kind: "loading"; label: string }
  | {
      kind: "ready";
      currentId: string | null;
      currentLabel: string | null;
      rows: ModelRow[];
    }
  | { kind: "degraded"; label: string | null };

/**
 * Project (catalogState, activeConversationModelId) → PickerViewModel.
 *
 * Pure and synchronous — this is the function asserted as
 * non-AsyncFunction by the NFR-002 structural test.
 */
export function buildModelPickerViewModel(
  catalogState: ModelCatalogState,
  activeConversationModelId: string | null | undefined,
): PickerViewModel {
  if (catalogState.kind === "loading") {
    return { kind: "loading", label: "…" };
  }
  if (catalogState.kind === "ready") {
    const rows: ModelRow[] = catalogState.chatModels
      .map((m) => makeRow(m, activeConversationModelId ?? null))
      .filter((r) => r.id.length > 0);
    const currentId = activeConversationModelId ?? null;
    const currentLabel = currentId
      ? (rows.find((r) => r.id === currentId)?.label ?? currentId)
      : null;
    return { kind: "ready", currentId, currentLabel, rows };
  }
  // empty | error — Phase 4 degraded UX: show whatever id the
  // conversation is bound to (if any), no menu. Phase 5 will add
  // recovery banners and retry.
  return {
    kind: "degraded",
    label:
      typeof activeConversationModelId === "string" &&
      activeConversationModelId.length > 0
        ? activeConversationModelId
        : null,
  };
}

function makeRow(model: CatalogModelInfo, currentId: string | null): ModelRow {
  const id = typeof model.id === "string" ? model.id : "";
  const label =
    typeof model.name === "string" && model.name.length > 0
      ? model.name
      : id;
  return { id, label, isCurrent: id.length > 0 && id === currentId };
}

/**
 * Identity-swap predicate: true iff selecting `newId` would be a
 * no-op. The picker uses this BEFORE the confirmation flow to skip
 * both the dialog and the SDK round-trip.
 */
export function isIdentitySwap(
  currentId: string | null | undefined,
  newId: string,
): boolean {
  return (
    typeof currentId === "string" &&
    currentId.length > 0 &&
    currentId === newId
  );
}

/**
 * FR-008: "should we ask for confirmation before this swap?" — true
 * iff the active conversation has at least one COMPLETED assistant
 * turn already (i.e., the user has actually received a response from
 * the current model). Streaming/pending/error/interrupted turns do
 * NOT count: they have not produced a finished response yet, and the
 * spec defines "mid-conversation" by what the user has received.
 */
export function shouldConfirmSwap(messages: readonly Message[]): boolean {
  return messages.some(
    (m) => m.role === "assistant" && m.status === "complete",
  );
}

// ---------- Keyboard reducer ----------

/** Snapshot of the picker's keyboard state at a keydown moment. */
export interface PickerKeydownSnapshot {
  /** `KeyboardEvent.key`. */
  key: string;
  /** True iff the picker menu is currently open. */
  isOpen: boolean;
  /** Number of selectable rows in the menu (drives arrow wrap). */
  rowCount: number;
  /** Index of the row currently highlighted (0..rowCount-1) or -1. */
  highlightedIndex: number;
}

/** What the parent should do in response to a keydown on the picker. */
export type PickerKeydownAction =
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "highlight"; index: number }
  | { kind: "select"; index: number }
  | { kind: "passthrough" };

/**
 * Pure reducer for the picker's keyboard interactions. Mirrors the
 * extraction pattern used by {@link decideKeydownAction} for the chat
 * composer.
 *
 * Contract:
 *  - When closed: Enter / Space / ArrowDown / ArrowUp open the menu.
 *    Anything else is `passthrough`.
 *  - When open: ArrowDown / ArrowUp move the highlight (with wrap).
 *    Home / End jump to first / last. Enter selects the highlighted
 *    row (or `passthrough` when no row is highlighted). Escape closes.
 *    Anything else is `passthrough`.
 */
export function decidePickerKeydown(
  s: PickerKeydownSnapshot,
): PickerKeydownAction {
  if (!s.isOpen) {
    if (
      s.key === "Enter" ||
      s.key === " " ||
      s.key === "ArrowDown" ||
      s.key === "ArrowUp"
    ) {
      return { kind: "open" };
    }
    return { kind: "passthrough" };
  }
  if (s.key === "Escape") return { kind: "close" };
  if (s.rowCount === 0) return { kind: "passthrough" };
  if (s.key === "ArrowDown") {
    const next =
      s.highlightedIndex < 0
        ? 0
        : (s.highlightedIndex + 1) % s.rowCount;
    return { kind: "highlight", index: next };
  }
  if (s.key === "ArrowUp") {
    const next =
      s.highlightedIndex <= 0
        ? s.rowCount - 1
        : s.highlightedIndex - 1;
    return { kind: "highlight", index: next };
  }
  if (s.key === "Home") return { kind: "highlight", index: 0 };
  if (s.key === "End") return { kind: "highlight", index: s.rowCount - 1 };
  if (s.key === "Enter") {
    if (s.highlightedIndex < 0 || s.highlightedIndex >= s.rowCount) {
      return { kind: "passthrough" };
    }
    return { kind: "select", index: s.highlightedIndex };
  }
  return { kind: "passthrough" };
}

// ---------- Confirmation copy ----------

/**
 * Build the body text for the destructive-swap confirmation dialog.
 * Pulled into the logic module so the copy can be asserted by tests
 * without instantiating the DOM helper.
 */
export function buildSwapConfirmCopy(
  newModelLabel: string,
  hasPendingApprovals: boolean,
): string {
  const base =
    `Switching to ${newModelLabel}. The conversation history is preserved; ` +
    `your next message will be answered by ${newModelLabel}. Continue?`;
  if (hasPendingApprovals) {
    return `${base} Any pending tool approvals will be cancelled.`;
  }
  return base;
}

// ---------- canSend() scaffold (Phase 4) ----------

/**
 * Phase 4 (FR-014 scaffold): pure decision function for "is the send
 * surface allowed to fire right now?". In Phase 4 this only mirrors
 * the v0.3 connection/streaming/pending gate so callers can pull the
 * gate through ONE function rather than reproducing the conjunction
 * inline. Phase 5 extends this with the four blocked-state taxonomy
 * (unavailable model id, catalog error, catalog empty, unresolved
 * model id).
 */
export interface CanSendSnapshot {
  isConnected: boolean;
  isStreaming: boolean;
  isPending: boolean;
}

export type CanSendResult =
  | { ok: true }
  | { ok: false; reason: string };

export function canSend(s: CanSendSnapshot): CanSendResult {
  if (!s.isConnected) {
    return { ok: false, reason: "Not connected. Open settings to sign in." };
  }
  if (s.isStreaming) {
    return { ok: false, reason: "Send is unavailable while streaming." };
  }
  if (s.isPending) {
    return { ok: false, reason: "Send is unavailable while a turn is pending." };
  }
  return { ok: true };
}
