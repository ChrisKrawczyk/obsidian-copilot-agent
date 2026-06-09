import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Phase 2 keeps tests focused on the domain and adapter layers.
    // UI tests would require a DOM stub for `obsidian` and are out of
    // scope here; we lean on manual verification in Obsidian for that.
  },
});
