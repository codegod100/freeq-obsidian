import { describe, it, expect, vi } from "vitest";
import { IRCClient } from "./client";
import { MockWebSocket } from "../../test/mocks/websocket";

describe("IRCClient", () => {
  function createClient() {
    return new IRCClient();
  }

  function getLastWs() {
    const ws = MockWebSocket.instances.at(-1);
    if (!ws) throw new Error("No WebSocket created");
    return ws;
  }

  function receive(ws: MockWebSocket, line: string) {
    ws.simulateMessage(line + "\n");
  }

  it("emits state event on connect", () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);

    client.connect("wss://irc.freeq.at/irc", "testuser");
    getLastWs().simulateOpen();

    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ type: "state", state: "connected" })
    );
  });

  it("emits registered event on 001", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);

    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "state", state: "connected" })
      )
    );

    // Consume CAP / NICK / USER that the client sends on connect
    ws.send.mockClear();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "registered", nick: "testuser" })
      )
    );
  });

  it("isConnected returns false before 001 and true after", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();

    expect(client.isConnected()).toBe(false);

    receive(ws, ":irc.freeq.at 001 testuser :Welcome");

    await vi.waitFor(() => expect(client.isConnected()).toBe(true));
  });

  it("resets state on connect()", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");

    // Ensure channel was added
    client.ensureChannel("#general");
    expect(client.channels.size).toBe(1);

    // Reconnect
    client.connect("wss://irc.freeq.at/irc", "testuser2");
    expect(client.channels.size).toBe(0);
    expect(client.isConnected()).toBe(false);
    expect(client.currentNick).toBe("testuser2");
  });

  it("supports multiple listeners", async () => {
    const client = createClient();
    const a = vi.fn();
    const b = vi.fn();
    client.addListener(a);
    client.addListener(b);

    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");

    await vi.waitFor(() => {
      expect(a).toHaveBeenCalledWith(
        expect.objectContaining({ type: "registered" })
      );
      expect(b).toHaveBeenCalledWith(
        expect.objectContaining({ type: "registered" })
      );
    });
  });

  it("removeListener stops receiving events", () => {
    const client = createClient();
    const listener = vi.fn();
    const remove = client.addListener(listener);

    remove();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    getLastWs().simulateOpen();

    expect(listener).not.toHaveBeenCalled();
  });

  it("join creates channel and sends JOIN command", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();

    client.join("#general");
    expect(ws.send).toHaveBeenCalledWith("JOIN #general\r\n");
    expect(client.channels.has("#general")).toBe(true);
    expect(client.activeChannel).toBe("#general");
  });

  it("channelUpdated event fires when self joins", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);

    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    client.join("#general");

    receive(ws, ":testuser!u@h JOIN #general");

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "channelUpdated",
          channel: "#general",
        })
      )
    );
  });

  it("replies to PING with PONG", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, "PING :irc.freeq.at");
    await vi.waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith("PONG :irc.freeq.at\r\n")
    );
  });

  it("handles CAP LS and requests wanted caps", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, ":irc.freeq.at CAP * LS :sasl echo-message batch");
    await vi.waitFor(() => {
      const reqCall = ws.send.mock.calls.find((c) =>
        String(c[0]).startsWith("CAP REQ")
      );
      expect(reqCall).toBeDefined();
    });
  });

  it("handles CAP ACK and starts SASL when saslToken provided", async () => {
    const client = createClient();
    client.connect(
      "wss://irc.freeq.at/irc",
      "testuser",
      "token",
      "did:plc:abc",
      "pds-session"
    );
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, ":irc.freeq.at CAP testuser ACK :sasl");
    await vi.waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("AUTHENTICATE ATPROTO-CHALLENGE")
      )
    );
  });

  it("completes SASL on AUTHENTICATE + and 900", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect(
      "wss://irc.freeq.at/irc",
      "testuser",
      "tok",
      "did:plc:abc",
      "pds-session"
    );
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, ":irc.freeq.at CAP testuser ACK :sasl");
    receive(ws, "AUTHENTICATE +");

    await vi.waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith(
        expect.stringContaining("AUTHENTICATE")
      )
    );

    receive(ws, ":irc.freeq.at 900 testuser * * :You are now logged in");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "authenticated", did: "did:plc:abc" })
      )
    );
  });

  it("emits authError on 904", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect(
      "wss://irc.freeq.at/irc",
      "testuser",
      "tok",
      "did:plc:abc"
    );
    const ws = getLastWs();
    ws.simulateOpen();

    receive(ws, ":irc.freeq.at CAP testuser ACK :sasl");
    receive(ws, "AUTHENTICATE +");
    receive(ws, ":irc.freeq.at 904 testuser :SASL failed");

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "authError", message: "SASL failed" })
      )
    );
  });

  it("receives PRIVMSG and emits message", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    ws.send.mockClear();
    client.join("#general");
    receive(ws, ":alice!u@h PRIVMSG #general :Hello");

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "message",
          channel: "#general",
          msg: expect.objectContaining({ from: "alice", text: "Hello" }),
        })
      )
    );
  });

  it("receives ACTION PRIVMSG", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h PRIVMSG #general :\x01ACTION waves\x01");

    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "message",
          msg: expect.objectContaining({ text: "waves", isAction: true }),
        })
      )
    );
  });

  it("handles NOTICE as server message when no sender", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();

    receive(ws, "NOTICE testuser :Server notice");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "serverMessage" })
      )
    );
  });

  it("handles PART of another user", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h JOIN #general");
    await vi.waitFor(() => client.channels.has("#general"));

    receive(ws, ":alice!u@h PART #general");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "memberParted", nick: "alice" })
      )
    );
  });

  it("handles QUIT of a member across channels", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h JOIN #general");
    await vi.waitFor(() => client.channels.has("#general"));

    receive(ws, ":alice!u@h QUIT :Bye");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "memberQuit", nick: "alice" })
      )
    );
    expect(client.channels.get("#general")!.members.has("alice")).toBe(false);
  });

  it("handles NICK change of self and others", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h JOIN #general");
    await vi.waitFor(() => client.channels.has("#general"));

    receive(ws, ":alice!u@h NICK :alice2");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "nickChange",
          oldNick: "alice",
          newNick: "alice2",
        })
      )
    );
    expect(client.channels.get("#general")!.members.has("alice2")).toBe(true);
  });

  it("handles TOPIC and 332", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    receive(ws, ":irc.freeq.at 332 testuser #general :Welcome to #general");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "topicChanged",
          channel: "#general",
          topic: "Welcome to #general",
        })
      )
    );
  });

  it("handles MODE changes", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":irc.freeq.at MODE #general +nt");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "modeChanged", channel: "#general" })
      )
    );
  });

  it("handles 353 NAMES reply", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":irc.freeq.at 353 testuser = #general :@op +voice alice");
    await vi.waitFor(() => {
      const ch = client.channels.get("#general")!;
      expect(ch.members.get("op")?.isOp).toBe(true);
      expect(ch.members.get("voice")?.isVoiced).toBe(true);
      expect(ch.members.get("alice")).toBeDefined();
    });
  });

  it("handles KICK", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h JOIN #general");
    await vi.waitFor(() => client.channels.has("#general"));

    receive(ws, ":op!u@h KICK #general alice :spam");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "kicked",
          channel: "#general",
          nick: "alice",
        })
      )
    );
  });

  it("handles AWAY and ACCOUNT updates", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":alice!u@h JOIN #general");
    await vi.waitFor(() => client.channels.has("#general"));

    receive(ws, ":alice!u@h AWAY :Busy");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "awayChanged", nick: "alice" })
      )
    );
    expect(client.channels.get("#general")!.members.get("alice")?.away).toBe(
      "Busy"
    );

    receive(ws, ":alice!u@h ACCOUNT did:plc:alice");
    await vi.waitFor(() =>
      expect(
        client.channels.get("#general")!.members.get("alice")?.did
      ).toBe("did:plc:alice")
    );
  });

  it("handles BATCH chathistory", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, "BATCH +123 chathistory #general");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "batchStart" })
      )
    );

    receive(
      ws,
      "@batch=123 :alice!u@h PRIVMSG #general :history msg"
    );
    receive(ws, "BATCH -123");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "batchEnd" })
      )
    );
  });

  it("limits channel messages to 500", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    for (let i = 0; i < 550; i++) {
      receive(ws, `:bot!u@h PRIVMSG #general :msg${i}`);
    }
    await vi.waitFor(() =>
      expect(client.channels.get("#general")!.messages.length).toBe(500)
    );
  });

  it("handles message edits via +draft/edit tag", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, "@msgid=abc :alice!u@h PRIVMSG #general :Hello");
    await vi.waitFor(() => client.channels.get("#general")!.messages.length > 0);

    receive(ws, "@+draft/edit=abc :alice!u@h PRIVMSG #general :Hello edited");
    await vi.waitFor(() =>
      expect(
        client.channels.get("#general")!.messages[0].text
      ).toBe("Hello edited")
    );
  });

  it("sends local echo when echo-message cap is not acked", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.sendPrivmsg("#general", "hi");
    expect(ws.send).toHaveBeenCalledWith("PRIVMSG #general hi\r\n");
  });

  it("sendPrivmsg with replyTo sends tagged PRIVMSG", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.sendPrivmsg("#general", "hi", "abc123");
    expect(ws.send).toHaveBeenCalledWith("@+reply=abc123 PRIVMSG #general hi\r\n");
  });

  it("sendAction sends CTCP ACTION", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.sendAction("#general", "dances");
    expect(ws.send).toHaveBeenCalledWith(
      expect.stringContaining("ACTION dances")
    );
  });

  it("part sets isJoined false", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.ensureChannel("#general");
    client.part("#general");
    expect(ws.send).toHaveBeenCalledWith("PART #general\r\n");
    expect(client.channels.get("#general")!.isJoined).toBe(false);
  });

  it("requestHistoryLatest sends chathistory command", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.requestHistoryLatest("#general", 20);
    expect(ws.send).toHaveBeenCalledWith(
      "CHATHISTORY LATEST #general * 20\r\n"
    );
  });

  it("whois sends WHOIS command", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    client.whois("alice");
    expect(ws.send).toHaveBeenCalledWith("WHOIS alice\r\n");
  });

  it("skips serverMessage for background WHOIS numerics", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.whois("alice");
    receive(ws, ":irc.freeq.at 318 testuser alice :End of WHOIS");
    await new Promise((r) => setTimeout(r, 10));
    const serverMsgs = listener.mock.calls.filter(
      (c) => c[0].type === "serverMessage"
    );
    expect(serverMsgs.length).toBe(0);
  });

  it("emits serverMessage for unhandled numerics", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    receive(ws, ":irc.freeq.at 252 testuser 5 :operators online");
    await vi.waitFor(() =>
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ type: "serverMessage" })
      )
    );
  });

  it("sends CAP END when no wanted caps available", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, ":irc.freeq.at CAP * LS :unknown-cap");
    await vi.waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith("CAP END\r\n")
    );
  });

  it("sends CAP END on ACK when no saslToken", async () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    receive(ws, ":irc.freeq.at CAP testuser ACK :sasl");
    await vi.waitFor(() =>
      expect(ws.send).toHaveBeenCalledWith("CAP END\r\n")
    );
  });

  it("does not local-echo when echo-message cap is acked", () => {
    const client = createClient();
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    // Simulate CAP ACK for echo-message
    (client as any).ackedCaps.add("echo-message");
    const listener = vi.fn();
    client.addListener(listener);

    client.sendPrivmsg("#general", "hi");
    expect(ws.send).toHaveBeenCalledWith("PRIVMSG #general hi\r\n");
    expect(listener).not.toHaveBeenCalled();
  });

  it("handles PART of self", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":testuser!u@h JOIN #general");
    await vi.waitFor(() => client.channels.get("#general")?.isJoined);

    receive(ws, ":testuser!u@h PART #general");
    await vi.waitFor(() =>
      expect(client.channels.get("#general")!.isJoined).toBe(false)
    );
  });

  it("handles KICK of self", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":testuser!u@h JOIN #general");
    await vi.waitFor(() => client.channels.get("#general")?.isJoined);

    receive(ws, ":op!u@h KICK #general testuser :bye");
    await vi.waitFor(() =>
      expect(client.channels.get("#general")!.isJoined).toBe(false)
    );
  });

  it("handles MODE removal", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    client.join("#general");
    receive(ws, ":irc.freeq.at MODE #general +nt");
    await vi.waitFor(() => listener.mock.calls.length > 0);
    expect(client.channels.get("#general")!.modes.has("t")).toBe(true);

    receive(ws, ":irc.freeq.at MODE #general -t");
    await vi.waitFor(() =>
      expect(client.channels.get("#general")!.modes.has("t")).toBe(false)
    );
  });

  it("ignores BATCH end without matching ref", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.addListener(listener);
    client.connect("wss://irc.freeq.at/irc", "testuser");
    const ws = getLastWs();
    ws.simulateOpen();
    receive(ws, ":irc.freeq.at 001 testuser :Welcome");
    await vi.waitFor(() => expect(client.isConnected()).toBe(true));

    receive(ws, "BATCH -999");
    await new Promise((r) => setTimeout(r, 10));
    const batchEnds = listener.mock.calls.filter(
      (c) => c[0].type === "batchEnd"
    );
    expect(batchEnds.length).toBe(0);
  });
});
