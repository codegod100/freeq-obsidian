import {
  Plugin,
  WorkspaceLeaf,
  Notice,
  requestUrl,
} from "obsidian";
import { FreeQSettingTab, DEFAULT_SETTINGS, type FreeQSettings } from "./settings";
import { IRCClient } from "./irc/client";
import { ChatView, VIEW_TYPE_FREEQ } from "./ui/ChatView";
import { Clipper } from "./clip/clipper";
import { OAuthHandler, type OAuthSession } from "./auth/oauth";
import { JoinChannelModal } from "./ui/JoinChannelModal";

export default class FreeQPlugin extends Plugin {
  settings: FreeQSettings;
  client: IRCClient;
  clipper: Clipper;
  oauth: OAuthHandler;

  async onload() {
    await this.loadSettings();
    this.client = new IRCClient();
    this.clipper = new Clipper(this.app, this.settings);
    this.oauth = new OAuthHandler();

    this.registerView(VIEW_TYPE_FREEQ, (leaf) => new ChatView(leaf, this));

    // Catch obsidian://freeq-chat?oauth=... callbacks
    this.registerObsidianProtocolHandler("freeq-chat", (params) => {
      try {
        const urlParams = new URLSearchParams();
        for (const [key, value] of Object.entries(params)) {
          if (value) urlParams.set(key, String(value));
        }
        const session = this.oauth.handleCallback(urlParams);
        if (session) {
          this.settings.oauthSession = session;
          this.settings.did = session.did;
          this.saveSettings();
          new Notice("Authentication completed! Connecting…");
          // Auto-connect using the fresh session
          this.connect();
        }
      } catch (error) {
        console.error("[freeq] protocol handler error:", error);
        new Notice("Authentication error.");
      }
    });

    this.addRibbonIcon("message-circle", "Open FreeQ Chat", () => {
      this.activateView();
    });

    this.addCommand({
      id: "open-freeq-chat",
      name: "Open chat sidebar",
      callback: () => this.activateView(),
    });

    this.addCommand({
      id: "freeq-connect",
      name: "Connect to server",
      callback: () => this.connect(),
    });

    this.addCommand({
      id: "freeq-disconnect",
      name: "Disconnect from server",
      callback: () => this.disconnect(),
    });

    this.addCommand({
      id: "freeq-join-channel",
      name: "Join channel",
      callback: () => {
        if (!this.client.isConnected()) {
          new Notice("Not connected to server.");
          return;
        }
        new JoinChannelModal(this.app, (channel) => {
          this.client.join(channel);
        }).open();
      },
    });

    this.addCommand({
      id: "freeq-send-message",
      name: "Send message to active channel",
      callback: () => {
        const text = prompt("Message:");
        if (text?.trim()) {
          const target = this.client.activeChannel;
          if (target) {
            this.client.sendPrivmsg(target, text.trim());
          } else {
            new Notice("No active channel.");
          }
        }
      },
    });

    this.addSettingTab(new FreeQSettingTab(this.app, this));

    // Auto-connect on load if we have an OAuth session
    if (this.settings.oauthSession) {
      setTimeout(() => this.connect(), 1500);
    }
  }

  onunload() {
    this.disconnect();
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
    this.clipper = new Clipper(this.app, this.settings);
  }

  // ── OAuth ──

  async initiateOAuth(handle: string): Promise<void> {
    const session = await this.oauth.initiate(
      handle,
      this.settings.brokerUrl,
      this.settings.callbackUrl
    );
    this.settings.oauthSession = session;
    this.settings.did = session.did;
    await this.saveSettings();
  }

  // ── Connection ──

  async connect() {
    const { serverUrl, nick, oauthSession, did, appPassword, pdsUrl, brokerUrl } = this.settings;
    if (!serverUrl) {
      new Notice("FreeQ server URL is not configured.");
      return;
    }

    let token = "";
    let method = "";
    let effectiveDid = did;

    // Try OAuth session first
    if (oauthSession) {
      // Refresh web token via broker if the stored one might be stale
      try {
        const refreshed = await this.refreshBrokerToken(oauthSession.brokerToken);
        if (refreshed) {
          token = refreshed.token;
          method = "web-token";
          effectiveDid = refreshed.did;
          // Update stored session
          const sess = this.settings.oauthSession;
          if (sess) {
            sess.webToken = refreshed.token;
            sess.nick = refreshed.nick;
            await this.saveSettings();
          }
        } else {
          token = oauthSession.webToken;
          method = "web-token";
        }
      } catch (e) {
        console.warn("[freeq] broker refresh failed, using stored token:", e);
        token = oauthSession.webToken;
        method = "web-token";
      }
    }
    // Fallback to app password
    else if (did && appPassword) {
      try {
        const session = await this.createPdsSession(did, appPassword, pdsUrl);
        if (!session) {
          new Notice("Failed to authenticate with PDS. Check your credentials.");
          return;
        }
        token = session.accessJwt;
        method = "pds-session";
      } catch (e) {
        console.error("[freeq] PDS auth error:", e);
        new Notice("PDS authentication failed.");
        return;
      }
    }

    const desiredNick =
      nick || oauthSession?.nick || did?.split(":").pop()?.slice(0, 15) || "guest";

    if (!token) {
      new Notice(
        "Connecting as guest — configure OAuth or App Password in settings to authenticate."
      );
    }

    this.client.connect(serverUrl, desiredNick, token, effectiveDid, method);
    new Notice("Connecting to FreeQ…");
  }

  disconnect() {
    this.client.disconnect();
    new Notice("Disconnected from FreeQ.");
  }

  async activateView() {
    const { workspace } = this.app;
    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_FREEQ);

    if (leaves.length > 0) {
      leaf = leaves[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      await leaf?.setViewState({ type: VIEW_TYPE_FREEQ, active: true });
    }

    if (leaf) {
      workspace.revealLeaf(leaf);
    }
  }

  // ── Broker token refresh ──

  private async refreshBrokerToken(
    brokerToken: string
  ): Promise<{ token: string; nick: string; did: string; handle: string } | null> {
    const brokerBody = JSON.stringify({ broker_token: brokerToken });
    const url = this.settings.brokerUrl.replace(/\/$/, "") + "/session";

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await requestUrl({
          url,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: brokerBody,
        });
        return res.json as { token: string; nick: string; did: string; handle: string };
      } catch (e: any) {
        const status = e?.status ?? 0;
        if (status === 401) {
          this.settings.oauthSession = undefined;
          await this.saveSettings();
          throw new Error("Broker token expired. Please log in again.");
        }
        if (status === 502 && attempt < 2) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        throw e;
      }
    }
    return null;
  }

  // ── PDS Session (app-password fallback) ──

  private async createPdsSession(
    didOrHandle: string,
    appPassword: string,
    pdsUrl: string
  ): Promise<{ accessJwt: string } | null> {
    let did = didOrHandle;
    if (!didOrHandle.startsWith("did:")) {
      const resolved = await this.resolveHandle(didOrHandle);
      if (!resolved) return null;
      did = resolved;
    }

    let endpoint = pdsUrl;
    if (!endpoint || endpoint === "https://bsky.social") {
      const doc = await this.fetchDidDocument(did);
      if (doc?.service?.[0]?.serviceEndpoint) {
        endpoint = doc.service[0].serviceEndpoint;
      }
    }

    const url = endpoint.replace(/\/$/, "") + "/xrpc/com.atproto.server.createSession";
    try {
      const resp = await requestUrl({
        url,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ identifier: did, password: appPassword }),
      });
      if (resp.status >= 400) {
        console.error("[freeq] createSession failed:", resp.text);
        return null;
      }
      const data = resp.json;
      if (!data.accessJwt) return null;
      return { accessJwt: data.accessJwt as string };
    } catch (e) {
      console.error("[freeq] createSession network error:", e);
      return null;
    }
  }

  private async resolveHandle(handle: string): Promise<string | null> {
    try {
      const resp = await requestUrl(
        `https://plc.directory/resolveHandle?handle=${encodeURIComponent(handle)}`
      );
      if (resp.status >= 400) return null;
      return resp.json?.did || null;
    } catch {
      return null;
    }
  }

  private async fetchDidDocument(did: string): Promise<any | null> {
    try {
      const url = did.startsWith("did:plc:")
        ? `https://plc.directory/${did}`
        : did.startsWith("did:web:")
        ? `https://${did.slice(8)}/.well-known/did.json`
        : null;
      if (!url) return null;
      const resp = await requestUrl(url);
      if (resp.status >= 400) return null;
      return resp.json;
    } catch {
      return null;
    }
  }
}
