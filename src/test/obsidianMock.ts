export class ItemView {
  app: unknown;
  containerEl = { children: [{}, {}] };

  constructor(leaf: { app?: unknown }) {
    this.app = leaf.app ?? {};
  }

  addChild(): void {}
}

export class Notice {
  constructor(
    readonly message?: string,
    readonly timeout?: number,
  ) {}
}

export function setIcon(): void {}

export class Menu {
  addItem(): void {}
  showAtPosition(): void {}
}
