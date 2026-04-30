import { describe, expect, it, vi, beforeEach } from "vitest";

const blobMocks = vi.hoisted(() => ({
  uploadBlobViaFreeQ: vi.fn(),
}));

vi.mock("./pds/blob", () => ({
  BlobUploadError: class BlobUploadError extends Error {
    status: number;
    body: unknown;

    constructor(status: number, body: unknown) {
      super(typeof body === "string" ? body : "Upload failed");
      this.name = "BlobUploadError";
      this.status = status;
      this.body = body;
    }
  },
  uploadBlobViaFreeQ: blobMocks.uploadBlobViaFreeQ,
}));

import FreeQPlugin from "./main";
import { DEFAULT_SETTINGS } from "./settings";
import { IRCClient } from "./irc/client";
import { OAuthHandler } from "./auth/oauth";

function makePlugin(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): FreeQPlugin {
  const app = {
    workspace: {
      getLeavesOfType: vi.fn(() => []),
      getRightLeaf: vi.fn(() => null),
      openPopoutLeaf: vi.fn(() => ({ setViewState: vi.fn(async () => {}) })),
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
  plugin.client = new IRCClient();
  plugin.client.onActiveChannelChange = null;
  plugin.oauth = new OAuthHandler();
  plugin.clipper = {} as any;
  plugin.saveSettings = vi.fn(async () => {});
  return plugin;
}

describe("FreeQPlugin upload auth", () => {
  beforeEach(() => {
    blobMocks.uploadBlobViaFreeQ.mockReset();
  });

  it("uploads without auth token — server uses IRC session", async () => {
    const plugin = makePlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "alice.bsky.social",
        nick: "alice",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    vi.spyOn(plugin.client, "isConnected").mockReturnValue(true);
    blobMocks.uploadBlobViaFreeQ.mockResolvedValue({ cid: "cid123", url: "https://pds.example/blob" });

    const url = await plugin.uploadBlobToPds(
      new Blob(["hello world"], { type: "text/plain" }),
      "hello.txt"
    );

    expect(url).toBe("https://pds.example/blob");
    // No auth token sent — server identifies by IRC session
    expect(blobMocks.uploadBlobViaFreeQ).toHaveBeenCalledWith(
      expect.objectContaining({
        did: "did:plc:abc",
        filename: "hello.txt",
        mimeType: "text/plain",
      })
    );
    // authToken should not be in the call args
    const callArgs = blobMocks.uploadBlobViaFreeQ.mock.calls[0][0] as any;
    expect(callArgs.authToken).toBeFalsy();
  });

  it("auto-reconnects and retries on 401", async () => {
    const plugin = makePlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "alice.bsky.social",
        nick: "alice",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    const isConnectedSpy = vi.spyOn(plugin.client, "isConnected");
    isConnectedSpy.mockReturnValue(true);

    const disconnectSpy = vi.spyOn(plugin.client, "disconnect").mockImplementation(() => {});
    const connectSpy = vi.spyOn(plugin, "connect").mockImplementation(() => {});
    const waitForRegSpy = vi.spyOn(plugin.client, "waitForRegistration").mockResolvedValue("alice");

    const { BlobUploadError: MockBlobUploadError } = await import("./pds/blob");

    // First call: 401. Second call: success.
    blobMocks.uploadBlobViaFreeQ
      .mockRejectedValueOnce(
        new MockBlobUploadError(401, { error: "invalid_token", message: "exp claim timestamp check failed" })
      )
      .mockResolvedValueOnce({ cid: "cid456", url: "https://pds.example/blob2" });

    const url = await plugin.uploadBlobToPds(
      new Blob(["hello"], { type: "text/plain" }),
      "test.txt"
    );

    // Should have retried and succeeded
    expect(url).toBe("https://pds.example/blob2");
    expect(disconnectSpy).toHaveBeenCalled();
    expect(connectSpy).toHaveBeenCalled();
    expect(waitForRegSpy).toHaveBeenCalled();
    expect(blobMocks.uploadBlobViaFreeQ).toHaveBeenCalledTimes(2);
    // Session must NOT be cleared
    expect(plugin.settings.oauthSession).toBeDefined();
  });

  it("returns null when retry also fails", async () => {
    const plugin = makePlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "alice.bsky.social",
        nick: "alice",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    vi.spyOn(plugin.client, "isConnected").mockReturnValue(true);
    vi.spyOn(plugin.client, "disconnect").mockImplementation(() => {});
    vi.spyOn(plugin, "connect").mockImplementation(() => {});
    vi.spyOn(plugin.client, "waitForRegistration").mockResolvedValue("alice");

    const { BlobUploadError: MockBlobUploadError } = await import("./pds/blob");

    // Both calls fail with 401
    blobMocks.uploadBlobViaFreeQ
      .mockRejectedValueOnce(
        new MockBlobUploadError(401, { error: "invalid_token", message: "exp claim timestamp check failed" })
      )
      .mockRejectedValueOnce(
        new MockBlobUploadError(401, { error: "invalid_token", message: "still expired" })
      );

    const url = await plugin.uploadBlobToPds(
      new Blob(["hello"], { type: "text/plain" }),
      "test.txt"
    );

    expect(url).toBeNull();
    expect(blobMocks.uploadBlobViaFreeQ).toHaveBeenCalledTimes(2);
  });

  it("handles step_up_required error without reconnecting", async () => {
    const plugin = makePlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "alice.bsky.social",
        nick: "alice",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    vi.spyOn(plugin.client, "isConnected").mockReturnValue(true);
    const disconnectSpy = vi.spyOn(plugin.client, "disconnect").mockImplementation(() => {});
    const openExternalSpy = vi.spyOn(plugin as any, "openExternalUrl").mockImplementation(() => {});

    const { BlobUploadError: MockBlobUploadError } = await import("./pds/blob");

    blobMocks.uploadBlobViaFreeQ.mockRejectedValue(
      new MockBlobUploadError(403, {
        error: "step_up_required",
        step_up_url: "/auth/step-up",
        message: "Additional verification required",
      })
    );

    const url = await plugin.uploadBlobToPds(
      new Blob(["hello"], { type: "text/plain" }),
      "test.txt"
    );

    expect(url).toBeNull();
    // Should NOT reconnect for step_up_required
    expect(disconnectSpy).not.toHaveBeenCalled();
    expect(openExternalSpy).toHaveBeenCalled();
  });
});
