import type { ChatState } from "../domain/ChatState";

export interface SegmentSplit {
  /** Id of the transcript message holding the follow-up text. */
  userMessageId: string;
  /** Fresh pending assistant placeholder the stream continues into. */
  nextPlaceholderId: string;
  /**
   * True when the old placeholder was still empty and became the user
   * message (so nothing was appended for it); false when it was
   * finalized as a completed assistant segment.
   */
  converted: boolean;
}

/**
 * Split a live assistant turn when a steering/queued follow-up reaches the
 * model: close the current assistant segment, record the user's message,
 * and open a new placeholder for the rest of the stream.
 *
 * An empty placeholder (no text, no tool calls) is turned into the user
 * message instead of leaving an empty assistant bubble behind.
 * `previousSegmentContent` is the SDK's final text for the closing segment
 * and wins over the concatenated deltas, as for a normal `complete`.
 */
export function splitTurnAtFollowUp(
  state: ChatState,
  placeholderId: string,
  text: string,
  previousSegmentContent?: string,
): SegmentSplit {
  const current = state.getMessages().find((m) => m.id === placeholderId);
  let userMessageId: string;
  let converted = false;
  if (
    current &&
    current.content.trim().length === 0 &&
    !previousSegmentContent &&
    (current.toolCalls?.length ?? 0) === 0
  ) {
    state.update(placeholderId, { role: "user", content: text, status: "complete" });
    userMessageId = placeholderId;
    converted = true;
  } else {
    if (current) {
      state.update(placeholderId, {
        content: previousSegmentContent || current.content,
        status: "complete",
      });
    }
    userMessageId = state.append({ role: "user", content: text });
  }
  const nextPlaceholderId = state.append({
    role: "assistant",
    content: "",
    status: "pending",
  });
  return { userMessageId, nextPlaceholderId, converted };
}
