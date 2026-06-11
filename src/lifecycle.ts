// v0.3 Phase 5: small lifecycle helpers extracted from `main.ts` so
// the onunload flush-before-dispose ordering and the workspace 'quit'
// flush handler can be unit-tested without spinning up the full
// CopilotAgentPlugin (which depends on the Obsidian app, CLI binary
// resolution, AuthController, etc.).
//
// Keep these as pure functions taking the two relevant collaborators
// — no plugin-instance side effects, no console wrappers beyond what
// the production code needs.

interface FlushSink {
  flushNow(): Promise<void>;
}

interface DisposeSink {
  disposeAll(): Promise<void>;
}

/**
 * Flush ANY in-flight debounced writes from the conversations store
 * BEFORE disposing the manager's runtimes. Order matters: disposing
 * cancels SDK streams but leaves the journal/store deltas in memory;
 * if we dispose first and *then* flush, we may have already torn down
 * the timer that would have written them.
 *
 * Both arguments are nullable so callers can pass through their fields
 * without local guards. Each call is wrapped so a throw in one does
 * not skip the other.
 */
export async function flushThenDispose(
  store: FlushSink | null | undefined,
  manager: DisposeSink | null | undefined,
): Promise<void> {
  if (store) {
    try {
      await store.flushNow();
    } catch (err) {
      console.warn("[copilot-agent] conversationsStore.flushNow threw", err);
    }
  }
  if (manager) {
    try {
      await manager.disposeAll();
    } catch (err) {
      console.warn("[copilot-agent] manager.disposeAll threw", err);
    }
  }
}

/**
 * Build the workspace 'quit' callback. Looks up the store fresh each
 * tick via `getStore` so the handler can survive plugin reload/teardown
 * without holding a stale reference. Errors are logged, not re-thrown
 * (Obsidian awaits the quit handler — a throw would block the app
 * close indefinitely).
 */
export function makeQuitFlushHandler(
  getStore: () => FlushSink | null | undefined,
): () => Promise<void> {
  return async () => {
    try {
      const store = getStore();
      await store?.flushNow();
    } catch (err) {
      console.warn("[copilot-agent] quit-flush threw", err);
    }
  };
}
