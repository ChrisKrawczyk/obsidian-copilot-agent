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
