import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      obsidian: fileURLToPath(
        new URL("./src/test/obsidianMock.ts", import.meta.url),
      ),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Most tests stay focused on domain/adapter layers. A tiny
    // Obsidian alias lets targeted UI orchestration tests import
    // ChatView without loading Obsidian's desktop runtime.
  },
});
