// v0.4 Phase 4: ModelPicker — DOM module owning the per-conversation
// model dropdown in the chat header.
//
// Pure rendering + event-callback wiring; all catalog/conversation
// state lives in ModelCatalog and ConversationManager. Decisions
// about which rows to show and whether to confirm live in
// `modelPickerLogic.ts` (DOM-free, unit-tested). Keyboard
// accessibility is intentionally delegated to Obsidian's native Menu
// widget because it owns menu focus and key handling once opened.
//
// Lifecycle: the parent (ChatView) constructs a ModelPicker, mounts
// it under the header, and calls `render(viewModel)` whenever the
// catalog state OR the active conversation changes. `destroy()`
// removes listeners + detaches the DOM.

import { Menu, setIcon } from "obsidian";
import type { App } from "obsidian";
import type {
  ModelRow,
  PickerViewModel,
} from "./modelPickerLogic";

export interface ModelPickerCallbacks {
  /**
   * Fired when the user picks a row from the menu. The picker does
   * NOT short-circuit identity swaps — that's the caller's
   * responsibility so the caller can run shared
   * `shouldConfirmSwap` / `setModelId` orchestration in one place.
   */
  onSelect: (newModelId: string) => void;
}

export class ModelPicker {
  private readonly root: HTMLElement;
  private readonly buttonEl: HTMLButtonElement;
  private readonly labelEl: HTMLSpanElement;
  private readonly chevronEl: HTMLSpanElement;
  private currentViewModel: PickerViewModel = { kind: "loading", label: "…" };

  constructor(
    parent: HTMLElement,
    _app: App,
    private readonly callbacks: ModelPickerCallbacks,
  ) {
    this.root = parent.createDiv({ cls: "copilot-agent-model-picker" });
    this.buttonEl = this.root.createEl("button", {
      cls: "copilot-agent-model-picker-button",
      attr: {
        type: "button",
        "aria-haspopup": "menu",
        "aria-label": "Model",
      },
    });
    this.labelEl = this.buttonEl.createSpan({
      cls: "copilot-agent-model-picker-label",
      text: "…",
    });
    this.chevronEl = this.buttonEl.createSpan({
      cls: "copilot-agent-model-picker-chevron",
    });
    setIcon(this.chevronEl, "chevron-down");
    this.buttonEl.addEventListener("click", (e) => this.openMenu(e));
  }

  /** Replace the visible label + cached row list. Cheap to call on
   *  every catalog/conversation event. */
  render(vm: PickerViewModel): void {
    this.currentViewModel = vm;
    switch (vm.kind) {
      case "loading":
        this.labelEl.setText(vm.label);
        this.buttonEl.setAttr("title", "Loading available models…");
        this.buttonEl.disabled = true;
        this.chevronEl.style.display = "none";
        break;
      case "ready":
        this.labelEl.setText(vm.currentLabel ?? "Select a model");
        if (vm.currentLabel) this.buttonEl.setAttr("title", vm.currentLabel);
        else this.buttonEl.removeAttribute("title");
        this.buttonEl.disabled = false;
        this.chevronEl.style.display = "";
        break;
      case "degraded":
        // Phase 4 degraded UX: non-interactive label, no chevron.
        // Phase 5 will replace this with proper error/empty banners.
        this.labelEl.setText(vm.label ?? "—");
        if (vm.label) this.buttonEl.setAttr("title", vm.label);
        else this.buttonEl.removeAttribute("title");
        this.buttonEl.disabled = true;
        this.chevronEl.style.display = "none";
        break;
    }
  }

  /** Tear down DOM + listeners. Called from ChatView.onClose. */
  destroy(): void {
    this.root.detach();
  }

  /** Build and show the Obsidian Menu anchored under the button. We
   *  build it fresh per click so the items reflect the latest catalog
   *  state without an extra layer of event coupling. */
  private openMenu(evt: MouseEvent): void {
    void evt;
    if (this.currentViewModel.kind !== "ready") return;
    const rows = this.currentViewModel.rows;
    if (rows.length === 0) return;
    const menu = new Menu();
    for (const row of rows) {
      menu.addItem((mi) => {
        // `row.label` already includes the "(unavailable)" suffix when
        // applicable (see buildModelPickerViewModel) — no need to
        // append anything here.
        mi.setTitle(row.label);
        mi.setChecked(row.isCurrent);
        if (row.unavailable) {
          // Sentinel row: cannot be re-selected (it's not a real
          // model). Show it as disabled.
          mi.setDisabled(true);
        } else {
          mi.onClick(() => this.callbacks.onSelect(row.id));
        }
      });
    }
    const rect = this.buttonEl.getBoundingClientRect();
    menu.showAtPosition({ x: rect.left, y: rect.bottom });
  }

  /** Test-only probe — returns the currently-rendered view model. */
  getRenderedViewModel(): PickerViewModel {
    return this.currentViewModel;
  }

  /** Test-only probe — returns the row list (or empty if not ready). */
  getRenderedRows(): readonly ModelRow[] {
    return this.currentViewModel.kind === "ready"
      ? this.currentViewModel.rows
      : [];
  }
}
