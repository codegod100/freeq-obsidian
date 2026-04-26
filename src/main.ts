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
import { uploadBlobViaFreeQ } from "./pds/blob";

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

    this.addCommand({
      id: "freeq-upload-blob",
      name: "Upload note to PDS blob",
      callback: () => this.uploadNoteBlob(),
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

  private isConnecting = false;
  private registrationTimer: ReturnType<typeof setTimeout> | null = null;

  async connect() {
    if (this.isConnecting) {
      new Notice("Connection already in progress.");
      return;
    }
    this.isConnecting = true;

    const { serverUrl, nick, oauthSession, did, appPassword, pdsUrl, brokerUrl } = this.settings;
    if (!serverUrl) {
      this.isConnecting = false;
      new Notice("FreeQ server URL is not configured.");
      return;
    }

    let token = "";
    let method = "";
    let effectiveDid = did;

    // Try OAuth session first — refresh webToken via broker
    if (oauthSession?.brokerToken) {
      try {
        const refreshed = await this.refreshBrokerToken(oauthSession.brokerToken);
        this.settings.oauthSession = {
          ...oauthSession,
          webToken: refreshed.token,
          nick: refreshed.nick,
          did: refreshed.did,
          handle: refreshed.handle,
          createdAt: Date.now(),
        };
        await this.saveSettings();
        token = refreshed.token;
        method = "web-token";
        effectiveDid = refreshed.did;
      } catch (e: any) {
        console.error("[freeq] broker refresh failed:", e);
        // Broker token expired or rejected — auto re-auth
        const handle = oauthSession?.handle;
        if (handle) {
          try {
            new Notice("Session expired — re-authenticating…");
            await this.initiateOAuth(handle);
            const refreshed = await this.refreshBrokerToken(this.settings.oauthSession!.brokerToken);
            this.settings.oauthSession = {
              ...this.settings.oauthSession!,
              webToken: refreshed.token,
              nick: refreshed.nick,
              did: refreshed.did,
              handle: refreshed.handle,
              createdAt: Date.now(),
            };
            await this.saveSettings();
            token = refreshed.token;
            method = "web-token";
            effectiveDid = refreshed.did;
          } catch (reauthErr) {
            this.isConnecting = false;
            console.error("[freeq] re-auth failed:", reauthErr);
            this.settings.oauthSession = undefined;
            await this.saveSettings();
            new Notice("Re-authentication failed. Please log in again.");
            return;
          }
        } else {
          this.isConnecting = false;
          this.settings.oauthSession = undefined;
          await this.saveSettings();
          new Notice("Session expired. Please log in again.");
          return;
        }
      }
    } else if (oauthSession) {
      // Use existing webToken directly (reinstall / dev only)
      token = oauthSession.webToken;
      method = "web-token";
      effectiveDid = oauthSession.did;
    }
    // Fallback to app password
    else if (did && appPassword) {
      try {
        const session = await this.createPdsSession(did, appPassword, pdsUrl);
        if (!session) {
          this.isConnecting = false;
          new Notice("Failed to authenticate with PDS. Check your credentials.");
          return;
        }
        token = session.accessJwt;
        method = "pds-session";
      } catch (e) {
        this.isConnecting = false;
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

    // Clear any stale registration timeout
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }

    // Persistent auto-join listener — survives reconnects
    this.client.addListener((ev) => {
      if (ev.type === "registered" && this.client.isConnected() && this.client.channels.size === 0) {
        this.isConnecting = false;
        if (this.registrationTimer) {
          clearTimeout(this.registrationTimer);
          this.registrationTimer = null;
        }
        const channels = (this.settings.autoJoinChannels || "#general")
          .split(",")
          .map((c) => c.trim())
          .filter(Boolean);
        for (const ch of channels) {
          this.client.join(ch);
        }
        if (channels.length && !this.client.activeChannel) {
          this.client.activeChannel = channels[0];
        }
      }
      if (ev.type === "state") {
        if (ev.state === "connected") {
          this.isConnecting = false;
          // Start registration timeout guard
          if (this.registrationTimer) clearTimeout(this.registrationTimer);
          this.registrationTimer = setTimeout(() => {
            if (!this.client.isConnected()) {
              console.log("[freeq] Registration timeout — 001 never received");
              new Notice("Server connected but never sent registration confirmation. Try reconnecting.");
            }
          }, 15000);
        } else if (ev.state === "disconnected") {
          this.isConnecting = false;
          if (this.registrationTimer) {
            clearTimeout(this.registrationTimer);
            this.registrationTimer = null;
          }
        }
      }
    });

    this.client.connect(serverUrl, desiredNick, token, effectiveDid, method);
    new Notice("Connecting to FreeQ…");
  }

  disconnect() {
    this.isConnecting = false;
    if (this.registrationTimer) {
      clearTimeout(this.registrationTimer);
      this.registrationTimer = null;
    }
    this.client.disconnect();
    new Notice("Disconnected from FreeQ.");
  }

  // ── PDS Blob Upload ──

  async uploadNoteBlob() {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }

    // Need active IRC connection for the server to recognize our session
    if (!this.client.isConnected()) {
      new Notice("Not connected to FreeQ server. Connect first.");
      return;
    }

    // Need OAuth session for DID and to have pushed PDS creds to server
    const did = this.settings.oauthSession?.did || this.settings.did;
    if (!did) {
      new Notice("Not authenticated. Log in via OAuth first.");
      return;
    }

    // Server URL for the upload endpoint (convert wss:// to https://)
    const wsUrl = this.settings.serverUrl;
    if (!wsUrl) {
      new Notice("FreeQ server URL not configured.");
      return;
    }
    const serverUrl = wsUrl.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://").replace(/\/irc$/, "");

    const content = await this.app.vault.read(file);

    try {
      const result = await uploadBlobViaFreeQ({
        serverUrl,
        did,
        content,
        filename: file.name,
      });
      await navigator.clipboard.writeText(result.url);
      new Notice(`Blob URL copied to clipboard`);
    } catch (e: any) {
      console.error("[freeq] blob upload failed:", e);
      new Notice(`Upload failed: ${e.message || String(e)}`);
    }
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
  ): Promise<{ token: string; nick: string; did: string; handle: string }> {
    const brokerBody = JSON.stringify({ broker_token: brokerToken });
    const url = this.settings.brokerUrl.replace(/\/$/, "") + "/session";

    const res = await requestUrl({
      url,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: brokerBody,
    });

    if (res.status >= 400) {
      if (res.status === 401) {
        this.settings.oauthSession = undefined;
        await this.saveSettings();
        throw new Error("Broker token expired. Please log in again.");
      }
      throw new Error(`Broker returned ${res.status}`);
    }

    return res.json as { token: string; nick: string; did: string; handle: string };
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
