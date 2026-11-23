/**
 * Replacement for `node:async_hooks` used only by the bundled
 * `@github/copilot-sdk` (wired in via `scripts/rendererSafeAsyncHooksPlugin.mjs`).
 *
 * Node 24's `AsyncLocalStorage` stores its context in V8's
 * continuation-preserved embedder data slot. Inside Obsidian's Electron
 * renderer, Blink uses that same slot for task attribution, so a client
 * started from a user-input task (e.g. the first send of a new chat) can
 * see a Blink object where Node expects its own frame. `getStore()` then
 * hits a V8 fatal error ("null prototype chain root") that kills the
 * renderer. The SDK only uses `AsyncLocalStorage` as a session-init
 * re-entrancy guard, so a synchronous-scope store is sufficient and never
 * touches the shared slot.
 */
export * from "node:async_hooks";

export class AsyncLocalStorage<T> {
  private current: T | undefined = undefined;

  static bind<F extends (...args: never[]) => unknown>(fn: F): F {
    return fn;
  }

  static snapshot(): <R, A extends unknown[]>(fn: (...args: A) => R, ...args: A) => R {
    return (fn, ...args) => fn(...args);
  }

  getStore(): T | undefined {
    return this.current;
  }

  run<R, A extends unknown[]>(store: T, fn: (...args: A) => R, ...args: A): R {
    const prior = this.current;
    this.current = store;
    try {
      return fn(...args);
    } finally {
      this.current = prior;
    }
  }

  exit<R, A extends unknown[]>(fn: (...args: A) => R, ...args: A): R {
    return this.run(undefined as T, fn, ...args);
  }

  enterWith(store: T): void {
    this.current = store;
  }

  disable(): void {
    this.current = undefined;
  }
}
