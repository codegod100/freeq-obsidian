import { Notice, requestUrl } from "obsidian";
import {
  isLocalServerAvailable,
  startLocalOAuthServer,
} from "./local-oauth";

export interface OAuthSession {
  did: string;
  handle: string;
  nick: string;
  webToken: string;
  brokerToken: string;
  pdsUrl: string;
  createdAt: number;
}

export class OAuthHandler {
  private callbackResolver: ((value: OAuthSession) => void) | null = null;
  private callbackRejecter: ((reason?: Error) => void) | null = null;
  private callbackTimeout: ReturnType<typeof setTimeout> | null = null;

  async initiate(
    handle: string,
    brokerBase: string,
    fallbackCallbackUrl?: string
  ): Promise<OAuthSession> {
    this.cancel();

    // Pre-flight broker health check (requestUrl bypasses CORS)
    try {
      const check = await requestUrl(`${brokerBase}/health`);
      if (check.status >= 400) {
        throw new Error("Authentication service unavailable.");
      }
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.message?.includes("timeout")) {
        throw new Error("Authentication service timed out.");
      }
      throw new Error("Authentication service unreachable.");
    }

    // Prefer local ephemeral server (desktop) — no external callback URL needed
    if (isLocalServerAvailable()) {
      try {
        return await this.initiateLocal(handle, brokerBase);
      } catch (e) {
        console.warn("[freeq] local OAuth server failed, falling back:", e);
      }
    }

    // Fallback: external callback URL + obsidian:// protocol handler
    if (!fallbackCallbackUrl) {
      throw new Error(
        "OAuth callback URL is not configured. Set it in FreeQ Chat settings or use App Password."
      );
    }
    return this.initiateExternal(handle, brokerBase, fallbackCallbackUrl);
  }

  private async initiateLocal(
    handle: string,
    brokerBase: string
  ): Promise<OAuthSession> {
    const { url, waitForSession, cleanup } = await startLocalOAuthServer(
      this.decodeSession.bind(this)
    );

    const callbackUrl = `${url}/callback`;
    const authUrl = `${brokerBase}/auth/login?handle=${encodeURIComponent(
      handle
    )}&return_to=${encodeURIComponent(callbackUrl)}`;

    window.open(authUrl, "_blank");
    new Notice("Continue login in your browser…");

    try {
      const session = await waitForSession();
      return session;
    } catch (e) {
      cleanup();
      throw e;
    }
  }

  private async initiateExternal(
    handle: string,
    brokerBase: string,
    callbackUrl: string
  ): Promise<OAuthSession> {
    const authUrl = `${brokerBase}/auth/login?handle=${encodeURIComponent(
      handle
    )}&return_to=${encodeURIComponent(callbackUrl)}`;

    const waitForCallback = new Promise<OAuthSession>((resolve, reject) => {
      this.callbackResolver = resolve;
      this.callbackRejecter = reject;

      this.callbackTimeout = setTimeout(() => {
        if (this.callbackRejecter) {
          this.callbackRejecter(
            new Error("OAuth callback timed out after 5 minutes")
          );
          this.cleanup();
        }
      }, 5 * 60_000);
    });

    window.open(authUrl, "_blank");
    new Notice("Continue login in your browser…");

    return waitForCallback;
  }

  /** Called by registerObsidianProtocolHandler when obsidian://freeq-chat fires.
   *  Returns the decoded session so the caller can persist it even if there is
   *  no pending promise (e.g. app was restarted before the callback arrived).
   */
  handleCallback(params: URLSearchParams): OAuthSession | null {
    const oauthData = params.get("oauth");
    if (!oauthData) {
      this.reject(new Error("Missing OAuth data in protocol callback."));
      return null;
    }

    try {
      const session = this.decodeSession(oauthData);
      if (this.callbackResolver) {
        if (this.callbackTimeout) {
          clearTimeout(this.callbackTimeout);
          this.callbackTimeout = null;
        }
        this.callbackResolver(session);
        this.cleanup();
      }
      return session;
    } catch (e) {
      this.reject(
        new Error(
          `Failed to parse OAuth callback: ${e instanceof Error ? e.message : String(e)}`
        )
      );
      return null;
    }
  }

  private decodeSession(base64urlData: string): OAuthSession {
    // FreeQ uses URL_SAFE_NO_PAD base64
    let base64 = base64urlData.replace(/-/g, "+").replace(/_/g, "/");
    // Add padding if needed
    while (base64.length % 4) {
      base64 += "=";
    }
    const json = atob(base64);
    const data = JSON.parse(json);

    if (!data.did) {
      throw new Error("OAuth response missing DID.");
    }

    return {
      did: data.did as string,
      handle: (data.handle as string) || "",
      nick: (data.nick as string) || "",
      webToken: (data.token as string) || "",
      brokerToken: (data.broker_token as string) || "",
      pdsUrl: (data.pds_url as string) || "",
      createdAt: Date.now(),
    };
  }

  private reject(reason: Error) {
    if (this.callbackRejecter) {
      if (this.callbackTimeout) {
        clearTimeout(this.callbackTimeout);
        this.callbackTimeout = null;
      }
      this.callbackRejecter(reason);
      this.cleanup();
    }
  }

  cancel() {
    if (this.callbackTimeout) {
      clearTimeout(this.callbackTimeout);
      this.callbackTimeout = null;
    }
    if (this.callbackRejecter) {
      this.callbackRejecter(new Error("OAuth flow cancelled."));
    }
    this.cleanup();
  }

  private cleanup() {
    this.callbackResolver = null;
    this.callbackRejecter = null;
    this.callbackTimeout = null;
  }
}
