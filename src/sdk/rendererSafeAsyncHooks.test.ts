import { describe, expect, it } from "vitest";
import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { AsyncLocalStorage } from "./rendererSafeAsyncHooks";
// @ts-expect-error untyped build script
import { rendererSafeAsyncHooksPlugin } from "../../scripts/rendererSafeAsyncHooksPlugin.mjs";

describe("rendererSafeAsyncHooks AsyncLocalStorage", () => {
  it("scopes the store to run() and restores it after nesting and throws", () => {
    const als = new AsyncLocalStorage<string>();
    expect(als.getStore()).toBeUndefined();
    als.run("outer", () => {
      expect(als.getStore()).toBe("outer");
      expect(() =>
        als.run("inner", () => {
          expect(als.getStore()).toBe("inner");
          throw new Error("boom");
        }),
      ).toThrow("boom");
      expect(als.getStore()).toBe("outer");
    });
    expect(als.getStore()).toBeUndefined();
  });
});

describe("renderer-safe async_hooks bundling", () => {
  it("routes the SDK's AsyncLocalStorage to the shim", async () => {
    const result = await esbuild.build({
      stdin: {
        contents: 'export { CopilotClient } from "@github/copilot-sdk";',
        resolveDir: fileURLToPath(new URL("../..", import.meta.url)),
      },
      bundle: true,
      write: false,
      format: "cjs",
      platform: "node",
      target: "es2022",
      logLevel: "silent",
      plugins: [rendererSafeAsyncHooksPlugin],
      external: [
        "koffi",
        ...builtinModules,
        ...builtinModules.map((m) => `node:${m}`),
      ],
    });
    const out = result.outputFiles[0].text;
    const asyncHooksRequires = out.match(/require\("(node:)?async_hooks"\)/g) ?? [];
    // Only the shim's own re-export may load the real module.
    expect(asyncHooksRequires).toHaveLength(1);
    expect(out).toContain("sessionInitializationContext = new AsyncLocalStorage()");
    expect(out).not.toMatch(/import_node_async_hooks\d*\.AsyncLocalStorage/);
  }, 30_000);
});
