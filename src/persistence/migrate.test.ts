import { describe, expect, it } from "vitest";
import { migrate } from "./migrate";
import { CURRENT_SCHEMA_VERSION } from "./PersistedShape";

describe("migrate (Phase 3)", () => {
  it("returns recovered:false for nullish/empty input (clean default)", () => {
    expect(migrate(null)).toEqual({
      state: emptyState(),
      recovered: false,
    });
    expect(migrate(undefined)).toEqual({
      state: emptyState(),
      recovered: false,
    });
  });

  it("returns recovered:false when schemaVersion matches and shape validates", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [],
      activeConversationId: null,
    };
    const r = migrate(raw);
    expect(r.recovered).toBe(false);
    expect(r.state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.state.conversations).toEqual([]);
  });

  it("returns recovered:true when schemaVersion is unknown (downgrade safety)", () => {
    const raw = {
      schemaVersion: 999,
      conversations: [],
      activeConversationId: null,
    };
    const r = migrate(raw);
    expect(r.recovered).toBe(true);
    expect(r.malformed).toBe(raw);
    expect(r.state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it("returns recovered:true when conversations is not an array", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: "garbage",
    };
    expect(migrate(raw).recovered).toBe(true);
  });

  it("returns recovered:true when a conversation entry is malformed", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [{ id: "x" /* missing required fields */ }],
      activeConversationId: null,
    };
    expect(migrate(raw).recovered).toBe(true);
  });

  it("preserves a well-formed conversation with messages and undo entries", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "First",
          createdAt: 1,
          lastActiveAt: 2,
          messages: [
            {
              id: "m1",
              role: "user",
              content: "hi",
              status: "complete",
              createdAt: 3,
            },
          ],
          undoEntries: [
            {
              id: "u1",
              kind: "modify",
              scope: "vault",
              path: "n.md",
              recordedAt: 4,
            },
          ],
        },
      ],
      activeConversationId: "c1",
    };
    const r = migrate(raw);
    expect(r.recovered).toBe(false);
    expect(r.state.conversations).toHaveLength(1);
    expect(r.state.conversations[0].messages[0].content).toBe("hi");
    expect(r.state.conversations[0].undoEntries[0].kind).toBe("modify");
    expect(r.state.activeConversationId).toBe("c1");
  });

  it("rejects messages with non-persistable status (e.g., streaming)", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [
            {
              id: "m1",
              role: "user",
              content: "x",
              status: "streaming",
              createdAt: 1,
            },
          ],
          undoEntries: [],
        },
      ],
      activeConversationId: null,
    };
    expect(migrate(raw).recovered).toBe(true);
  });

  it("strips unknown tool-call fields but preserves valid entries", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [
            {
              id: "m1",
              role: "assistant",
              content: "",
              status: "complete",
              createdAt: 1,
              toolCalls: [
                {
                  id: "tc1",
                  kind: "custom",
                  name: "search_by_tag",
                  outcome: "completed",
                  resultContent: "{}",
                  bogusField: 42,
                },
              ],
            },
          ],
          undoEntries: [],
        },
      ],
      activeConversationId: null,
    };
    const r = migrate(raw);
    expect(r.recovered).toBe(false);
    const tc = r.state.conversations[0].messages[0].toolCalls?.[0];
    expect(tc?.id).toBe("tc1");
    expect(tc?.outcome).toBe("completed");
    expect((tc as unknown as { bogusField?: unknown })?.bogusField).toBeUndefined();
  });
});

function emptyState() {
  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    conversations: [],
    activeConversationId: null,
  };
}

/**
 * v0.4 (model-picker) Phase 1 regression suite. Properties under test
 * are explicit Phase 1 acceptance gates from ImplementationPlan.md:
 *
 *   - Existing v0.3 (schemaVersion: 1) blobs do NOT enter the
 *     recovery path on first v0.4 load (which would wipe user data).
 *   - Each migrated conversation has `modelId === null`, signalling
 *     "not yet resolved" so a later phase's lazy resolver can fill it.
 *   - The output blob carries CURRENT_SCHEMA_VERSION so subsequent
 *     loads validate as v2 directly.
 *   - The v2 path round-trips `modelId` (string / null / missing) and
 *     normalizes structurally-invalid optional `modelId` values to
 *     null without recovering otherwise-valid conversations.
 */
describe("migrate — v0.4 v1 → v2 upcast (GATING)", () => {
  it("upcasts a v0.3 (schemaVersion=1) blob to v2 without recovery", () => {
    const v1Blob = {
      schemaVersion: 1,
      conversations: [
        {
          id: "c1",
          name: "Project",
          createdAt: 10,
          lastActiveAt: 20,
          messages: [],
          undoEntries: [],
        },
        {
          id: "c2",
          name: "Notes",
          createdAt: 5,
          lastActiveAt: 6,
          archived: true,
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    };

    const r = migrate(v1Blob);

    expect(r.recovered).toBe(false);
    expect(r.malformed).toBeUndefined();
    expect(r.state.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(r.state.activeConversationId).toBe("c1");
    expect(r.state.conversations).toHaveLength(2);
    for (const c of r.state.conversations) {
      expect(c.modelId).toBeNull();
    }
    expect(r.state.conversations[1].archived).toBe(true);
  });

  it("rejects a v1 blob whose conversations array is malformed", () => {
    const r = migrate({
      schemaVersion: 1,
      conversations: "not-an-array",
      activeConversationId: null,
    });
    expect(r.recovered).toBe(true);
    expect(r.state.conversations).toEqual([]);
  });
});

describe("migrate — v0.4 modelId round-trip", () => {
  function v2Blob(extra: Record<string, unknown>) {
    return {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "x",
          createdAt: 1,
          lastActiveAt: 1,
          messages: [],
          undoEntries: [],
          ...extra,
        },
      ],
      activeConversationId: null,
    };
  }

  it("preserves a string modelId verbatim", () => {
    const r = migrate(v2Blob({ modelId: "gpt-4.1" }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBe("gpt-4.1");
  });

  it("preserves a null modelId verbatim", () => {
    const r = migrate(v2Blob({ modelId: null }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBeNull();
  });

  it("treats a missing modelId as undefined (key not present)", () => {
    const r = migrate(v2Blob({}));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBeUndefined();
  });

  it("normalizes a structurally-invalid modelId (number) to null", () => {
    const r = migrate(v2Blob({ modelId: 42 }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBeNull();
  });

  it("normalizes an empty-string modelId to null", () => {
    const r = migrate(v2Blob({ modelId: "" }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBeNull();
  });

  it("normalizes a non-string non-null modelId (object) to null", () => {
    const r = migrate(v2Blob({ modelId: { id: "x" } }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].modelId).toBeNull();
  });

  it("preserves conversations and siblings when one optional modelId is invalid", () => {
    const raw = {
      schemaVersion: CURRENT_SCHEMA_VERSION,
      conversations: [
        {
          id: "c1",
          name: "bad optional field",
          createdAt: 1,
          lastActiveAt: 2,
          modelId: 42,
          messages: [],
          undoEntries: [],
        },
        {
          id: "c2",
          name: "sibling",
          createdAt: 3,
          lastActiveAt: 4,
          modelId: "gpt-4o",
          messages: [],
          undoEntries: [],
        },
      ],
      activeConversationId: "c1",
    };

    const r = migrate(raw);

    expect(r.recovered).toBe(false);
    expect(r.state.conversations.map((c) => c.id)).toEqual(["c1", "c2"]);
    expect(r.state.conversations[0].modelId).toBeNull();
    expect(r.state.conversations[1].modelId).toBe("gpt-4o");
    expect(r.state.activeConversationId).toBe("c1");
  });

  it("keeps valid sdkSessionId and contextBoundary", () => {
    const boundary = { afterMessageId: "m1", reason: "legacy", state: "offered" };
    const r = migrate(v2Blob({ sdkSessionId: "sess-1", contextBoundary: boundary }));
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].sdkSessionId).toBe("sess-1");
    expect(r.state.conversations[0].contextBoundary).toEqual(boundary);
  });

  it("normalizes invalid sdkSessionId to null and drops a malformed contextBoundary", () => {
    const r = migrate(
      v2Blob({
        sdkSessionId: 42,
        contextBoundary: { afterMessageId: "m1", reason: "nope", state: "sent" },
      }),
    );
    expect(r.recovered).toBe(false);
    expect(r.state.conversations).toHaveLength(1);
    expect(r.state.conversations[0].sdkSessionId).toBeNull();
    expect("contextBoundary" in r.state.conversations[0]).toBe(false);
  });

  it("keeps well-formed safetyGrants entries and drops junk", () => {
    const r = migrate(
      v2Blob({
        safetyGrants: { vault: "yes", mcp: ["mcp:s:e:t", 7, ""], builtin: "shell" },
      }),
    );
    expect(r.recovered).toBe(false);
    expect(r.state.conversations[0].safetyGrants).toEqual({ mcp: ["mcp:s:e:t"] });

    const empty = migrate(v2Blob({ safetyGrants: { vault: false } }));
    expect("safetyGrants" in empty.state.conversations[0]).toBe(false);
  });

  describe("batch undo entries", () => {
    function withUndo(entry: Record<string, unknown>) {
      return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversations: [
          { id: "c1", name: "x", createdAt: 1, lastActiveAt: 1, messages: [], undoEntries: [entry] },
        ],
        activeConversationId: null,
      };
    }
    const batch = {
      id: "u9",
      kind: "batch",
      scope: "vault",
      path: "a.md",
      recordedAt: 5,
      label: "2 items",
      items: [
        { op: "modify", path: "a.md", before: "1", after: "2" },
        { op: "create", path: "b.md", after: "x" },
        { op: "delete", path: "c.md", before: "y" },
        { op: "move", from: "d.md", to: "e/d.md" },
      ],
    };

    it("round-trips a well-formed batch entry", () => {
      const r = migrate(withUndo(batch));
      expect(r.recovered).toBe(false);
      expect(r.state.conversations[0].undoEntries[0]).toEqual({
        id: "u9",
        kind: "batch",
        scope: "vault",
        path: "a.md",
        recordedAt: 5,
        before: undefined,
        after: undefined,
        undone: undefined,
        label: "2 items",
        items: batch.items,
      });
    });

    it.each([
      ["missing items", { ...batch, items: undefined }],
      ["empty items", { ...batch, items: [] }],
      ["unknown op", { ...batch, items: [{ op: "copy", path: "a" }] }],
      ["modify without after", { ...batch, items: [{ op: "modify", path: "a", before: "1" }] }],
      ["move without to", { ...batch, items: [{ op: "move", from: "a" }] }],
    ])("rejects a malformed batch entry (%s)", (_name, entry) => {
      expect(migrate(withUndo(entry as Record<string, unknown>)).recovered).toBe(true);
    });

    it("leaves single-path entries without batch fields", () => {
      const r = migrate(withUndo({ id: "u1", kind: "modify", scope: "vault", path: "n.md", recordedAt: 4, items: [1] }));
      expect(r.recovered).toBe(false);
      expect("items" in r.state.conversations[0].undoEntries[0]).toBe(false);
    });
  });

  describe("tool-call vault changes", () => {
    function withCall(call: Record<string, unknown>) {
      return {
        schemaVersion: CURRENT_SCHEMA_VERSION,
        conversations: [
          {
            id: "c1",
            name: "x",
            createdAt: 1,
            lastActiveAt: 1,
            undoEntries: [],
            messages: [
              {
                id: "m1",
                role: "assistant",
                content: "",
                status: "complete",
                createdAt: 1,
                toolCalls: [{ id: "t1", kind: "tool", source: "builtin", outcome: "completed", ...call }],
              },
            ],
          },
        ],
        activeConversationId: null,
      };
    }
    const callOf = (r: ReturnType<typeof migrate>) => r.state.conversations[0].messages[0].toolCalls![0];

    it("round-trips well-formed changes and overflow", () => {
      const changes = [
        { type: "modified", path: "a.md" },
        { type: "renamed", path: "b/c.md", oldPath: "c.md" },
      ];
      const r = migrate(withCall({ vaultChanges: changes, vaultChangesOverflow: 3 }));
      expect(r.recovered).toBe(false);
      expect(callOf(r).vaultChanges).toEqual(changes);
      expect(callOf(r).vaultChangesOverflow).toBe(3);
    });

    it("drops malformed entries and keeps the call", () => {
      const r = migrate(
        withCall({
          vaultChanges: [
            { type: "exploded", path: "a.md" },
            { type: "modified" },
            null,
            { type: "deleted", path: "z.md", oldPath: "ignored.md" },
          ],
          vaultChangesOverflow: -4,
        }),
      );
      expect(r.recovered).toBe(false);
      expect(callOf(r).vaultChanges).toEqual([{ type: "deleted", path: "z.md" }]);
      expect(callOf(r).vaultChangesOverflow).toBeUndefined();
    });

    it("omits the fields when nothing valid remains", () => {
      const r = migrate(withCall({ vaultChanges: "nope", vaultChangesOverflow: 2 }));
      expect("vaultChanges" in callOf(r)).toBe(false);
      expect("vaultChangesOverflow" in callOf(r)).toBe(false);
    });

    it("caps the list and counts the rest as overflow", () => {
      const many = Array.from({ length: 25 }, (_, i) => ({ type: "created", path: `n${i}.md` }));
      const r = migrate(withCall({ vaultChanges: many, vaultChangesOverflow: 1 }));
      expect(callOf(r).vaultChanges).toHaveLength(20);
      expect(callOf(r).vaultChangesOverflow).toBe(6);
    });
  });
});
