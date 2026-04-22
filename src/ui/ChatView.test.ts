import { describe, it, expect, vi } from "vitest";
import { ChatView } from "./ChatView";
import { createTestPlugin } from "../../test/helpers";
import { WorkspaceLeaf } from "obsidian";
import { MockWebSocket } from "../../test/mocks/websocket";

describe("ChatView", () => {
  function openAndRegister(ws: MockWebSocket) {
    ws.simulateOpen();
    ws.send.mockClear();
    ws.simulateMessage(":irc.freeq.at 001 testuser :Welcome\n");
  }

  it("shows auto-joined channels when ChatView opens after registration", async () => {
    const plugin = createTestPlugin({
      serverUrl: "wss://irc.freeq.at/irc",
      autoJoinChannels: "#general,#random",
      oauthSession: {
        brokerToken: "btok",
        webToken: "wtok",
        did: "did:plc:abc",
        handle: "test.bsky.social",
        nick: "testuser",
        pdsUrl: "https://bsky.social",
        createdAt: Date.now(),
      },
    });

    await plugin.connect();
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);
    await vi.waitFor(() => expect(plugin.client.isConnected()).toBe(true));

    ws.simulateMessage(":testuser!u@h JOIN #general\n");
    ws.simulateMessage(":testuser!u@h JOIN #random\n");
    await vi.waitFor(() => expect(plugin.client.channels.has("#general")).toBe(true));

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    const container = (view as any).container;
    const channelEls = container.querySelectorAll(".freeq-channel");
    expect(channelEls.length).toBe(2);
    expect(channelEls[0].textContent).toContain("#general");
    expect(channelEls[1].textContent).toContain("#random");
  });

  it("catchUpState enables input and shows status when already connected", async () => {
    const plugin = createTestPlugin({
      oauthSession: { nick: "testuser" } as any,
    });
    plugin.client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);

    await vi.waitFor(() => expect(plugin.client.isConnected()).toBe(true));

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    expect((view as any).inputEl.disabled).toBe(false);
    expect((view as any).statusEl.textContent).toContain("Registered");
    expect((view as any).inputEl.placeholder).toContain("testuser");
  });

  it("onClose removes event listeners", async () => {
    const plugin = createTestPlugin();
    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();
    expect((plugin.client as any).listeners.length).toBe(1);

    await view.onClose();
    expect((plugin.client as any).listeners.length).toBe(0);

    await view.onOpen();
    expect((plugin.client as any).listeners.length).toBe(1);
  });

  it("renders messages for the active channel after catch-up", async () => {
    const plugin = createTestPlugin();
    plugin.client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);

    plugin.client.join("#general");
    ws.simulateMessage(":testuser!u@h JOIN #general\n");
    await vi.waitFor(() => expect(plugin.client.channels.has("#general")).toBe(true));

    plugin.client.activeChannel = "#general";

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    const container = (view as any).container;
    const activeChannel = container.querySelector(".freeq-channel-active");
    expect(activeChannel).not.toBeNull();
    expect(activeChannel!.textContent).toContain("#general");
  });
});
