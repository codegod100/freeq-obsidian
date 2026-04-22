import { describe, it, expect } from "vitest";
import { isLocalServerAvailable, startLocalOAuthServer } from "./local-oauth";

describe("isLocalServerAvailable", () => {
  it("returns true in Node environment", () => {
    expect(isLocalServerAvailable()).toBe(true);
  });
});

describe("startLocalOAuthServer", () => {
  function makeSession(data: string) {
    const payload = { did: "did:plc:abc", token: "tok", broker_token: "btok" };
    const base64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");
    return { did: "did:plc:abc" } as any;
  }

  it("starts a server and returns a URL", async () => {
    const { url, cleanup } = await startLocalOAuthServer(makeSession, 1000);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    cleanup();
  });

  it("times out if no callback received", async () => {
    const { waitForSession, cleanup } = await startLocalOAuthServer(
      makeSession,
      100
    );
    await expect(waitForSession()).rejects.toThrow("timed out");
    cleanup();
  });

  it("resolves session on valid /done request", async () => {
    const payload = { did: "did:plc:abc", token: "tok", broker_token: "btok" };
    const base64 = btoa(JSON.stringify(payload))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=/g, "");

    const decodeSession = () => payload as any;
    const { url, waitForSession, cleanup } = await startLocalOAuthServer(
      decodeSession,
      5000
    );

    // Fire a /done request in the background
    fetch(`${url}/done?oauth=${encodeURIComponent(base64)}`).catch(() => {});

    const session = await waitForSession();
    expect(session.did).toBe("did:plc:abc");
    cleanup();
  });

  it("rejects on /done with missing oauth", async () => {
    const decodeSession = () => ({ did: "x" } as any);
    const { url, waitForSession, cleanup } = await startLocalOAuthServer(
      decodeSession,
      5000
    );

    fetch(`${url}/done`).catch(() => {});

    await expect(waitForSession()).rejects.toThrow("No OAuth data received");
    cleanup();
  });

  it("responds 404 to unknown paths", async () => {
    const { url, cleanup } = await startLocalOAuthServer(makeSession, 100);
    const res = await fetch(`${url}/unknown`);
    expect(res.status).toBe(404);
    cleanup();
  });

  it("responds to OPTIONS with CORS headers", async () => {
    const { url, cleanup } = await startLocalOAuthServer(makeSession, 100);
    const res = await fetch(`${url}/callback`, { method: "OPTIONS" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    cleanup();
  });
});
