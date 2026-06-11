// v0.3 Phase 5: ConversationPicker — DOM module owning the picker
// header element. Pure rendering + event-callback wiring; all
// catalog state lives in `ConversationManager`. Decisions about sort
// order / truncation / suffix disambiguation live in
// `conversationPickerLogic.ts` (DOM-free, unit-tested).
//
// Lifecycle: the parent (ChatView) constructs a Picker, mounts it
// under the header, and calls `render(items, activeName)` on every
// manager event (`list-changed`, `active-changed`, `metadata-changed`).
// `destroy()` removes listeners + detaches the DOM.

import { Menu, Notice, setIcon } from "obsidian";
import type { App } from "obsidian";
import type { PickerItem } from "./conversationPickerLogic";

export interface ConversationPickerCallbacks {
  onSelect: (id: string) => void;
  /** Returns the new conversation's id so the parent can immediately
   *  setActive on it. */
  onCreate: () => string | undefined;
  onRename: (id: string, currentName: string) => void;
  onDelete: (id: string, currentName: string) => void;
}

export class ConversationPicker {
  private readonly root: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly chevronEl: HTMLSpanElement;
  private items: readonly PickerItem[] = [];

  constructor(
    parent: HTMLElement,
    _app: App,
    private readonly callbacks: ConversationPickerCallbacks,
  ) {
    this.root = parent.createDiv({ cls: "copilot-agent-conv-picker" });
    this.buttonEl = this.root.createEl("button", {
      cls: "copilot-agent-conv-picker-button",
      attr: { type: "button", "aria-haspopup": "menu" },
    });
    this.labelEl = this.buttonEl.createSpan({
      cls: "copilot-agent-conv-picker-label",
      text: "—",
    });
    this.chevronEl = this.buttonEl.createSpan({
      cls: "copilot-agent-conv-picker-chevron",
    });
    setIcon(this.chevronEl, "chevron-down");
    this.buttonEl.addEventListener("click", (e) => this.openMenu(e));
  }

  /** Replace the visible list + active label. Called from ChatView's
   *  manager-change handler. */
  render(items: readonly PickerItem[], activeName: string | null): void {
    this.items = items;
    if (activeName) {
      this.labelEl.setText(activeName);
      this.buttonEl.setAttr("title", activeName);
    } else {
      this.labelEl.setText("—");
      this.buttonEl.removeAttribute("title");
    }
  }

  /** Tear down DOM + listeners. Called from ChatView.onClose. */
  destroy(): void {
    this.root.detach();
  }

  /** Build and show the Obsidian Menu anchored under the button. We
   *  build it fresh per click so the items reflect the latest manager
   *  state without an extra layer of event coupling. */
  private openMenu(evt: MouseEvent): void {
    const menu = new Menu();
    // Top: switch-to row per conversation.
    for (const item of this.items) {
      menu.addItem((mi) => {
        mi.setTitle(item.label);
        if (item.fullName !== item.label) {
          // Obsidian's Menu doesn't expose tooltips on items, so we
          // surface the full name via setSection (acts like a hint).
          // Best-effort — guard against API changes.
          try {
            (mi as unknown as { setSection?: (s: string) => void })
              .setSection?.(item.fullName);
          } catch {
            // ignore
          }
        }
        mi.setChecked(item.isActive);
        mi.onClick(() => {
          if (!item.isActive) this.callbacks.onSelect(item.id);
        });
      });
    }
    menu.addSeparator();
    menu.addItem((mi) => {
      mi.setTitle("New conversation");
      mi.setIcon("plus");
      mi.onClick(() => {
        const newId = this.callbacks.onCreate();
        if (newId) this.callbacks.onSelect(newId);
      });
    });
    // Per-item rename + delete on the active row only — keeps the
    // top-level menu compact. Right-clicking a row in the future
    // could expose these for any row; for v0.3 picker, focus on
    // active-conversation maintenance.
    const active = this.items.find((i) => i.isActive);
    if (active) {
      menu.addSeparator();
      menu.addItem((mi) => {
        mi.setTitle(`Rename "${active.label}"`);
        mi.setIcon("pencil");
        mi.onClick(() =>
          this.callbacks.onRename(active.id, active.fullName),
        );
      });
      menu.addItem((mi) => {
        mi.setTitle(`Delete "${active.label}"`);
        mi.setIcon("trash");
        mi.onClick(() =>
          this.callbacks.onDelete(active.id, active.fullName),
        );
      });
    }
    // Anchor under the button. `showAtMouseEvent` would jump to the
    // click point; `showAtPosition` keeps it tied to the button so
    // keyboard activation (which has no useful mouse coords) works.
    const rect = this.buttonEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
    void evt;
  }
}

// ---------- Small helpers for ChatView's modal wiring ----------

/**
 * Prompt for a single text input via a transient inline overlay
 * anchored to the picker. Returns the user's value, or `null` on
 * cancel. Kept here so ChatView can stay focused on stream/state
 * concerns and not own yet another DOM helper.
 *
 * Implementation: tiny inline modal-ish prompt using a native
 * `<dialog>` semantics-approximating absolutely-positioned card.
 * For simplicity we use Obsidian's `Notice` + a `prompt()` fallback
 * isn't acceptable (blocking), so we render a small native overlay.
 */
export async function promptForText(
  app: App,
  title: string,
  initial: string,
  placeholder = "",
): Promise<string | null> {
  // Avoid an unused-import for App when this returns trivially.
  void app;
  return new Promise<string | null>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "copilot-agent-prompt-overlay";
    const card = document.createElement("div");
    card.className = "copilot-agent-prompt-card";
    const titleEl = document.createElement("h3");
    titleEl.textContent = title;
    const input = document.createElement("input");
    input.type = "text";
    input.value = initial;
    input.placeholder = placeholder;
    input.className = "copilot-agent-prompt-input";
    const btnRow = document.createElement("div");
    btnRow.className = "copilot-agent-prompt-buttons";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "mod-cta";
    okBtn.textContent = "OK";

    const cleanup = (value: string | null) => {
      overlay.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(value);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup(null);
      if (e.key === "Enter") cleanup(input.value);
    };
    cancelBtn.addEventListener("click", () => cleanup(null));
    okBtn.addEventListener("click", () => cleanup(input.value));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(null);
    });
    overlay.addEventListener("keydown", onKey);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    card.appendChild(titleEl);
    card.appendChild(input);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    input.focus();
    input.select();
  });
}

/** Yes/No confirmation prompt with the same lightweight overlay style. */
export async function confirmDestructive(
  app: App,
  title: string,
  body: string,
  confirmLabel = "Delete",
): Promise<boolean> {
  void app;
  return new Promise<boolean>((resolve) => {
    const overlay = document.createElement("div");
    overlay.className = "copilot-agent-prompt-overlay";
    const card = document.createElement("div");
    card.className = "copilot-agent-prompt-card";
    const titleEl = document.createElement("h3");
    titleEl.textContent = title;
    const bodyEl = document.createElement("p");
    bodyEl.textContent = body;
    const btnRow = document.createElement("div");
    btnRow.className = "copilot-agent-prompt-buttons";
    const cancelBtn = document.createElement("button");
    cancelBtn.type = "button";
    cancelBtn.textContent = "Cancel";
    const okBtn = document.createElement("button");
    okBtn.type = "button";
    okBtn.className = "mod-warning";
    okBtn.textContent = confirmLabel;

    const cleanup = (v: boolean) => {
      overlay.removeEventListener("keydown", onKey);
      overlay.remove();
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cleanup(false);
      if (e.key === "Enter") cleanup(true);
    };
    cancelBtn.addEventListener("click", () => cleanup(false));
    okBtn.addEventListener("click", () => cleanup(true));
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) cleanup(false);
    });
    overlay.addEventListener("keydown", onKey);

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);
    card.appendChild(titleEl);
    card.appendChild(bodyEl);
    card.appendChild(btnRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
    okBtn.focus();
  });
}

// `Notice` re-exported here so ChatView's picker wiring doesn't grow
// another import line just for the soft-cap warning.
export { Notice };
