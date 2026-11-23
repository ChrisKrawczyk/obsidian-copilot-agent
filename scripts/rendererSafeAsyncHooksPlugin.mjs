import { fileURLToPath } from "node:url";

const SHIM_PATH = fileURLToPath(
  new URL("../src/sdk/rendererSafeAsyncHooks.ts", import.meta.url),
);
const SDK_PATH = /[\\/]node_modules[\\/]@github[\\/]copilot-sdk[\\/]/;

/**
 * Points `@github/copilot-sdk`'s `node:async_hooks` imports at a
 * renderer-safe `AsyncLocalStorage`. See src/sdk/rendererSafeAsyncHooks.ts.
 */
export const rendererSafeAsyncHooksPlugin = {
  name: "renderer-safe-async-hooks",
  setup(build) {
    build.onResolve({ filter: /^(node:)?async_hooks$/ }, (args) =>
      SDK_PATH.test(args.importer) ? { path: SHIM_PATH } : undefined,
    );
  },
};
