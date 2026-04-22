import { describe, it, expect, vi, beforeEach } from "vitest";
import { OAuthHandler } from "./oauth";

describe("OAuthHandler", () => {
  let handler: OAuthHandler;

  beforeEach(() => {
    handler = new OAuthHandler();
  });

  describe("decodeSession", () => {
    it("decodes a valid base64url session", () => {
      const payload = {
        did: "did:plc:abc",
        handle: "alice.bsky.social",
        nick: "alice",
        token: "webtok",
        broker_token: "btok",
        pds_url: "https://bsky.social",
      };
      const base64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      const session = (handler as any).decodeSession(base64);
      expect(session.did).toBe("did:plc:abc");
      expect(session.handle).toBe("alice.bsky.social");
      expect(session.nick).toBe("alice");
      expect(session.webToken).toBe("webtok");
      expect(session.brokerToken).toBe("btok");
      expect(session.pdsUrl).toBe("https://bsky.social");
      expect(session.createdAt).toBeTypeOf("number");
    });

    it("throws when DID is missing", () => {
      const payload = { handle: "alice" };
      const base64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      expect(() => (handler as any).decodeSession(base64)).toThrow(
        "OAuth response missing DID."
      );
    });
  });

  describe("handleCallback", () => {
    it("resolves pending external promise with session", async () => {
      const payload = {
        did: "did:plc:abc",
        handle: "alice",
        token: "tok",
        broker_token: "btok",
      };
      const base64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      const initiatePromise = handler.initiateExternal("alice", "https://auth.freeq.at", "https://cb/callback");

      const params = new URLSearchParams();
      params.set("oauth", base64);
      handler.handleCallback(params);

      const session = await initiatePromise;
      expect(session.did).toBe("did:plc:abc");
    });

    it("returns session even without pending promise", () => {
      const payload = { did: "did:plc:abc", token: "tok", broker_token: "btok" };
      const base64 = btoa(JSON.stringify(payload))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=/g, "");

      const params = new URLSearchParams();
      params.set("oauth", base64);
      const session = handler.handleCallback(params);
      expect(session?.did).toBe("did:plc:abc");
    });

    it("rejects when oauth param is missing", async () => {
      const initiatePromise = handler.initiateExternal("alice", "https://auth.freeq.at", "https://cb/callback");

      const params = new URLSearchParams();
      handler.handleCallback(params);

      await expect(initiatePromise).rejects.toThrow("Missing OAuth data");
    });

    it("rejects on invalid base64", async () => {
      const initiatePromise = handler.initiateExternal("alice", "https://auth.freeq.at", "https://cb/callback");

      const params = new URLSearchParams();
      params.set("oauth", "!!!invalid!!!");
      handler.handleCallback(params);

      await expect(initiatePromise).rejects.toThrow("Failed to parse OAuth callback");
    });
  });

  describe("cancel", () => {
    it("rejects pending promise when cancelled", async () => {
      const promise = handler.initiateExternal("alice", "https://auth.freeq.at", "https://cb/callback");
      handler.cancel();
      await expect(promise).rejects.toThrow("cancelled");
    });
  });

  describe("timeout", () => {
    it("rejects external flow after 5 minutes", async () => {
      vi.useFakeTimers();
      const promise = handler.initiateExternal(
        "alice",
        "https://auth.freeq.at",
        "https://cb/callback"
      );
      vi.advanceTimersByTime(5 * 60_000 + 1);
      await expect(promise).rejects.toThrow("timed out");
      vi.useRealTimers();
    });
  });
});
