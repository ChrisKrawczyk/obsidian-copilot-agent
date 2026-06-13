import { beforeEach, describe, expect, test, vi } from "vitest";
import { ChatState } from "../domain/ChatState";
import type { ConversationRuntime } from "../domain/ConversationRuntime";
import type { ConversationManager } from "../domain/ConversationManager";
import type { ModelCatalog } from "../sdk/ModelCatalog";

const obsidianMocks = vi.hoisted(() => ({
  Notice: vi.fn(function Notice() {}),
  setIcon: vi.fn(),
}));

vi.mock(
  "obsidian",
  () => ({
    ItemView: class {
      app: unknown;
      containerEl = { children: [{}, {}] };
      constructor(leaf: { app?: unknown }) {
        this.app = leaf.app ?? {};
      }
    },
    Notice: obsidianMocks.Notice,
    setIcon: obsidianMocks.setIcon,
    Menu: class {
      addItem(): void {}
      showAtPosition(): void {}
    },
  }),
  { virtual: true },
);

const conversationPickerMocks = vi.hoisted(() => ({
  confirmDestructive: vi.fn(),
}));

vi.mock("./ConversationPicker", () => ({
  ConversationPicker: class {},
  confirmDestructive: conversationPickerMocks.confirmDestructive,
  promptForText: vi.fn(),
}));

import { ChatView } from "./ChatView";

function makeRuntime(
  id: string,
  state = new ChatState(),
  setModelId = vi.fn(async () => {}),
): ConversationRuntime {
  return {
    conversationId: id,
    state,
    setModelId,
    session: {
      hasPendingApprovals: vi.fn(() => false),
    } as unknown as ConversationRuntime["session"],
    journal: {} as ConversationRuntime["journal"],
    dispose: vi.fn(async () => {}),
  };
}

function makeView(args: {
  activeId: { current: string };
  runtimes: Map<string, ConversationRuntime>;
  modelIds?: Record<string, string | null>;
}): ChatView {
  const manager = {
    getActiveId: () => args.activeId.current,
    get: (id: string) => ({
      id,
      name: id,
      createdAt: 1,
      lastActiveAt: 1,
      modelId: args.modelIds?.[id] ?? "old-model",
    }),
    getActiveRuntime: () => args.runtimes.get(args.activeId.current)!,
  } as unknown as ConversationManager;
  const auth = { subscribe: vi.fn(() => () => {}) };
  const modelCatalog = {
    getState: () => ({
      kind: "ready",
      models: [{ id: "new-model", name: "New Model" }],
      chatModels: [{ id: "new-model", name: "New Model" }],
    }),
    subscribe: vi.fn(() => () => {}),
  } as unknown as ModelCatalog;
  return new ChatView({ app: {} } as never, {
    manager,
    auth: auth as never,
    openSettings: vi.fn(),
    getExposeRawFsTools: () => false,
    modelCatalog,
  });
}

describe("ChatView.handleModelPick", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test("cancels a confirmed swap when the active conversation changed during confirmation", async () => {
    const c1State = new ChatState([
      {
        id: "a1",
        role: "assistant",
        content: "done",
        status: "complete",
        createdAt: 1,
      },
    ]);
    const c1SetModelId = vi.fn(async () => {});
    const c2SetModelId = vi.fn(async () => {});
    const activeId = { current: "c1" };
    const view = makeView({
      activeId,
      runtimes: new Map([
        ["c1", makeRuntime("c1", c1State, c1SetModelId)],
        ["c2", makeRuntime("c2", new ChatState(), c2SetModelId)],
      ]),
    });
    conversationPickerMocks.confirmDestructive.mockImplementation(async () => {
      activeId.current = "c2";
      return true;
    });

    await (view as unknown as { handleModelPick(id: string): Promise<void> })
      .handleModelPick("new-model");

    expect(c1SetModelId).not.toHaveBeenCalled();
    expect(c2SetModelId).not.toHaveBeenCalled();
    expect(obsidianMocks.Notice).toHaveBeenCalledWith(
      "Conversation changed; swap cancelled.",
      4000,
    );
  });

  test("interrupts the active streaming placeholder before swapping models", async () => {
    const state = new ChatState();
    const placeholderId = state.append({
      role: "assistant",
      content: "partial",
      status: "streaming",
    });
    const setModelId = vi.fn(async () => {
      expect(state.getMessages().find((m) => m.id === placeholderId)?.status)
        .toBe("interrupted");
    });
    const runtime = makeRuntime("c1", state, setModelId);
    const activeId = { current: "c1" };
    const view = makeView({
      activeId,
      runtimes: new Map([["c1", runtime]]),
    }) as unknown as {
      handleModelPick(id: string): Promise<void>;
      currentPlaceholderId?: string;
      currentStreamState?: ChatState;
      currentStreamSession?: ConversationRuntime["session"];
    };
    view.currentPlaceholderId = placeholderId;
    view.currentStreamState = state;
    view.currentStreamSession = runtime.session;

    await view.handleModelPick("new-model");

    expect(setModelId).toHaveBeenCalledWith("new-model", { persist: true });
    expect(state.getMessages().find((m) => m.id === placeholderId)?.status)
      .toBe("interrupted");
    expect(obsidianMocks.Notice).not.toHaveBeenCalled();
  });
});
