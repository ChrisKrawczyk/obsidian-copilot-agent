import { describe, expect, test } from "vitest";
import { createReadTools, type ReadToolsVault } from "./ReadTools";
import { createReadNoteTools } from "./ReadNoteTools";
import { createSearchTools } from "./SearchTools";
import { createNavigateTools } from "./NavigateTools";
import { ObsidianApi, type AppLike } from "./ObsidianApi";

/**
 * Session-plumbing gate for the read-only capability set exposed in
 * v0.10 (Phase 1–4). These tools are registered with
 * `skipPermission: true`; the SDK never surfaces a permission prompt
 * for them, so per-turn approval never gates use.
 *
 * This test asserts the invariant at the assembly seam that
 * `main.ts` uses (build the four factories, hand the resulting
 * SdkTool list to the SDK). It ensures a future factory can't
 * silently forget `skipPermission: true` on any of the six
 * agent-native navigation capabilities called out in Spec.md
 * (search_content, search_vault, resolve_link, get_outlinks,
 * get_note_structure, related_notes) — and, defensively, on every
 * other read-only capability shipped alongside them.
 */
describe("v0.10 read-only session-plumbing gate", () => {
  function makeApp(): AppLike {
    const files: unknown[] = [];
    const app: AppLike = {
      vault: {
        adapter: { getBasePath: () => "C:\\vault" },
        getMarkdownFiles: () => files as never,
        getAbstractFileByPath: () => null,
        getFileByPath: () => null,
        read: async () => "",
        cachedRead: async () => "",
      } as never,
      workspace: {
        getActiveFile: () => null,
        openLinkText: () => {},
      } as never,
      metadataCache: {
        getFileCache: () => null,
        getFirstLinkpathDest: () => null,
      } as never,
    };
    return app;
  }

  test("every registered v0.10 read-only tool bypasses the permission callback", () => {
    const app = makeApp();
    const vault = app.vault as unknown as ReadToolsVault;
    const api = new ObsidianApi(app);

    const tools = [
      ...createReadTools(vault),
      ...createReadNoteTools(api, vault),
      ...createSearchTools(api, vault),
      ...createNavigateTools(api, vault),
    ] as Array<{ name: string; skipPermission?: boolean }>;

    // Sanity: assembly produced tools.
    expect(tools.length).toBeGreaterThan(0);

    // Every tool in the read-only set must skip the permission prompt.
    // A regression here would silently reintroduce a per-call approval
    // gate on read-only vault navigation and break the "unattended
    // agent" contract from Spec.md FR-017.
    for (const t of tools) {
      expect(
        t.skipPermission,
        `Tool "${t.name}" must set skipPermission: true`,
      ).toBe(true);
    }

    // All six agent-native navigation capabilities from the v0.10 spec
    // must be present in the assembled set.
    const names = new Set(tools.map((t) => t.name));
    for (const required of [
      "search_content",
      "search_vault",
      "resolve_link",
      "get_outlinks",
      "get_note_structure",
      "related_notes",
    ]) {
      expect(names.has(required), `Missing capability: ${required}`).toBe(true);
    }
  });
});
