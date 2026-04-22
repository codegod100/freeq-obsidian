import { describe, it, expect, vi } from "vitest";
import { createTestPlugin } from "../test/helpers";
import { MockWebSocket } from "../test/mocks/websocket";

describe("FreeQPlugin connect flow", () => {
  it("auto-joins channels on registered even without ChatView", async () => {
    const plugin = createTestPlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      autoJoinChannels: "#general,#test",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "test.bsky.social",
        nick: "testnick",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    const joinSpy = vi.spyOn(plugin.client, "join");

    await plugin.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.simulateOpen();
    ws.simulateMessage(":irc.freeq.at 001 testnick :Welcome\n");

    await vi.waitFor(() => expect(plugin.client.isConnected()).toBe(true));

    expect(joinSpy).toHaveBeenCalledWith("#general");
    expect(joinSpy).toHaveBeenCalledWith("#test");
  });

  it("falls back to stored webToken when broker refresh fails", async () => {
    const plugin = createTestPlugin({
      oauthSession: {
        brokerToken: "expired",
        webToken: "fallback-token",
        did: "did:plc:abc",
        handle: "test.bsky.social",
        nick: "testnick",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    vi.spyOn(plugin as any, "refreshBrokerToken").mockRejectedValue(new Error("502"));

    const connectSpy = vi.spyOn(plugin.client, "connect");

    await plugin.connect();
    await vi.waitFor(() => expect(connectSpy).toHaveBeenCalled());

    const [, , tokenArg] = connectSpy.mock.calls[0];
    expect(tokenArg).toBe("fallback-token");
  });

  it("sets activeChannel to first auto-join channel", async () => {
    const plugin = createTestPlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      autoJoinChannels: "#general,#random",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "test.bsky.social",
        nick: "testnick",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    await plugin.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    ws.simulateOpen();
    ws.simulateMessage(":irc.freeq.at 001 testnick :Welcome\n");

    await vi.waitFor(() => expect(plugin.client.isConnected()).toBe(true));
    // client.join() sets activeChannel to the last joined channel
    expect(plugin.client.activeChannel).toBe("#random");
  });
});
