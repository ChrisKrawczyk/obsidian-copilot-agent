import { Plugin } from "obsidian";
import { ChatView, CHAT_VIEW_TYPE } from "./ChatView";
import type { AgentSession } from "../sdk/AgentSession";
import type { AuthController } from "../auth/AuthController";
import type { UndoJournal } from "../domain/UndoJournal";

interface ChatViewRegistrationDeps {
  agent: AgentSession;
  auth: AuthController;
  openSettings: () => void;
  undoJournal?: UndoJournal;
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
