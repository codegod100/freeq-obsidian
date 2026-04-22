import { vi } from "vitest";
import FreeQPlugin from "../src/main";
import { DEFAULT_SETTINGS } from "../src/settings";
import { IRCClient } from "../src/irc/client";
import { OAuthHandler } from "../src/auth/oauth";

export function createTestPlugin(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): FreeQPlugin {
  const app = {
    workspace: {
      getLeavesOfType: vi.fn(() => []),
      getRightLeaf: vi.fn(() => null),
      revealLeaf: vi.fn(),
    } as any,
    vault: {
      getAbstractFileByPath: vi.fn(() => null),
      createFolder: vi.fn(async () => {}),
      create: vi.fn(async () => ({})),
      read: vi.fn(async () => ""),
      adapter: { write: vi.fn(async () => {}) },
    } as any,
    fileManager: {
      getNewFileParent: vi.fn(() => ({ path: "/" })),
    } as any,
  };

  const plugin = new FreeQPlugin(app as any, {} as any);
  plugin.settings = { ...DEFAULT_SETTINGS, ...overrides } as any;

  // Manually init fields normally set in onload()
  plugin.client = new IRCClient();
  plugin.clipper = {} as any;
  plugin.oauth = new OAuthHandler();

  return plugin;
}
