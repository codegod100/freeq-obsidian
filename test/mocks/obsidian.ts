import { vi } from "vitest";

export class Plugin {
  app: any;
  manifest: any;
  settings = {} as any;

  constructor(app: any, manifest: any) {
    this.app = app;
    this.manifest = manifest;
  }

  loadData = vi.fn(async () => ({}));
  saveData = vi.fn(async () => {});
  registerView = vi.fn();
  registerObsidianProtocolHandler = vi.fn();
  addRibbonIcon = vi.fn();
  addCommand = vi.fn();
  addSettingTab = vi.fn();
}

function makeObsidianEl(tag: string): HTMLElement {
  const el = document.createElement(tag);
  (el as any).empty = function () {
    this.innerHTML = "";
  };
  (el as any).addClass = function (...cls: string[]) {
    this.classList.add(...cls);
  };
  (el as any).removeClass = function (...cls: string[]) {
    this.classList.remove(...cls);
  };
  (el as any).hasClass = function (cls: string) {
    return this.classList.contains(cls);
  };
  (el as any).setText = function (text: string) {
    this.textContent = text;
  };
  (el as any).createEl = function (tag: string, attrs?: any) {
    const child = makeObsidianEl(tag);
    if (attrs?.cls) child.className = attrs.cls;
    if (attrs?.text) child.textContent = attrs.text;
    if (attrs?.attr) {
      for (const [k, v] of Object.entries(attrs.attr)) {
        child.setAttribute(k, v as string);
      }
    }
    this.appendChild(child);
    return child;
  };
  (el as any).createDiv = function (attrs?: any) {
    return this.createEl("div", attrs);
  };
  (el as any).createSpan = function (attrs?: any) {
    return this.createEl("span", attrs);
  };
  (el as any).find = function (selector: string) {
    return this.querySelector(selector);
  };
  (el as any).findAll = function (selector: string) {
    return Array.from(this.querySelectorAll(selector));
  };
  return el;
}

export class WorkspaceLeaf {
  view: any = null;
  containerEl: HTMLElement;

  constructor() {
    // Structure expected by ItemView: children[0] = header, children[1] = content
    this.containerEl = makeObsidianEl("div");
    const header = makeObsidianEl("div");
    const content = makeObsidianEl("div");
    this.containerEl.appendChild(header);
    this.containerEl.appendChild(content);
  }

  getViewState = vi.fn(() => ({ type: "freeq-chat" }));
  setViewState = vi.fn(async () => {});
}

export class ItemView {
  containerEl: HTMLElement;
  contentEl: HTMLElement;
  leaf: WorkspaceLeaf;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.containerEl = leaf.containerEl;
    this.contentEl = this.containerEl.children[1] as HTMLElement;
  }

  getViewType() {
    return "freeq-chat";
  }

  getDisplayText() {
    return "FreeQ Chat";
  }

  getIcon() {
    return "message-circle";
  }

  async onOpen() {}
  async onClose() {}
}

export class Modal {
  contentEl = makeObsidianEl("div");
  app: any;

  constructor(app: any) {
    this.app = app;
  }

  open = vi.fn();
  close = vi.fn();
  onOpen() {}
  onClose() {}
}

export class Notice {
  constructor(public message: string) {}
}

export class Menu {
  items: any[] = [];

  addItem(cb: (item: any) => void) {
    const item = {
      setTitle: vi.fn(() => item),
      setIcon: vi.fn(() => item),
      onClick: vi.fn(() => item),
      setSection: vi.fn(() => item),
      setWarning: vi.fn(() => item),
    };
    cb(item);
    this.items.push(item);
    return this;
  }

  showAtMouseEvent = vi.fn();
}

export class Setting {
  nameEl = document.createElement("div");
  descEl = document.createElement("div");
  controlEl = document.createElement("div");

  setName = vi.fn(() => this);
  setDesc = vi.fn(() => this);
  setHeading = vi.fn(() => this);
  addText = vi.fn((cb: any) => {
    const component = {
      inputEl: document.createElement("input"),
      setPlaceholder: vi.fn(() => component),
      setValue: vi.fn(() => component),
      onChange: vi.fn(() => component),
    };
    cb(component);
    return this;
  });
  addTextArea = vi.fn((cb: any) => {
    const component = {
      inputEl: document.createElement("textarea"),
      setPlaceholder: vi.fn(() => component),
      setValue: vi.fn(() => component),
      onChange: vi.fn(() => component),
    };
    cb(component);
    return this;
  });
  addButton = vi.fn((cb: any) => {
    const component = {
      setButtonText: vi.fn(() => component),
      setCta: vi.fn(() => component),
      setWarning: vi.fn(() => component),
      setDisabled: vi.fn(() => component),
      onClick: vi.fn(() => component),
    };
    cb(component);
    return this;
  });
  addToggle = vi.fn((cb: any) => {
    const component = {
      setValue: vi.fn(() => component),
      onChange: vi.fn(() => component),
    };
    cb(component);
    return this;
  });
}

export class PluginSettingTab {
  containerEl = document.createElement("div");

  constructor(public app: any, public plugin: any) {}

  display() {}
}

export class FuzzySuggestModal<T> extends Modal {
  items: T[] = [];
  constructor(app: any) {
    super(app);
  }
  getItems(): T[] {
    return this.items;
  }
  getItemText(item: T): string {
    return String(item);
  }
  onChooseItem(_item: T, _evt: MouseEvent | KeyboardEvent) {}
  open = vi.fn();
}

export function requestUrl(url: string | any) {
  if (typeof url === "string") {
    return Promise.resolve({ status: 200, json: {} });
  }
  return Promise.resolve({ status: 200, json: {} });
}

/* Minimal moment mock: returns an object with format() */
export function moment(input?: string | Date) {
  const d = input ? new Date(input) : new Date();
  return {
    format(fmt: string) {
      const pad = (n: number) => String(n).padStart(2, "0");
      const map: Record<string, string> = {
        YYYY: String(d.getFullYear()),
        MM: pad(d.getMonth() + 1),
        DD: pad(d.getDate()),
        HH: pad(d.getHours()),
        mm: pad(d.getMinutes()),
        ss: pad(d.getSeconds()),
      };
      return fmt.replace(/YYYY|MM|DD|HH|mm|ss/g, (m) => map[m] ?? m);
    },
  };
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class TFile {
  path: string;
  name: string;
  extension: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || "";
    this.extension = this.name.split(".").pop() || "";
  }
}

export class TFolder {
  path: string;
  name: string;
  constructor(path: string) {
    this.path = path;
    this.name = path.split("/").pop() || "";
  }
}
