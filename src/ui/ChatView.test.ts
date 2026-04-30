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

  it("shows the active channel topic in the header and updates it live", async () => {
    const plugin = createTestPlugin();
    plugin.client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);

    plugin.client.join("#general");
    ws.simulateMessage(":testuser!u@h JOIN #general\n");
    ws.simulateMessage(":irc.freeq.at 332 testuser #general :Welcome to #general\n");
    await vi.waitFor(() => expect(plugin.client.channels.get("#general")?.topic).toBe("Welcome to #general"));

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    const statusEl = (view as any).statusEl as HTMLElement;
    expect(statusEl.textContent).toContain("#general");
    expect(statusEl.textContent).toContain("Welcome to #general");

    ws.simulateMessage(":irc.freeq.at 332 testuser #general :New topic text\n");
    await vi.waitFor(() => expect(statusEl.textContent).toContain("New topic text"));
  });

  it("makes the topic editable inline and saves on Enter", async () => {
    const plugin = createTestPlugin();
    plugin.client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);

    plugin.client.join("#general");
    ws.simulateMessage(":testuser!u@h JOIN #general\n");
    ws.simulateMessage(":irc.freeq.at 332 testuser #general :Welcome to #general\n");
    await vi.waitFor(() => expect(plugin.client.channels.get("#general")?.topic).toBe("Welcome to #general"));

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    const statusEl = (view as any).statusEl as HTMLElement;
    const topicEl = statusEl.querySelector(".freeq-topic-text") as HTMLElement;
    expect(topicEl).not.toBeNull();
    topicEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const getInput = () => statusEl.querySelector(".freeq-topic-input") as HTMLInputElement | null;
    await vi.waitFor(() => expect(getInput()).not.toBeNull());
    const input = getInput() as HTMLInputElement;
    input.value = "New topic text";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(ws.send).toHaveBeenCalledWith(expect.stringContaining("TOPIC #general :New topic text\r\n"));
    await vi.waitFor(() => expect(statusEl.textContent).toContain("New topic text"));
  });

  it("cancels inline topic editing on Escape", async () => {
    const plugin = createTestPlugin();
    plugin.client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = MockWebSocket.instances.at(-1)!;
    openAndRegister(ws);

    plugin.client.join("#general");
    ws.simulateMessage(":testuser!u@h JOIN #general\n");
    ws.simulateMessage(":irc.freeq.at 332 testuser #general :Welcome to #general\n");
    await vi.waitFor(() => expect(plugin.client.channels.get("#general")?.topic).toBe("Welcome to #general"));

    const leaf = new WorkspaceLeaf();
    const view = new ChatView(leaf, plugin);
    await view.onOpen();

    const statusEl = (view as any).statusEl as HTMLElement;
    const before = ws.send.mock.calls.length;
    const topicEl = statusEl.querySelector(".freeq-topic-text") as HTMLElement;
    topicEl.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    const getInput = () => statusEl.querySelector(".freeq-topic-input") as HTMLInputElement | null;
    await vi.waitFor(() => expect(getInput()).not.toBeNull());
    const input = getInput() as HTMLInputElement;
    input.value = "Ignored topic";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    await vi.waitFor(() => expect(statusEl.textContent).toContain("Welcome to #general"));
    expect(ws.send.mock.calls.slice(before).some(([data]) => String(data).includes("TOPIC"))).toBe(false);
  });
});
