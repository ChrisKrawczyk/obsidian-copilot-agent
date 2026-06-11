import { Plugin } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./ChatView";
import type { AuthController } from "../auth/AuthController";
import type { ConversationManager } from "../domain/ConversationManager";

interface ChatViewRegistrationDeps {
  /** v0.3 Phase 4: replaces the old single `agent` + `undoJournal`
   *  injection. ChatView reads the active runtime from the manager
   *  and re-binds when the manager emits `active-changed`. */
  manager: ConversationManager;
  auth: AuthController;
  openSettings: () => void;
}

export function registerChatView(
  plugin: Plugin,
  deps: ChatViewRegistrationDeps,
): void {
  plugin.registerView(
    CHAT_VIEW_TYPE,
    (leaf) => new ChatView(leaf, deps),
  );

  plugin.addRibbonIcon("bot", "Open Copilot Agent", () => {
    void activate(plugin);
  });

  plugin.addCommand({
    id: "copilot-agent-open-chat",
    name: "Open chat panel",
    callback: () => {
      void activate(plugin);
    },
  });
}

async function activate(plugin: Plugin): Promise<void> {
  const { workspace } = plugin.app;
  const existing = workspace.getLeavesOfType(CHAT_VIEW_TYPE);
  if (existing.length > 0) {
    workspace.revealLeaf(existing[0]);
    return;
  }
  const leaf = workspace.getRightLeaf(false);
  if (!leaf) return;
  await leaf.setViewState({ type: CHAT_VIEW_TYPE, active: true });
  workspace.revealLeaf(leaf);
}
