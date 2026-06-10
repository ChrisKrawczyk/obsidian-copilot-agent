/**
 * Pure decision function for the chat composer's `keydown` handler.
 *
 * Extracted from ChatView so the keyboard policy can be exercised by
 * unit tests without standing up a full DOM. ChatView passes a snapshot
 * of the relevant input/composer state and reacts to the returned action.
 *
 * Behaviour mirrors VS Code's chat input:
 *   - Plain Enter (with non-whitespace text, not streaming, connected) submits.
 *   - Shift+Enter inserts a newline (default textarea behaviour).
 *   - Enter during IME composition does NOT submit (composition commits the
 *     candidate; a second Enter would then submit).
 *   - Enter with whitespace-only input is a no-op (and we preventDefault so the
 *     textarea doesn't visibly grow).
 *   - Enter while a stream is in flight does NOT submit AND does NOT stop —
 *     Stop is only the Stop button (per spec FR-004).
 *
 * Ctrl/Cmd+Enter is deliberately NOT a special key in v0.2: the v0.1 binding
 * (which mapped Ctrl/Cmd+Enter to handleSendOrStop, doubling as a "stop"
 * keybind while streaming) is retired so the "Enter never stops a stream"
 * invariant holds end-to-end.
 */
export interface KeydownSnapshot {
  /** `KeyboardEvent.key`. */
  key: string;
  /** `KeyboardEvent.shiftKey`. */
  shiftKey: boolean;
  /**
   * `KeyboardEvent.isComposing`. True while an IME composition session is
   * active. We also accept this being inferred by the caller from
   * compositionstart/compositionend events.
   */
  isComposing: boolean;
  /**
   * `KeyboardEvent.keyCode`. Some browser/Electron versions surface the
   * "composition still in progress" keydown as keyCode 229 even when
   * `isComposing` has already flipped to false; we treat 229 as composing.
   */
  keyCode: number;
  /** True when the input contains at least one non-whitespace character. */
  hasText: boolean;
  /** True when a stream is in flight (Send button is showing "Stop"). */
  isStreaming: boolean;
  /**
   * True when a send is pending (pre-stream). Distinct from isStreaming so
   * the gate covers both states.
   */
  isPending: boolean;
  /** True when the session is connected and accepting input. */
  isConnected: boolean;
}

export type KeydownAction =
  /** Call submitMessage(); caller MUST preventDefault. */
  | "submit"
  /** Let the textarea insert a newline; caller MUST NOT preventDefault. */
  | "newline"
  /**
   * Enter pressed but not eligible to submit (empty, streaming, pending, or
   * disconnected). Caller MUST preventDefault so the textarea does not also
   * insert a newline, but MUST NOT call submitMessage or the Stop handler.
   */
  | "noop-prevent"
  /** Not an Enter key (or Enter during IME composition). Caller MUST NOT preventDefault. */
  | "passthrough";

export function decideKeydownAction(s: KeydownSnapshot): KeydownAction {
  if (s.key !== "Enter") return "passthrough";
  if (s.shiftKey) return "newline";
  // IME composition: keyCode 229 OR isComposing flag. Pass through so the
  // composition commits via the textarea's default handling.
  if (s.isComposing || s.keyCode === 229) return "passthrough";
  if (s.isStreaming || s.isPending) return "noop-prevent";
  if (!s.isConnected) return "noop-prevent";
  if (!s.hasText) return "noop-prevent";
  return "submit";
}
