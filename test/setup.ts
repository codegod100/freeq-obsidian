import { vi } from "vitest";
import { MockWebSocket } from "./mocks/websocket";

// Stub window.open globally
vi.stubGlobal("open", vi.fn());

// Directly override global WebSocket with our mock
// nb: must assign static constants so Transport.send() sees WebSocket.OPEN === 1
(globalThis as any).WebSocket = MockWebSocket;
(globalThis as any).WebSocket.CONNECTING = 0;
(globalThis as any).WebSocket.OPEN = 1;
(globalThis as any).WebSocket.CLOSING = 2;
(globalThis as any).WebSocket.CLOSED = 3;

// After each test, clean up
if (typeof document !== "undefined") {
  (globalThis as any).afterEach(() => {
    document.body.innerHTML = "";
    MockWebSocket.reset();
  });
}
