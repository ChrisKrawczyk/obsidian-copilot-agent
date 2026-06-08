/**
 * Returns Node's CommonJS `require` from the Electron renderer that
 * Obsidian runs in. Throws a clear error if it isn't available.
 */
export function nodeRequire(): NodeRequire {
  const w = (typeof window !== "undefined" ? window : globalThis) as {
    require?: NodeRequire;
  };
  if (typeof w.require !== "function") {
    throw new Error(
      "[copilot-agent] window.require is not available. This plugin only " +
        "works inside Obsidian Desktop. If you're running in a sandboxed " +
        "environment, ensure the plugin is loaded from .obsidian/plugins/.",
    );
  }
  return w.require;
}
