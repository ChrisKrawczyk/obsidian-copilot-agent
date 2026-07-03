/**
 * ReadinessGateBus — a small, plugin-scope event bus that forwards
 * MCP readiness-gate lifecycle events from every live
 * {@link AgentSession} to any ChatView that has bound its
 * `boundConversationId`.
 *
 * Why: the readiness gate lives inside `AgentSession`, but the pill
 * that visualizes it lives inside `ChatView`. Wiring them directly
 * would couple the SDK layer to the UI, and would also break when
 * the ChatView activates a conversation whose runtime already
 * dispatched the `start` event before this view instance existed.
 * The bus decouples the producer/consumer relationship: sessions
 * publish to a single plugin-scope instance; ChatViews subscribe
 * and filter by `conversationId`.
 *
 * The payload deliberately carries only two event kinds — `start`
 * and `resolved`. `McpManager.waitUntilEnabledReady` already resolves
 * silently on either the "all connected" or "timed out" outcome, and
 * the pill's UX is the same in both cases (spec P1 scenario 4).
 * Planning-docs review S6 flagged that a separate `timed-out` event
 * would duplicate the manager's own timeout without adding value.
 *
 * For late-bound observers (users activate a conversation whose gate
 * is already running), the bus is complemented by the synchronous
 * `AgentSession.isReadinessGateWaiting()` getter — subscribers seed
 * their state from that accessor on bind, then let bus events drive
 * subsequent transitions.
 */

export type ReadinessGateEvent = {
  conversationId: string;
  kind: "start" | "resolved";
};

export type ReadinessGateListener = (evt: ReadinessGateEvent) => void;

export class ReadinessGateBus {
  private listeners = new Set<ReadinessGateListener>();

  subscribe(listener: ReadinessGateListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(evt: ReadinessGateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(evt);
      } catch {
        // Isolation: one bad listener must not stall the rest.
      }
    }
  }

  disposeAll(): void {
    this.listeners.clear();
  }
}
