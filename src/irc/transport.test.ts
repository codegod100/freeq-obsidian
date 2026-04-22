import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Transport } from "./transport";
import { MockWebSocket } from "../../test/mocks/websocket";

describe("Transport", () => {
  let onLine: ReturnType<typeof vi.fn>;
  let onStateChange: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onLine = vi.fn();
    onStateChange = vi.fn();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    MockWebSocket.reset();
  });

  function createTransport(url = "wss://irc.freeq.at/irc") {
    return new Transport({ url, onLine, onStateChange });
  }

  function getLastWs() {
    const ws = MockWebSocket.instances.at(-1);
    if (!ws) throw new Error("No WebSocket created");
    return ws;
  }

  it("emits connecting then connected on open", () => {
    const t = createTransport();
    t.connect();
    expect(onStateChange).toHaveBeenCalledWith("connecting");

    getLastWs().simulateOpen();
    expect(onStateChange).toHaveBeenCalledWith("connected");
  });

  it("calls onLine for each line received", () => {
    const t = createTransport();
    t.connect();
    getLastWs().simulateOpen();

    getLastWs().simulateMessage("PING :irc.freeq.at\n:server 001 testnick :Welcome\n");
    expect(onLine).toHaveBeenCalledWith("PING :irc.freeq.at");
    expect(onLine).toHaveBeenCalledWith(":server 001 testnick :Welcome");
  });

  it("drops messages when not open", () => {
    const t = createTransport();
    t.connect();
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.send("PRIVMSG #test :hi");
    expect(consoleSpy).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("sends message when open", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    t.send("PRIVMSG #test :hi");
    expect(ws.send).toHaveBeenCalledWith("PRIVMSG #test :hi");
  });

  it("disconnect sets intentionalClose and sends QUIT", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    t.disconnect();
    expect(ws.send).toHaveBeenCalledWith("QUIT :Leaving");
    expect(ws.close).toHaveBeenCalled();
    expect(onStateChange).toHaveBeenLastCalledWith("disconnected");
  });

  it("schedules reconnect on unexpected close", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    ws.simulateClose();
    expect(onStateChange).toHaveBeenCalledWith("disconnected");

    // Should schedule reconnect after delay
    vi.advanceTimersByTime(1100);
    expect(MockWebSocket.instances.length).toBe(2);
  });

  it("does not reconnect after intentional disconnect", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    t.disconnect();
    vi.advanceTimersByTime(10_000);
    expect(MockWebSocket.instances.length).toBe(1);
  });

  it("sends PING after heartbeat interval with no data", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();
    ws.send.mockClear();

    // Heartbeat checks every 15s. At 45s exactly elapsed == PING_INTERVAL, so
    // tick doesn't fire. Need to advance past the next tick (60s).
    vi.advanceTimersByTime(61_000);
    expect(ws.send).toHaveBeenCalledWith("PING :heartbeat");
  });

  it("closes and reconnects when dead timeout exceeded", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    // DEAD_TIMEOUT is 90s. At 90s exactly elapsed == DEAD_TIMEOUT, so need
    // to advance past the next tick (105s).
    vi.advanceTimersByTime(106_000);
    expect(ws.close).toHaveBeenCalled();
  });

  it("closes connection when bufferedAmount is high", () => {
    const t = createTransport();
    t.connect();
    const ws = getLastWs();
    ws.simulateOpen();

    Object.defineProperty(ws, "bufferedAmount", { value: 100_000 });
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    t.send("PRIVMSG #test :hi");
    expect(ws.close).toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("backoff maxes at 30s", () => {
    const t = createTransport();
    t.connect();

    // First failure
    getLastWs().simulateClose();
    vi.advanceTimersByTime(1000);
    getLastWs().simulateClose();

    // Second failure (2s)
    vi.advanceTimersByTime(2000);
    getLastWs().simulateClose();

    // Third failure (4s)
    vi.advanceTimersByTime(4000);
    getLastWs().simulateClose();

    // After many failures, max should cap at 30s
    for (let i = 0; i < 10; i++) {
      getLastWs().simulateClose();
      vi.advanceTimersByTime(30_000);
    }

    // Should still create a new WS after each max delay
    expect(MockWebSocket.instances.length).toBeGreaterThan(5);
  });

  it("resets reconnectAttempts on successful open", () => {
    const t = createTransport();
    t.connect();
    getLastWs().simulateClose();
    vi.advanceTimersByTime(1000);

    // New connection succeeds
    getLastWs().simulateOpen();
    getLastWs().simulateClose();
    // Should start backoff from 1s again, not continue exponential
    vi.advanceTimersByTime(1000);
    expect(MockWebSocket.instances.length).toBe(3);
  });
});
