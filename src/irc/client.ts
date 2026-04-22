/**
 * Obsidian-adapted IRC client.
 *
 * No React/Zustand dependencies. Emits events via simple callbacks
 * that the ChatView subscribes to.
 */

import { parse, prefixNick, format, type IRCMessage } from "./parser";
import { Transport, type TransportState } from "./transport";

// ── Types ──

export interface ChatMessage {
  id: string;
  from: string;
  text: string;
  timestamp: Date;
  tags: Record<string, string>;
  isSelf?: boolean;
  isSystem?: boolean;
  isAction?: boolean;
  replyTo?: string;
  editOf?: string;
  deleted?: boolean;
  reactions?: Map<string, Set<string>>;
}

export interface ChatMember {
  nick: string;
  did?: string;
  handle?: string;
  isOp: boolean;
  isVoiced: boolean;
  away?: string | null;
}

export interface ChatChannel {
  name: string;
  topic: string;
  topicSetBy?: string;
  members: Map<string, ChatMember>;
  messages: ChatMessage[];
  modes: Set<string>;
  isJoined: boolean;
  unreadCount: number;
}

export type ClientEvent =
  | { type: "state"; state: TransportState }
  | { type: "registered"; nick: string }
  | { type: "authenticated"; did: string }
  | { type: "authError"; message: string }
  | { type: "channelList"; channels: { name: string; topic: string; count: number }[] }
  | { type: "channelUpdated"; channel: string }
  | { type: "message"; channel: string; msg: ChatMessage }
  | { type: "memberJoined"; channel: string; nick: string; member: ChatMember }
  | { type: "memberParted"; channel: string; nick: string }
  | { type: "memberQuit"; nick: string; reason: string }
  | { type: "nickChange"; oldNick: string; newNick: string }
  | { type: "topicChanged"; channel: string; topic: string; setBy?: string }
  | { type: "modeChanged"; channel: string; modes: string[] }
  | { type: "kicked"; channel: string; nick: string; by: string; reason: string }
  | { type: "awayChanged"; nick: string; away: string | null }
  | { type: "batchStart"; ref: string; batchType: string; target: string }
  | { type: "batchEnd"; ref: string }
  | { type: "motd"; line: string }
  | { type: "serverMessage"; msg: ChatMessage }
  | { type: "whois"; info: Record<string, string> };

// ── State ──

export class IRCClient {
  private transport: Transport | null = null;
  private nick = "";
  private desiredNick = "";
  private url = "";
  private ackedCaps = new Set<string>();
  private registered = false;
  private authenticatedDid = "";

  // SASL credentials
  private saslToken = "";
  private saslDid = "";
  private saslMethod = "";

  // Channels
  channels = new Map<string, ChatChannel>();
  activeChannel = "";
  serverMessages: ChatMessage[] = [];

  // Batches (CHATHISTORY)
  private batches = new Map<string, { type: string; target: string; messages: ChatMessage[] }>();

  // Callbacks
  private listeners: ((ev: ClientEvent) => void)[] = [];

  // Pending WHOIS (background)
  private backgroundWhois = new Set<string>();

  // Message ID counter for local echo
  private localIdSeq = 0;

  connect(
    url: string,
    desiredNick: string,
    saslToken?: string,
    saslDid?: string,
    saslMethod?: string
  ) {
    console.log("[irc] connect() called", url, desiredNick, saslMethod);
    this.disconnect();
    this.url = url;
    this.desiredNick = desiredNick;
    this.nick = desiredNick;
    this.saslToken = saslToken || "";
    this.saslDid = saslDid || "";
    this.saslMethod = saslMethod || "";
    this.registered = false;
    this.authenticatedDid = "";
    this.ackedCaps = new Set();
    this.channels.clear();
    this.serverMessages = [];
    this.batches.clear();

    let lineQueue: Promise<void> = Promise.resolve();
    const serializedHandleLine = (line: string) => {
      lineQueue = lineQueue
        .then(() => this.handleLine(line))
        .catch((e) => console.error("[irc] line handler error:", e));
    };

    this.transport = new Transport({
      url,
      onLine: serializedHandleLine,
      onStateChange: (s: TransportState) => {
        this.emit({ type: "state", state: s });
        if (s === "connected") {
          this.sendRegistration();
        }
      },
    });
    this.transport.connect();
  }

  disconnect() {
    this.transport?.disconnect();
    this.transport = null;
  }

  isConnected(): boolean {
    return this.registered && this.transport !== null;
  }

  get currentNick(): string {
    return this.nick;
  }

  addListener(fn: (ev: ClientEvent) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private emit(ev: ClientEvent) {
    if (ev.type !== "message" && ev.type !== "serverMessage") {
      console.log("[irc] emit", ev.type, ev);
    }
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch (e) {
        console.error("[irc] event handler error:", e);
      }
    }
  }

  private sendRegistration() {
    this.ackedCaps = new Set();
    console.log("[irc] sendRegistration", this.desiredNick, "sasl:", this.saslMethod || "none");
    this.raw("CAP LS 302");
    this.raw(`NICK ${this.desiredNick}`);
    this.raw(`USER ${this.desiredNick} 0 * :FreeQ Obsidian`);
  }

  // ── Sending ──

  raw(line: string) {
    console.log("[irc] raw →", line);
    this.transport?.send(line + "\r\n");
  }

  sendPrivmsg(target: string, text: string) {
    this.raw(`PRIVMSG ${target} :${text}`);
    // Local echo if no echo-message
    if (!this.ackedCaps.has("echo-message")) {
      this.addMessage(target, {
        id: this.nextLocalId(),
        from: this.nick,
        text,
        timestamp: new Date(),
        tags: {},
        isSelf: true,
      });
    }
  }

  sendAction(target: string, text: string) {
    this.raw(`PRIVMSG ${target} :\x01ACTION ${text}\x01`);
  }

  join(channel: string) {
    console.log("[irc] join()", channel);
    this.raw(`JOIN ${channel}`);
    this.ensureChannel(channel);
    this.activeChannel = channel;
  }

  part(channel: string) {
    this.raw(`PART ${channel}`);
    const ch = this.channels.get(channel.toLowerCase());
    if (ch) {
      ch.isJoined = false;
      this.emit({ type: "channelUpdated", channel: ch.name });
    }
  }

  requestHistoryLatest(target: string, count = 50) {
    this.raw(`CHATHISTORY LATEST ${target} * ${count}`);
  }

  requestHistoryBefore(target: string, msgid: string, count = 50) {
    this.raw(`CHATHISTORY BEFORE ${target} msgid=${msgid} ${count}`);
  }

  whois(nick: string) {
    this.backgroundWhois.add(nick.toLowerCase());
    this.raw(`WHOIS ${nick}`);
  }

  // ── Helpers ──

  private nextLocalId(): string {
    return `local-${++this.localIdSeq}`;
  }

  ensureChannel(name: string): ChatChannel {
    const key = name.toLowerCase();
    let ch = this.channels.get(key);
    if (!ch) {
      ch = {
        name,
        topic: "",
        members: new Map(),
        messages: [],
        modes: new Set(),
        isJoined: false,
        unreadCount: 0,
      };
      this.channels.set(key, ch);
    }
    return ch;
  }

  private addMessage(target: string, msg: ChatMessage) {
    const ch = this.ensureChannel(target);
    // Simple edit/deduplication
    if (msg.editOf) {
      const existing = ch.messages.find((m) => m.id === msg.editOf);
      if (existing) {
        existing.text = msg.text;
        this.emit({ type: "channelUpdated", channel: ch.name });
        return;
      }
    }
    ch.messages.push(msg);
    if (ch.messages.length > 500) {
      ch.messages.splice(0, ch.messages.length - 500);
    }
    if (ch.name.toLowerCase() !== this.activeChannel.toLowerCase()) {
      ch.unreadCount++;
    }
    this.emit({ type: "message", channel: ch.name, msg });
    this.emit({ type: "channelUpdated", channel: ch.name });
  }

  private addServerMessage(text: string, isSystem = true) {
    const msg: ChatMessage = {
      id: this.nextLocalId(),
      from: "",
      text,
      timestamp: new Date(),
      tags: {},
      isSystem,
    };
    this.serverMessages.push(msg);
    if (this.serverMessages.length > 200) {
      this.serverMessages.shift();
    }
    this.emit({ type: "serverMessage", msg });
  }

  // ── Receiving ──

  private async handleLine(line: string) {
    console.log("[irc] handleLine", line.slice(0, 120));
    const m = parse(line);
    console.log("[irc] parsed cmd=", m.command, "prefix=", m.prefix);

    switch (m.command) {
      case "PING": {
        const payload = m.params[0] || "";
        this.raw(`PONG :${payload}`);
        break;
      }

      case "CAP": {
        const sub = m.params[1]?.toUpperCase();
        if (sub === "LS") {
          const caps = m.params[2] || "";
          const want = [
            "message-tags",
            "server-time",
            "batch",
            "echo-message",
            "away-notify",
            "account-notify",
            "account-tag",
            "extended-join",
            "draft/chathistory",
            "sasl",
          ];
          const available = caps.split(" ").map((c) => c.split("=")[0]);
          const req = want.filter((c) => available.includes(c));
          if (req.length) {
            this.raw(`CAP REQ :${req.join(" ")}`);
          } else {
            this.raw("CAP END");
          }
        } else if (sub === "ACK") {
          const caps = (m.params[2] || "").split(" ");
          for (const c of caps) this.ackedCaps.add(c);
          if (caps.includes("sasl") && this.saslToken) {
            this.startSasl();
          } else {
            this.raw("CAP END");
          }
        }
        break;
      }

      case "AUTHENTICATE": {
        if (m.params[0] === "+") {
          this.sendSaslResponse();
        }
        break;
      }

      case "900":
      case "903": {
        // SASL success
        const did = this.saslDid;
        this.authenticatedDid = did;
        this.emit({ type: "authenticated", did });
        this.addServerMessage(`Authenticated as ${did}`);
        this.raw("CAP END");
        break;
      }

      case "904": {
        const reason = m.params[m.params.length - 1] || "SASL authentication failed";
        this.emit({ type: "authError", message: reason });
        this.addServerMessage(`Auth failed: ${reason}`);
        this.raw("CAP END");
        break;
      }

      case "001":
      case "002":
      case "003":
      case "004": {
        if (!this.registered && m.command === "001") {
          this.registered = true;
          this.nick = m.params[0];
          this.emit({ type: "registered", nick: this.nick });
        }
        break;
      }

      case "005": {
        // ISUPPORT — skip
        break;
      }

      case "375":
      case "372": {
        const text = m.params[1] || "";
        if (m.command === "372") {
          this.emit({ type: "motd", line: text });
        }
        break;
      }

      case "PRIVMSG": {
        const from = prefixNick(m.prefix);
        const target = m.params[0] || "";
        let text = m.params[1] || "";
        const isAction = text.startsWith("\x01ACTION ") && text.endsWith("\x01");
        if (isAction) {
          text = text.slice(8, -1);
        }
        const ts = m.tags["time"]
          ? new Date(m.tags["time"])
          : new Date();
        const msg: ChatMessage = {
          id: m.tags["msgid"] || this.nextLocalId(),
          from,
          text,
          timestamp: ts,
          tags: m.tags,
          isSelf: from.toLowerCase() === this.nick.toLowerCase(),
          isAction,
          replyTo: m.tags["+reply"],
          editOf: m.tags["+draft/edit"],
        };
        const displayTarget =
          target.toLowerCase() === this.nick.toLowerCase() ? from : target;
        this.addMessage(displayTarget, msg);
        break;
      }

      case "NOTICE": {
        const from = prefixNick(m.prefix);
        const target = m.params[0] || "";
        const text = m.params[1] || "";
        if (!from || from.toLowerCase() === this.nick.toLowerCase()) {
          this.addServerMessage(text);
        } else {
          const msg: ChatMessage = {
            id: this.nextLocalId(),
            from,
            text,
            timestamp: new Date(),
            tags: m.tags,
            isSystem: true,
          };
          const displayTarget =
            target.toLowerCase() === this.nick.toLowerCase() ? from : target;
          this.addMessage(displayTarget, msg);
        }
        break;
      }

      case "JOIN": {
        const nick = prefixNick(m.prefix);
        const channel = m.params[0] || "";
        const ch = this.ensureChannel(channel);
        if (nick.toLowerCase() === this.nick.toLowerCase()) {
          ch.isJoined = true;
          ch.messages = []; // clear on self-join to get fresh history
          this.requestHistoryLatest(channel, 50);
        }
        const did = m.tags["account"];
        const member: ChatMember = {
          nick,
          did,
          isOp: false,
          isVoiced: false,
        };
        ch.members.set(nick.toLowerCase(), member);
        this.emit({ type: "memberJoined", channel: ch.name, nick, member });
        this.emit({ type: "channelUpdated", channel: ch.name });
        break;
      }

      case "PART": {
        const nick = prefixNick(m.prefix);
        const channel = m.params[0] || "";
        const ch = this.channels.get(channel.toLowerCase());
        if (ch) {
          ch.members.delete(nick.toLowerCase());
          if (nick.toLowerCase() === this.nick.toLowerCase()) {
            ch.isJoined = false;
          }
          this.emit({ type: "memberParted", channel: ch.name, nick });
          this.emit({ type: "channelUpdated", channel: ch.name });
        }
        break;
      }

      case "QUIT": {
        const nick = prefixNick(m.prefix);
        const reason = m.params[0] || "";
        for (const ch of this.channels.values()) {
          if (ch.members.has(nick.toLowerCase())) {
            ch.members.delete(nick.toLowerCase());
            this.emit({ type: "memberParted", channel: ch.name, nick });
            this.emit({ type: "channelUpdated", channel: ch.name });
          }
        }
        this.emit({ type: "memberQuit", nick, reason });
        break;
      }

      case "NICK": {
        const oldNick = prefixNick(m.prefix);
        const newNick = m.params[0] || "";
        if (oldNick.toLowerCase() === this.nick.toLowerCase()) {
          this.nick = newNick;
        }
        for (const ch of this.channels.values()) {
          const mbr = ch.members.get(oldNick.toLowerCase());
          if (mbr) {
            ch.members.delete(oldNick.toLowerCase());
            mbr.nick = newNick;
            ch.members.set(newNick.toLowerCase(), mbr);
            this.emit({ type: "channelUpdated", channel: ch.name });
          }
        }
        this.emit({ type: "nickChange", oldNick, newNick });
        break;
      }

      case "TOPIC": {
        const channel = m.params[0] || "";
        const topic = m.params[1] || "";
        const ch = this.ensureChannel(channel);
        ch.topic = topic;
        ch.topicSetBy = prefixNick(m.prefix);
        this.emit({ type: "topicChanged", channel: ch.name, topic, setBy: ch.topicSetBy });
        this.emit({ type: "channelUpdated", channel: ch.name });
        break;
      }

      case "332": {
        const channel = m.params[1] || "";
        const topic = m.params[2] || "";
        const ch = this.ensureChannel(channel);
        ch.topic = topic;
        this.emit({ type: "topicChanged", channel: ch.name, topic });
        this.emit({ type: "channelUpdated", channel: ch.name });
        break;
      }

      case "MODE": {
        const target = m.params[0] || "";
        const modes = m.params.slice(1);
        const ch = this.channels.get(target.toLowerCase());
        if (ch) {
          // Simple mode parsing for +nt / -o / +v
          let adding = true;
          for (const token of modes) {
            if (token.startsWith("+")) {
              adding = true;
              for (let i = 1; i < token.length; i++) {
                ch.modes.add(token[i]);
              }
            } else if (token.startsWith("-")) {
              adding = false;
              for (let i = 1; i < token.length; i++) {
                ch.modes.delete(token[i]);
              }
            } else if (token.length === 2 && (token[0] === "+" || token[0] === "-")) {
              const mode = token[1];
              if (adding) ch.modes.add(mode);
              else ch.modes.delete(mode);
            }
          }
          this.emit({ type: "modeChanged", channel: ch.name, modes });
          this.emit({ type: "channelUpdated", channel: ch.name });
        }
        break;
      }

      case "353": {
        // RPL_NAMREPLY
        const channel = m.params[2] || "";
        const names = (m.params[3] || "").split(" ").filter(Boolean);
        const ch = this.ensureChannel(channel);
        for (const name of names) {
          let nick = name;
          let isOp = false;
          let isVoiced = false;
          if (nick.startsWith("@")) {
            isOp = true;
            nick = nick.slice(1);
          } else if (nick.startsWith("+")) {
            isVoiced = true;
            nick = nick.slice(1);
          }
          const existing = ch.members.get(nick.toLowerCase());
          if (!existing) {
            ch.members.set(nick.toLowerCase(), { nick, isOp, isVoiced });
          } else {
            existing.isOp = isOp;
            existing.isVoiced = isVoiced;
          }
        }
        this.emit({ type: "channelUpdated", channel: ch.name });
        break;
      }

      case "366": {
        // End of NAMES
        break;
      }

      case "KICK": {
        const channel = m.params[0] || "";
        const kicked = m.params[1] || "";
        const by = prefixNick(m.prefix);
        const reason = m.params[2] || "";
        const ch = this.channels.get(channel.toLowerCase());
        if (ch) {
          ch.members.delete(kicked.toLowerCase());
          if (kicked.toLowerCase() === this.nick.toLowerCase()) {
            ch.isJoined = false;
          }
          this.emit({ type: "kicked", channel: ch.name, nick: kicked, by, reason });
          this.emit({ type: "channelUpdated", channel: ch.name });
        }
        break;
      }

      case "AWAY": {
        const nick = prefixNick(m.prefix);
        const away = m.params[0] || null;
        for (const ch of this.channels.values()) {
          const mbr = ch.members.get(nick.toLowerCase());
          if (mbr) {
            mbr.away = away;
            this.emit({ type: "channelUpdated", channel: ch.name });
          }
        }
        this.emit({ type: "awayChanged", nick, away });
        break;
      }

      case "ACCOUNT": {
        const nick = prefixNick(m.prefix);
        const did = m.params[0] || "";
        for (const ch of this.channels.values()) {
          const mbr = ch.members.get(nick.toLowerCase());
          if (mbr) {
            mbr.did = did;
            this.emit({ type: "channelUpdated", channel: ch.name });
          }
        }
        break;
      }

      case "BATCH": {
        const batchArg = m.params[0] || "";
        const ref = batchArg.slice(1);
        const isEnd = batchArg.startsWith("-");
        const batchType = isEnd ? "" : m.params[1] || "";
        const target = isEnd ? "" : m.params[2] || "";
        if (isEnd) {
          const batch = this.batches.get(ref);
          if (batch) {
            const ch = this.ensureChannel(batch.target);
            // Prepend batch messages to history
            for (const msg of batch.messages) {
              ch.messages.unshift(msg);
            }
            this.batches.delete(ref);
            this.emit({ type: "batchEnd", ref });
            this.emit({ type: "channelUpdated", channel: ch.name });
          }
        } else {
          this.batches.set(ref, { type: batchType, target, messages: [] });
          this.emit({ type: "batchStart", ref, batchType, target });
        }
        break;
      }

      case "CHATHISTORY": {
        // Target list
        break;
      }

      default: {
        // Server numerics we don't handle explicitly
        if (m.command.match(/^\d{3}$/)) {
          const text = m.params[m.params.length - 1] || "";
          if (!this.backgroundWhois.has((m.params[1] || "").toLowerCase())) {
            this.addServerMessage(text);
          }
        }
        break;
      }
    }
  }

  // ── SASL ──

  private startSasl() {
    this.raw("AUTHENTICATE ATPROTO-CHALLENGE");
  }

  private sendSaslResponse() {
    const payload = JSON.stringify({
      did: this.saslDid,
      method: this.saslMethod || "pds-session",
      signature: this.saslToken,
    });
    const encoded = btoa(payload);
    // Send in 400-byte chunks
    for (let i = 0; i < encoded.length; i += 400) {
      this.raw(`AUTHENTICATE ${encoded.slice(i, i + 400)}`);
    }
    if (encoded.length % 400 === 0) {
      this.raw("AUTHENTICATE +");
    }
  }
}
