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

/** Search result shape returned by prepareSimpleSearch / prepareFuzzySearch. */
export interface SearchResult {
  score: number;
  matches: Array<[number, number]>;
}

/**
 * Whitespace-AND substring matcher, mirroring Obsidian's public
 * `prepareSimpleSearch(query)` semantics closely enough for unit
 * tests. Score is a simple sum favouring earlier / more-complete
 * matches; tests assert ordering, not absolute values.
 */
export function prepareSimpleSearch(
  query: string,
): (text: string) => SearchResult | null {
  const tokens = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  return (text: string) => {
    if (tokens.length === 0) return null;
    const haystack = text.toLowerCase();
    const matches: Array<[number, number]> = [];
    let score = 0;
    for (const tok of tokens) {
      const idx = haystack.indexOf(tok);
      if (idx < 0) return null;
      matches.push([idx, idx + tok.length]);
      score += tok.length - idx / (haystack.length + 1);
    }
    return { score, matches };
  };
}

/**
 * Ordered-subsequence matcher, mirroring Obsidian's public
 * `prepareFuzzySearch(query)` semantics closely enough for unit
 * tests. Non-null iff every char of `query` appears in `text` in
 * order (case-insensitive).
 */
export function prepareFuzzySearch(
  query: string,
): (text: string) => SearchResult | null {
  const q = query.toLowerCase();
  return (text: string) => {
    if (q.length === 0) return null;
    const t = text.toLowerCase();
    const matches: Array<[number, number]> = [];
    let ti = 0;
    let score = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const ch = q[qi];
      let found = -1;
      while (ti < t.length) {
        if (t[ti] === ch) {
          found = ti;
          break;
        }
        ti++;
      }
      if (found < 0) return null;
      // Extend the previous span if contiguous, else start a new one.
      if (matches.length > 0 && matches[matches.length - 1][1] === found) {
        matches[matches.length - 1][1] = found + 1;
      } else {
        matches.push([found, found + 1]);
      }
      score += q.length - qi;
      ti = found + 1;
    }
    return { score, matches };
  };
}

function makeElement(): { empty: () => void; createEl: () => ReturnType<typeof makeElement>; createDiv: () => ReturnType<typeof makeElement>; setText: () => void; style: Record<string, string> } {
  return {
    style: {},
    empty: () => undefined,
    createEl: () => makeElement(),
    createDiv: () => makeElement(),
    setText: () => undefined,
  };
}
