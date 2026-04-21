import { Notice } from "obsidian";

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
    callbackUrl: string
  ): Promise<OAuthSession> {
    // Clear any stale state
    this.cancel();

    const authUrl = `${brokerBase}/auth/login?handle=${encodeURIComponent(
      handle
    )}&return_to=${encodeURIComponent(callbackUrl)}`;

    // Pre-flight broker health check
    try {
      const check = await fetch(`${brokerBase}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      if (!check.ok) {
        throw new Error("Authentication service unavailable.");
      }
    } catch (e: any) {
      if (e?.name === "TimeoutError" || e?.message?.includes("timeout")) {
        throw new Error("Authentication service timed out.");
      }
      throw new Error("Authentication service unreachable.");
    }

    const waitForCallback = new Promise<OAuthSession>((resolve, reject) => {
      this.callbackResolver = resolve;
      this.callbackRejecter = reject;

      // Timeout after 5 minutes
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

  /** Called by registerObsidianProtocolHandler when obsidian://freeq-chat fires. */
  handleCallback(params: URLSearchParams): void {
    const oauthData = params.get("oauth");
    if (!oauthData) {
      this.reject(new Error("Missing OAuth data in protocol callback."));
      return;
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
      } else {
        // No pending login — store for later (e.g., app was closed and reopened)
        console.log("[freeq] OAuth callback received but no pending login.");
      }
    } catch (e) {
      this.reject(
        new Error(
          `Failed to parse OAuth callback: ${e instanceof Error ? e.message : String(e)}`
        )
      );
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
