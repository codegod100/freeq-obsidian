import { ItemView, WorkspaceLeaf, Menu, Notice } from "obsidian";
import type FreeQPlugin from "../main";
import type { ClientEvent, ChatMessage, ChatChannel, ChatMember } from "../irc/client";
import { JoinChannelModal } from "./JoinChannelModal";

export const VIEW_TYPE_FREEQ = "freeq-chat";

export class ChatView extends ItemView {
  private plugin: FreeQPlugin;
  private container!: HTMLElement;
  private channelListEl!: HTMLElement;
  private messageAreaEl!: HTMLElement;
  private inputEl!: HTMLInputElement;
  private statusEl!: HTMLElement;
  private memberListEl!: HTMLElement;
  private toggleMembersBtn!: HTMLElement;
  private showMembers = false;

  constructor(leaf: WorkspaceLeaf, plugin: FreeQPlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return VIEW_TYPE_FREEQ;
  }

  getDisplayText(): string {
    return "FreeQ Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen() {
    this.container = this.containerEl.children[1] as HTMLElement;
    this.container.empty();
    this.container.addClass("freeq-chat-container");

    this.buildLayout();
    this.bindEvents();

    // Catch up state if client is already connected/registered
    if (this.plugin.client.isConnected()) {
      this.catchUpState();
    }
  }

  async onClose() {
    if (this.unsubEvents) {
      this.unsubEvents();
      this.unsubEvents = null;
    }
  }

  // ── Build ──

  private buildLayout() {
    // Header
    const header = this.container.createDiv({ cls: "freeq-header" });
    this.statusEl = header.createDiv({ cls: "freeq-status" });
    this.statusEl.setText("Disconnected");

    const headerActions = header.createDiv({ cls: "freeq-header-actions" });
    this.toggleMembersBtn = headerActions.createEl("button", {
      text: "Members",
      cls: "freeq-btn-small",
    });
    this.toggleMembersBtn.addEventListener("click", () => this.toggleMembers());

    const joinBtn = headerActions.createEl("button", {
      text: "Join",
      cls: "freeq-btn-small",
    });
    joinBtn.addEventListener("click", () => this.promptJoin());

    const connectBtn = headerActions.createEl("button", {
      text: "Connect",
      cls: "freeq-btn-small mod-cta",
    });
    connectBtn.addEventListener("click", () => this.plugin.connect());

    // Main split
    const main = this.container.createDiv({ cls: "freeq-main" });

    // Channel list
    this.channelListEl = main.createDiv({ cls: "freeq-channel-list" });
    this.channelListEl.createDiv({ cls: "freeq-empty", text: "No channels" });

    // Message area wrapper
    const msgWrap = main.createDiv({ cls: "freeq-message-wrap" });

    // Messages
    this.messageAreaEl = msgWrap.createDiv({ cls: "freeq-message-area" });
    this.messageAreaEl.createDiv({
      cls: "freeq-empty freeq-welcome",
      text: "FreeQ Chat\nConnect to start chatting.",
    });

    // Input
    const inputWrap = msgWrap.createDiv({ cls: "freeq-input-wrap" });
    this.inputEl = inputWrap.createEl("input", {
      cls: "freeq-input",
      attr: { placeholder: "Type a message…", disabled: true },
    });
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.sendInput();
      }
    });

    // Member list
    this.memberListEl = main.createDiv({ cls: "freeq-member-list" });
    this.memberListEl.style.display = "none";
  }

  // ── Event binding ──

  private unsubEvents: (() => void) | null = null;

  private bindEvents() {
    const client = this.plugin.client;
    this.unsubEvents = client.addListener((ev) => this.handleEvent(ev));
  }

  // ── Event handling ──

  private handleEvent(ev: ClientEvent) {
    switch (ev.type) {
      case "state":
        this.updateStatus(ev.state);
        break;
      case "registered":
        this.onRegistered(ev.nick);
        break;
      case "authenticated":
        this.statusEl.setText(`Authenticated as ${ev.did.slice(0, 24)}…`);
        break;
      case "authError":
        new Notice(`FreeQ auth error: ${ev.message}`);
        break;
      case "channelUpdated":
        this.renderChannelList();
        if (this.isActiveChannel(ev.channel)) {
          this.renderMessages();
          this.renderMembers();
        }
        break;
      case "message":
        if (this.isActiveChannel(ev.channel)) {
          this.appendMessage(ev.msg);
          this.scrollToBottom();
        }
        break;
      case "serverMessage":
        this.appendMessage(ev.msg);
        this.scrollToBottom();
        break;
      case "memberJoined":
      case "memberParted":
        if (this.isActiveChannel(ev.channel)) {
          this.renderMembers();
        }
        break;
      case "topicChanged":
        if (this.isActiveChannel(ev.channel)) {
          this.renderTopic(ev.topic);
        }
        break;
      case "batchEnd":
        if (
          this.plugin.client.channels.get(
            this.plugin.client.activeChannel.toLowerCase()
          )
        ) {
          this.renderMessages();
        }
        break;
    }
  }

  // ── UI Actions ──

  private updateStatus(state: string) {
    const map: Record<string, string> = {
      disconnected: "Disconnected",
      connecting: "Connecting…",
      connected: "Connected",
    };
    this.statusEl.setText(map[state] || state);
    if (state === "connected") {
      this.statusEl.addClass("freeq-status-connected");
    } else {
      this.statusEl.removeClass("freeq-status-connected");
    }
  }

  private onRegistered(nick: string) {
    this.inputEl.disabled = false;
    this.inputEl.placeholder = `Message as ${nick}…`;
    this.statusEl.setText(`Registered as ${nick}`);
    this.renderChannelList();
    this.renderMessages();
  }

  private catchUpState() {
    const nick = this.plugin.client.currentNick;
    this.inputEl.disabled = false;
    this.inputEl.placeholder = `Message as ${nick}…`;
    this.statusEl.setText(`Registered as ${nick}`);
    this.renderChannelList();
    this.renderMessages();
  }

  private sendInput() {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";

    const target = this.plugin.client.activeChannel;
    if (!target) {
      new Notice("Join a channel first.");
      return;
    }

    if (text.startsWith("/")) {
      this.handleCommand(text.slice(1));
      return;
    }

    this.plugin.client.sendPrivmsg(target, text);
  }

  private handleCommand(cmd: string) {
    const [name, ...rest] = cmd.split(" ");
    const args = rest.join(" ");
    const client = this.plugin.client;

    switch (name.toLowerCase()) {
      case "join":
      case "j":
        if (args) client.join(args.split(" ")[0]);
        break;
      case "part":
      case "leave":
        client.part(args || client.activeChannel);
        break;
      case "quit":
        client.raw("QUIT :Leaving");
        break;
      case "nick":
        if (args) client.raw(`NICK ${args}`);
        break;
      case "msg":
      case "query": {
        const [to, ...msgParts] = args.split(" ");
        if (to && msgParts.length) {
          client.sendPrivmsg(to, msgParts.join(" "));
          client.ensureChannel(to);
          client.activeChannel = to;
          this.renderChannelList();
          this.renderMessages();
        }
        break;
      }
      case "whois":
        if (args) client.whois(args);
        break;
      case "me":
        client.sendAction(client.activeChannel, args);
        break;
      default:
        client.raw(name.toUpperCase() + " " + args);
    }
  }

  private promptJoin() {
    if (!this.plugin.client.isConnected()) {
      new Notice("Not connected to server.");
      return;
    }
    new JoinChannelModal(this.app, (channel) => {
      this.plugin.client.join(channel);
    }).open();
  }

  private toggleMembers() {
    this.showMembers = !this.showMembers;
    this.memberListEl.style.display = this.showMembers ? "block" : "none";
    this.toggleMembersBtn.toggleClass("freeq-btn-active", this.showMembers);
    if (this.showMembers) {
      this.renderMembers();
    }
  }

  // ── Rendering ──

  private isActiveChannel(name: string): boolean {
    return name.toLowerCase() === this.plugin.client.activeChannel.toLowerCase();
  }

  private renderChannelList() {
    this.channelListEl.empty();
    const channels = Array.from(this.plugin.client.channels.values());
    if (!channels.length) {
      this.channelListEl.createDiv({ cls: "freeq-empty", text: "No channels" });
      return;
    }

    for (const ch of channels) {
      const el = this.channelListEl.createDiv({
        cls: "freeq-channel",
        text: ch.name,
      });
      if (this.isActiveChannel(ch.name)) {
        el.addClass("freeq-channel-active");
      }
      if (!ch.isJoined) {
        el.addClass("freeq-channel-parted");
      }
      if (ch.unreadCount > 0 && !this.isActiveChannel(ch.name)) {
        const badge = el.createSpan({ cls: "freeq-unread-badge" });
        badge.setText(String(ch.unreadCount));
      }
      el.addEventListener("click", () => {
        this.plugin.client.activeChannel = ch.name;
        ch.unreadCount = 0;
        this.renderChannelList();
        this.renderMessages();
        this.renderMembers();
        this.renderTopic(ch.topic);
      });
      // Right-click: part channel
      el.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const menu = new Menu();
        if (ch.isJoined) {
          menu.addItem((item) =>
            item.setTitle("Part channel").onClick(() => {
              this.plugin.client.part(ch.name);
            })
          );
        }
        menu.showAtMouseEvent(e);
      });
    }
  }

  private renderMessages() {
    this.messageAreaEl.empty();
    const ch = this.plugin.client.channels.get(
      this.plugin.client.activeChannel.toLowerCase()
    );
    if (!ch) {
      this.messageAreaEl.createDiv({
        cls: "freeq-empty",
        text: "Select or join a channel to start chatting.",
      });
      return;
    }

    for (const msg of ch.messages) {
      this.renderMessage(msg);
    }
    this.scrollToBottom();
  }

  private appendMessage(msg: ChatMessage) {
    this.renderMessage(msg);
  }

  private renderMessage(msg: ChatMessage) {
    const el = this.messageAreaEl.createDiv({ cls: "freeq-message" });
    if (msg.isSystem) el.addClass("freeq-message-system");
    if (msg.isSelf) el.addClass("freeq-message-self");
    if (msg.isAction) el.addClass("freeq-message-action");
    if (msg.deleted) el.addClass("freeq-message-deleted");

    const meta = el.createDiv({ cls: "freeq-message-meta" });
    if (!msg.isSystem && msg.from) {
      const nick = meta.createSpan({ cls: "freeq-message-nick" });
      nick.setText(msg.from);
    }
    const time = meta.createSpan({ cls: "freeq-message-time" });
    time.setText(this.formatTime(msg.timestamp));

    const body = el.createDiv({ cls: "freeq-message-body" });
    if (msg.isAction && msg.from) {
      body.setText(`* ${msg.from} ${msg.text}`);
    } else {
      body.setText(msg.text);
    }

    // Context menu to clip
    el.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.showMessageMenu(e, msg, this.plugin.client.activeChannel);
    });
  }

  private showMessageMenu(
    event: MouseEvent,
    msg: ChatMessage,
    channel: string
  ) {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle("Clip message to vault")
        .setIcon("Pin")
        .onClick(async () => {
          const path = await this.plugin.clipper.clip({ channel, msg });
          if (path) {
            new Notice(`Clipped to ${path}`);
          } else {
            new Notice("Failed to clip message.");
          }
        })
    );
    if (msg.replyTo) {
      menu.addItem((item) =>
        item.setTitle("View thread").onClick(() => {
          // TODO: thread view
        })
      );
    }
    menu.showAtMouseEvent(event);
  }

  private renderMembers() {
    this.memberListEl.empty();
    const ch = this.plugin.client.channels.get(
      this.plugin.client.activeChannel.toLowerCase()
    );
    if (!ch) return;

    const title = this.memberListEl.createDiv({ cls: "freeq-member-title" });
    title.setText(`Members (${ch.members.size})`);

    const list = this.memberListEl.createDiv({ cls: "freeq-member-items" });
    const members = Array.from(ch.members.values()).sort((a, b) =>
      a.nick.localeCompare(b.nick)
    );
    for (const m of members) {
      const el = list.createDiv({ cls: "freeq-member" });
      let prefix = "";
      if (m.isOp) prefix = "@";
      else if (m.isVoiced) prefix = "+";
      el.setText(`${prefix}${m.nick}`);
      if (m.away) el.addClass("freeq-member-away");
    }
  }

  private renderTopic(topic: string) {
    // Could show in a small bar above messages
  }

  private scrollToBottom() {
    this.messageAreaEl.scrollTop = this.messageAreaEl.scrollHeight;
  }

  private formatTime(d: Date): string {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
}
