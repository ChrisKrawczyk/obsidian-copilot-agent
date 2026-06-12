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
 *     rejects structurally-invalid values into recovery.
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

  it("rejects a structurally-invalid modelId (number)", () => {
    expect(migrate(v2Blob({ modelId: 42 })).recovered).toBe(true);
  });

  it("rejects an empty-string modelId", () => {
    expect(migrate(v2Blob({ modelId: "" })).recovered).toBe(true);
  });

  it("rejects a non-string non-null modelId (object)", () => {
    expect(migrate(v2Blob({ modelId: { id: "x" } })).recovered).toBe(true);
  });
});
