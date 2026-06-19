export class ItemView {
  app: unknown;
  containerEl = { children: [{}, {}] };

  constructor(leaf: { app?: unknown }) {
    this.app = leaf.app ?? {};
  }

  addChild(): void {}
}

export class Plugin {
  app: unknown = {};
  manifest = { id: "copilot-agent" };
  register(): void {}
  addSettingTab(): void {}
  loadData(): Promise<unknown> { return Promise.resolve(null); }
  saveData(): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  containerEl = makeElement();
  constructor(readonly app: unknown, readonly plugin: unknown) {}
  display(): void {}
  hide(): void {}
}

export class Setting {
  settingEl = makeElement();
  controlEl = makeElement();
  constructor(readonly containerEl: unknown) {}
  setName(): this { return this; }
  setDesc(): this { return this; }
  addToggle(cb: (component: ToggleComponent) => void): this {
    cb(new ToggleComponent());
    return this;
  }
  addDropdown(cb: (component: DropdownComponent) => void): this {
    cb(new DropdownComponent());
    return this;
  }
  addText(cb: (component: TextComponent) => void): this {
    cb(new TextComponent());
    return this;
  }
  addTextArea(cb: (component: TextAreaComponent) => void): this {
    cb(new TextAreaComponent());
    return this;
  }
  addButton(cb: (component: ButtonComponent) => void): this {
    cb(new ButtonComponent());
    return this;
  }
}

class ToggleComponent {
  setValue(): this { return this; }
  onChange(): this { return this; }
}

class DropdownComponent {
  selectEl = { disabled: false };
  addOption(): this { return this; }
  setValue(): this { return this; }
  onChange(): this { return this; }
}

class TextComponent {
  inputEl = { rows: 0, style: {} as Record<string, string> };
  setPlaceholder(): this { return this; }
  setValue(): this { return this; }
  onChange(): this { return this; }
}

class TextAreaComponent extends TextComponent {}

class ButtonComponent {
  setButtonText(): this { return this; }
  setCta(): this { return this; }
  setWarning(): this { return this; }
  onClick(): this { return this; }
}

export class Notice {
  constructor(
    readonly message?: string,
    readonly timeout?: number,
  ) {}
  hide(): void {}
  setMessage(_m: string): void {}
}

export class Modal {
  contentEl = makeElement();
  constructor(readonly app: unknown) {}
  open(): void {}
  close(): void {}
  onOpen(): void {}
  onClose(): void {}
}

export function setIcon(): void {}

export class Menu {
  addItem(): void {}
  showAtPosition(): void {}
}

export class MarkdownView {}

export class FileSystemAdapter {
  getBasePath(): string {
    return "";
  }
}

export type App = unknown;

function makeElement(): { empty: () => void; createEl: () => ReturnType<typeof makeElement>; createDiv: () => ReturnType<typeof makeElement>; setText: () => void; style: Record<string, string> } {
  return {
    style: {},
    empty: () => undefined,
    createEl: () => makeElement(),
    createDiv: () => makeElement(),
    setText: () => undefined,
  };
}
