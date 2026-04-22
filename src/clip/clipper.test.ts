import { describe, it, expect, vi, beforeEach } from "vitest";
import { Clipper } from "./clipper";
import { DEFAULT_SETTINGS } from "../settings";
import { TFile } from "obsidian";

function makeMockApp(overrides: any = {}) {
  const files: Record<string, any> = {};
  return {
    vault: {
      getAbstractFileByPath: vi.fn((path: string) => files[path] || null),
      createFolder: vi.fn(async () => {}),
      create: vi.fn(async (path: string, data: string) => {
        const file = new TFile(path);
        (file as any).data = data;
        files[path] = file;
        return file;
      }),
      append: vi.fn(async () => {}),
    },
    internal: {
      plugins: {
        plugins: {} as any,
      },
    },
    ...overrides,
  };
}

function makeMessage(overrides: any = {}) {
  return {
    id: "msg123",
    text: "Hello world",
    from: "alice",
    timestamp: "2024-01-15T12:30:00.000Z",
    ...overrides,
  };
}

describe("Clipper", () => {
  let app: any;

  beforeEach(() => {
    app = makeMockApp();
  });

  it("replaces all template variables", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      useDailyNote: true,
      clipTemplate: DEFAULT_SETTINGS.clipTemplate + "\n> {{url}}",
    };
    const clipper = new Clipper(app, settings);
    const result = await clipper.clip({
      channel: "#general",
      msg: makeMessage(),
    });

    expect(result).not.toBeNull();
    // Falls through to create() because no daily note exists
    const created = app.vault.create.mock.calls[0];
    expect(created).toBeDefined();
    const written = created?.[1] || "";
    expect(written).toContain("Hello world");
    expect(written).toContain("alice");
    expect(written).toContain("#general");
    expect(written).toContain("2024-01-15");
    expect(written).toContain("msg123");
    expect(written).toContain(
      "https://irc.freeq.at/channel/%23general/msg/msg123"
    );
  });

  it("appends to daily note (fallback) when no daily-notes plugin", async () => {
    const settings = { ...DEFAULT_SETTINGS, useDailyNote: true };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general", msg: makeMessage() });

    const createdCall = app.vault.create.mock.calls.find((c: any[]) =>
      c[0].endsWith(".md")
    );
    expect(createdCall).toBeDefined();
  });

  it("appends to existing daily note instead of creating", async () => {
    const todayStr = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const existingFile = new TFile(`${todayStr}.md`);
    app.vault.getAbstractFileByPath = vi.fn((path: string) =>
      path === `${todayStr}.md` ? existingFile : null
    );

    const settings = { ...DEFAULT_SETTINGS, useDailyNote: true };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general", msg: makeMessage() });

    expect(app.vault.append).toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("uses daily-notes plugin if available", async () => {
    const dailyFile = new TFile("Daily Notes/2024-01-15.md");
    app.internal.plugins.plugins["daily-notes"] = {
      instance: {
        openOrCreate: vi.fn(async () => dailyFile),
      },
    };

    const settings = { ...DEFAULT_SETTINGS, useDailyNote: true };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general", msg: makeMessage() });

    expect(app.internal.plugins.plugins["daily-notes"].instance.openOrCreate).toHaveBeenCalled();
    expect(app.vault.append).toHaveBeenCalledWith(dailyFile, expect.stringContaining("Hello world"));
  });

  it("writes to folder note when useDailyNote is false", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      useDailyNote: false,
      clipFolder: "FreeQ Clippings",
    };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general", msg: makeMessage() });

    expect(app.vault.create).toHaveBeenCalledWith(
      "FreeQ Clippings/2024-01-15 _general.md",
      expect.stringContaining("# #general")
    );
  });

  it("sanitizes channel name in filename", async () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      useDailyNote: false,
      clipFolder: "FreeQ Clippings",
    };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general.chat", msg: makeMessage() });

    expect(app.vault.create).toHaveBeenCalledWith(
      "FreeQ Clippings/2024-01-15 _general_chat.md",
      expect.any(String)
    );
  });

  it("appends to existing folder note instead of creating", async () => {
    const existingFile = new TFile("FreeQ Clippings/2024-01-15 _general.md");
    app.vault.getAbstractFileByPath = vi.fn((path: string) =>
      path === "FreeQ Clippings/2024-01-15 _general.md" ? existingFile : null
    );

    const settings = {
      ...DEFAULT_SETTINGS,
      useDailyNote: false,
      clipFolder: "FreeQ Clippings",
    };
    const clipper = new Clipper(app, settings);
    await clipper.clip({ channel: "#general", msg: makeMessage() });

    expect(app.vault.append).toHaveBeenCalled();
    expect(app.vault.create).not.toHaveBeenCalled();
  });

  it("returns null on error", async () => {
    app.vault.create = vi.fn(async () => {
      throw new Error("disk full");
    });
    const settings = { ...DEFAULT_SETTINGS, useDailyNote: true };
    const clipper = new Clipper(app, settings);
    const result = await clipper.clip({
      channel: "#general",
      msg: makeMessage(),
    });
    expect(result).toBeNull();
  });
});
