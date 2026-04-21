import { App, Notice, PluginSettingTab, Setting } from "obsidian";
import type FreeQPlugin from "./main";

export interface FreeQSettings {
  serverUrl: string;
  brokerUrl: string;
  callbackUrl: string;
  nick: string;
  did: string;
  appPassword: string;
  pdsUrl: string;
  autoJoinChannels: string;
  clipFolder: string;
  clipTemplate: string;
  useDailyNote: boolean;
  dailyNoteFormat: string;
  oauthSession?: {
    did: string;
    handle: string;
    nick: string;
    webToken: string;
    brokerToken: string;
    pdsUrl: string;
    createdAt: number;
  };
}

export const DEFAULT_SETTINGS: FreeQSettings = {
  serverUrl: "wss://irc.freeq.at/irc",
  brokerUrl: "https://auth.freeq.at",
  callbackUrl: "", // User must configure this — see README
  nick: "",
  did: "",
  appPassword: "",
  pdsUrl: "https://bsky.social",
  autoJoinChannels: "#general",
  clipFolder: "FreeQ Clippings",
  clipTemplate:
    `> {{text}}
> — @{{from}} in {{channel}}, {{timestamp}}
> [msgid: {{msgid}}]`,
  useDailyNote: false,
  dailyNoteFormat: "YYYY-MM-DD",
};

export class FreeQSettingTab extends PluginSettingTab {
  plugin: FreeQPlugin;

  constructor(app: App, plugin: FreeQPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // ── Auth Section ──
    containerEl.createEl("h3", { text: "Authentication" });

    if (this.plugin.settings.oauthSession) {
      const displayName = this.plugin.settings.oauthSession.handle || this.plugin.settings.oauthSession.did;
      new Setting(containerEl)
        .setName("Logged in as @" + displayName)
        .setDesc(this.plugin.settings.oauthSession.did)
        .addButton((button) =>
          button
            .setButtonText("Log out")
            .setWarning()
            .onClick(async () => {
              this.plugin.settings.oauthSession = undefined;
              this.plugin.settings.did = "";
              await this.plugin.saveSettings();
              this.display();
              new Notice("Logged out successfully");
            })
        );
    } else {
      // OAuth login
      let handleInput: HTMLInputElement;
      new Setting(containerEl)
        .setName("Log in with AT Protocol")
        .setDesc("Enter your handle (e.g., alice.bsky.social) to authenticate via Bluesky.")
        .addText((text) => {
          handleInput = text.inputEl;
          text.setPlaceholder("alice.bsky.social");
        })
        .addButton((button) =>
          button
            .setButtonText("Log in")
            .setCta()
            .onClick(async () => {
              const handle = handleInput.value.trim();
              if (!handle) {
                new Notice("Please enter a handle.");
                return;
              }
              try {
                button.setDisabled(true);
                button.setButtonText("Logging in…");
                await this.plugin.initiateOAuth(handle);
                this.display();
                new Notice(`Logged in as ${this.plugin.settings.oauthSession?.handle || handle}`);
              } catch (e: any) {
                console.error("[freeq] OAuth login failed:", e);
                new Notice(`Login failed: ${e.message || String(e)}`);
              } finally {
                button.setDisabled(false);
                button.setButtonText("Log in");
              }
            })
        );

      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "A browser window will open to complete authorization. Return to Obsidian when done.",
      });

      // App-password fallback
      containerEl.createEl("h3", { text: "Fallback: App Password" });
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "If OAuth doesn't work for your setup, use an app password instead.",
      });

      new Setting(containerEl)
        .setName("DID or Handle")
        .setDesc("Required for authenticated login.")
        .addText((text) =>
          text
            .setPlaceholder("alice.bsky.social")
            .setValue(this.plugin.settings.did)
            .onChange(async (value) => {
              this.plugin.settings.did = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("App Password")
        .setDesc("An app password from your PDS. Stored locally.")
        .addText((text) => {
          text.inputEl.type = "password";
          text
            .setPlaceholder("xxxx-xxxx-xxxx-xxxx")
            .setValue(this.plugin.settings.appPassword)
            .onChange(async (value) => {
              this.plugin.settings.appPassword = value;
              await this.plugin.saveSettings();
            });
        });
    }

    // ── Server / Identity ──
    containerEl.createEl("h3", { text: "Server & Identity" });

    new Setting(containerEl)
      .setName("Server URL")
      .setDesc("WebSocket URL of the FreeQ IRC server")
      .addText((text) =>
        text
          .setPlaceholder("wss://irc.freeq.at/irc")
          .setValue(this.plugin.settings.serverUrl)
          .onChange(async (value) => {
            this.plugin.settings.serverUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Broker URL")
      .setDesc("FreeQ auth broker (for OAuth and session refresh)")
      .addText((text) =>
        text
          .setPlaceholder("https://auth.freeq.at")
          .setValue(this.plugin.settings.brokerUrl)
          .onChange(async (value) => {
            this.plugin.settings.brokerUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("OAuth callback URL")
      .setDesc("The page that redirects back to Obsidian after browser auth. Host oauth-callback.html from this plugin's directory.")
      .addText((text) =>
        text
          .setPlaceholder("https://yourdomain.com/oauth-callback.html")
          .setValue(this.plugin.settings.callbackUrl)
          .onChange(async (value) => {
            this.plugin.settings.callbackUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Nick override")
      .setDesc("Custom IRC nick. Leave blank to derive from handle.")
      .addText((text) =>
        text
          .setPlaceholder("mynick")
          .setValue(this.plugin.settings.nick)
          .onChange(async (value) => {
            this.plugin.settings.nick = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("PDS URL")
      .setDesc("Your AT Protocol PDS. Only needed for app-password fallback.")
      .addText((text) =>
        text
          .setPlaceholder("https://bsky.social")
          .setValue(this.plugin.settings.pdsUrl)
          .onChange(async (value) => {
            this.plugin.settings.pdsUrl = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Auto-join channels")
      .setDesc("Comma-separated list of channels to join on connect.")
      .addText((text) =>
        text
          .setPlaceholder("#general, #random")
          .setValue(this.plugin.settings.autoJoinChannels)
          .onChange(async (value) => {
            this.plugin.settings.autoJoinChannels = value;
            await this.plugin.saveSettings();
          })
      );

    // ── Clipping ──
    containerEl.createEl("h3", { text: "Clipping" });

    new Setting(containerEl)
      .setName("Use daily note")
      .setDesc("Append clippings to today's daily note instead of a dedicated folder.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.useDailyNote)
          .onChange(async (value) => {
            this.plugin.settings.useDailyNote = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (!this.plugin.settings.useDailyNote) {
      new Setting(containerEl)
        .setName("Clippings folder")
        .setDesc("Folder where clipped messages are saved.")
        .addText((text) =>
          text
            .setPlaceholder("FreeQ Clippings")
            .setValue(this.plugin.settings.clipFolder)
            .onChange(async (value) => {
              this.plugin.settings.clipFolder = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Clip template")
      .setDesc("Available variables: {{text}}, {{from}}, {{channel}}, {{timestamp}}, {{msgid}}, {{url}}")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.clipTemplate)
          .setValue(this.plugin.settings.clipTemplate)
          .onChange(async (value) => {
            this.plugin.settings.clipTemplate = value;
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
      });

    // ── Actions ──
    containerEl.createEl("h3", { text: "Actions" });

    const actionDiv = containerEl.createDiv();
    const connectBtn = actionDiv.createEl("button", { text: "Connect" });
    connectBtn.addClass("mod-cta");
    connectBtn.style.marginRight = "8px";
    connectBtn.addEventListener("click", () => {
      this.plugin.connect();
    });

    const disconnectBtn = actionDiv.createEl("button", { text: "Disconnect" });
    disconnectBtn.addEventListener("click", () => {
      this.plugin.disconnect();
    });
  }
}
