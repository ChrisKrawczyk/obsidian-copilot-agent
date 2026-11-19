/**
 * Pure decision function for the chat composer's `keydown` handler.
 *
 * Extracted from ChatView so the keyboard policy can be exercised by
 * unit tests without standing up a full DOM. ChatView passes a snapshot
 * of the relevant input/composer state and reacts to the returned action.
 *
 * Behaviour mirrors VS Code's chat input and Copilot CLI:
 *   - Plain Enter (with non-whitespace text, not streaming, connected) submits.
 *   - Shift+Enter inserts a newline (default textarea behaviour).
 *   - Enter during IME composition does NOT submit (composition commits the
 *     candidate; a second Enter would then submit).
 *   - Enter with whitespace-only input is a no-op (and we preventDefault so the
 *     textarea doesn't visibly grow).
 *   - While a stream is in flight and follow-ups are allowed, Enter steers the
 *     running turn and Ctrl/Cmd+Enter queues the text as the next turn. Neither
 *     key ever stops a stream — Stop is only the Stop button / menu.
 *   - ArrowUp in an empty composer takes back the most recent unread
 *     follow-up (the caller restores its text into the input).
 *   - When idle, Ctrl/Cmd+Enter submits like Enter.
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
  /** `KeyboardEvent.ctrlKey || KeyboardEvent.metaKey`. */
  modKey?: boolean;
  /**
   * True when a follow-up can be sent into the live stream (streaming in
   * the bound conversation, runtime supports it, not stopping).
   */
  canFollowUp?: boolean;
  /** True when there is an unread follow-up that can be taken back. */
  canRetract?: boolean;
}

export type KeydownAction =
  /** Call submitMessage(); caller MUST preventDefault. */
  | "submit"
  /** Send the text as a steering follow-up; caller MUST preventDefault. */
  | "steer"
  /** Queue the text as the next turn; caller MUST preventDefault. */
  | "queue"
  /**
   * Withdraw the most recent unread follow-up and restore its text;
   * caller MUST preventDefault.
   */
  | "retract"
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
  const composing = s.isComposing || s.keyCode === 229;
  if (s.key === "ArrowUp") {
    const plain = !s.shiftKey && !s.modKey && !composing;
    return plain && !s.hasText && s.canRetract ? "retract" : "passthrough";
  }
  if (s.key !== "Enter") return "passthrough";
  if (s.shiftKey) return "newline";
  // IME composition: keyCode 229 OR isComposing flag. Pass through so the
  // composition commits via the textarea's default handling.
  if (composing) return "passthrough";
  if (s.isStreaming) {
    if (s.canFollowUp && s.isConnected && s.hasText) {
      return s.modKey ? "queue" : "steer";
    }
    return "noop-prevent";
  }
  if (s.isPending) return "noop-prevent";
  if (!s.isConnected) return "noop-prevent";
  if (!s.hasText) return "noop-prevent";
  return "submit";
}
