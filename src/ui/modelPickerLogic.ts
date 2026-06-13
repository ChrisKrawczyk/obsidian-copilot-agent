// v0.4 Phase 4: pure (DOM-free) helpers for ModelPicker.
//
// Extracted into its own module so we can unit-test render-state /
// identity-swap / confirmation-derivation logic in node (per
// vitest.config.ts), without dragging Obsidian's DOM into the test
// environment. Mirrors the pattern used for
// `src/ui/conversationPickerLogic.ts` and `src/ui/chatKeydown.ts`.
//
// Anything that produces or mutates HTML lives in `ModelPicker.ts`;
// anything that decides what items to show or whether to confirm
// lives here. Keyboard accessibility is owned by Obsidian's native
// Menu widget in `ModelPicker.ts`.

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
  /**
   * Phase 5: a sentinel row prepended when the active conversation's
   * persisted `modelId` is not in the catalog's chat-capable list.
   * The picker renders it disabled with an "(unavailable)" suffix +
   * checkmark so the user understands which conversation-bound id
   * is missing; selecting any other row clears the inline error.
   */
  unavailable?: boolean;
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
    // Phase 5 (FR-010): unavailable-id sentinel row when the active
    // conv's bound id is non-null and the ready catalog does not
    // contain it. Prepend so it's visually grouped with the current
    // selection; mark it as both `isCurrent` and `unavailable` so the
    // picker can render the checkmark + "(unavailable)" suffix.
    if (
      typeof currentId === "string" &&
      currentId.length > 0 &&
      !rows.some((r) => r.id === currentId)
    ) {
      rows.unshift({
        id: currentId,
        label: `${currentId} (unavailable)`,
        isCurrent: true,
        unavailable: true,
      });
    }
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
  /** Phase 5: catalog state for the four catalog-related blocked
   *  reasons. Optional so Phase 4 callers (and tests of the v0.3
   *  gate) can omit it without spurious blocked-state returns. */
  catalogState?: ModelCatalogState;
  /** Phase 5: active conversation's bound modelId. May be null/
   *  undefined for v0.3-migrated convs and Phase-5 deferred-init
   *  cases. Drives both unavailable-model and unresolved-model. */
  activeModelId?: string | null;
}

export type CanSendResult =
  | { ok: true }
  | { ok: false; reason: string; kind: SendBlockReason };

// ---------- canSend() (Phase 5: full taxonomy) ----------

/**
 * Reason taxonomy for blocked sends. The chat view consumes this to
 * disable the send button AND to drive the inline-error banner copy
 * + retry affordance. Precedence between catalog-error / catalog-
 * empty / unavailable-id / unresolved-id is enforced by the
 * caller-supplied snapshot ordering inside `canSend()` — the spec
 * (plan §359) defines: `unavailable-id > catalog-error > catalog-
 * empty > stream-error` for the BANNER, and `canSend()` adopts the
 * same order so the disabled-reason text matches the visible banner.
 *
 * `connection-loss`, `streaming`, `pending` are the v0.3 reasons,
 * preserved verbatim so the existing block-reason taxonomy stays a
 * single source of truth.
 */
export type SendBlockReason =
  | "connection-loss"
  | "streaming"
  | "pending"
  /** Catalog non-ready AND no usable persisted modelId. */
  | "unresolved-model"
  /** Active conv has a modelId that the ready catalog does NOT contain. */
  | "unavailable-model"
  /** Catalog state === "error" (transient list-models failure). */
  | "catalog-error"
  /** Catalog state === "empty" (account has zero chat-capable models). */
  | "catalog-empty";

/**
 * Phase 5 (FR-014): pure decision function for "is the send surface
 * allowed to fire right now?". Extends the Phase 4 scaffold with the
 * four catalog/model blocked states.
 *
 * Precedence: connection-loss > streaming > pending > unavailable-
 * model > catalog-error > catalog-empty > unresolved-model.
 *
 * `activeModelId === null` means the active conv has no bound id
 * (v0.3-migrated or created while catalog was degraded). It blocks
 * only when the catalog also can't help (non-ready) — otherwise the
 * resolver / runtime will pick an id on send.
 */
export function canSend(s: CanSendSnapshot): CanSendResult {
  if (!s.isConnected) {
    return {
      ok: false,
      reason: "Not connected. Open settings to sign in.",
      kind: "connection-loss",
    };
  }
  if (s.isStreaming) {
    return {
      ok: false,
      reason: "Send is unavailable while streaming.",
      kind: "streaming",
    };
  }
  if (s.isPending) {
    return {
      ok: false,
      reason: "Send is unavailable while a turn is pending.",
      kind: "pending",
    };
  }
  const cat = s.catalogState;
  if (cat) {
    if (
      cat.kind === "ready" &&
      typeof s.activeModelId === "string" &&
      s.activeModelId.length > 0 &&
      !cat.chatModels.some((m) => m.id === s.activeModelId)
    ) {
      return {
        ok: false,
        reason: `Model \`${s.activeModelId}\` is no longer available. Pick a model to continue.`,
        kind: "unavailable-model",
      };
    }
    if (cat.kind === "error") {
      return {
        ok: false,
        reason: `Models unavailable: ${cat.message}`,
        kind: "catalog-error",
      };
    }
    if (cat.kind === "empty") {
      return {
        ok: false,
        reason: "No chat models available.",
        kind: "catalog-empty",
      };
    }
    if (
      cat.kind !== "ready" &&
      (typeof s.activeModelId !== "string" || s.activeModelId.length === 0)
    ) {
      return {
        ok: false,
        reason: "No model selected. Pick a model to continue.",
        kind: "unresolved-model",
      };
    }
  }
  return { ok: true };
}
