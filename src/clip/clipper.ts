import { App, Notice, TFile, TFolder, moment, normalizePath, requestUrl } from "obsidian";
import type { FreeQSettings } from "../settings";
import type { ChatMessage } from "../irc/client";
import { ClipLinkModal } from "../ui/ClipLinkModal";

export interface ClipContext {
  channel: string;
  msg: ChatMessage;
}

export interface LinkClipContext {
  url: string;
  text: string;
  channel: string;
  msg: ChatMessage;
}

export class Clipper {
  constructor(private app: App, private settings: FreeQSettings) {}

  async clip(context: ClipContext): Promise<string | null> {
    const { channel, msg } = context;
    const timestamp = moment(msg.timestamp).format("YYYY-MM-DD HH:mm:ss");

    let text = this.settings.clipTemplate
      .replace(/{{text}}/g, msg.text)
      .replace(/{{from}}/g, msg.from)
      .replace(/{{channel}}/g, channel)
      .replace(/{{timestamp}}/g, timestamp)
      .replace(/{{msgid}}/g, msg.id)
      .replace(
        /{{url}}/g,
        `https://irc.freeq.at/channel/${encodeURIComponent(channel)}/msg/${msg.id}`
      );

    // Append two newlines for separation
    text = "\n" + text + "\n";

    try {
      if (this.settings.useDailyNote) {
        return await this.appendToDailyNote(text);
      } else {
        return await this.appendToFolder(text, channel, msg);
      }
    } catch (e) {
      console.error("[freeq] clip failed:", e);
      return null;
    }
  }

  async clipLink(context: LinkClipContext): Promise<string | null> {
    const { url, text, channel, msg } = context;

    // Prompt for target note via fuzzy picker
    const notePath = await new Promise<string | null>((resolve) => {
      const defaultName = text || this.slugifyUrl(url);
      let submitted = false;
      const modal = new ClipLinkModal(this.app, defaultName, (path) => {
        submitted = true;
        resolve(path);
      });
      const origOnClose = modal.onClose.bind(modal);
      modal.onClose = () => {
        origOnClose();
        if (!submitted) resolve(null);
      };
      modal.open();
    });
    if (!notePath) return null;

    // Fetch the page content
    let body = "";
    try {
      const res = await requestUrl({ url, method: "GET" });
      body = res.text;
    } catch (e) {
      // If fetch fails, just save the link
      console.warn("[freeq] clipLink fetch failed:", url, e);
      body = "";
    }

    // Build note content
    const timestamp = moment(msg.timestamp).format("YYYY-MM-DD HH:mm:ss");
    const frontmatter = [
      "---",
      `source: ${url}`,
      `clipped: ${moment().format("YYYY-MM-DDTHH:mm:ssZ")}`,
      `from: ${msg.from}`,
      `channel: ${channel}`,
      "---",
      "",
    ].join("\n");

    const linkLine = `> [${text}](${url}) — @${msg.from} in ${channel} at ${timestamp}\n\n`;

    // Try to extract readable content from HTML, otherwise use raw text
    let content = "";
    if (body.startsWith("<") || body.includes("<html")) {
      const titleMatch = body.match(/<title[^>]*>([^<]+)<\/title>/i);
      const title = titleMatch ? titleMatch[1].trim() : "";
      const stripped = body
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      content = title ? `## ${title}\n\n${stripped.slice(0, 10000)}` : stripped.slice(0, 10000);
    } else {
      content = body.slice(0, 10000);
    }

    const targetPath = normalizePath(
      notePath.includes("/") ? notePath : `${this.settings.clipFolder || "FreeQ Clippings"}/${notePath}`
    );
    const noteTitle = targetPath.replace(/\.md$/, "").split("/").pop() || notePath;
    const noteText = frontmatter + `# ${noteTitle}\n\n` + linkLine + content + "\n";

    // Check if the note already exists
    const existing = this.app.vault.getAbstractFileByPath(targetPath);
    if (existing instanceof TFile) {
      const appendText = "\n" + linkLine + content + "\n";
      try {
        await this.app.vault.append(existing, appendText);
        return existing.path;
      } catch (e) {
        console.error("[freeq] clipLink vault.append failed:", e);
        new Notice(`Failed to append to note: ${e.message || String(e)}`);
        return null;
      }
    }

    // Create new note — ensure parent folder exists
    const folderPath = targetPath.includes("/")
      ? targetPath.substring(0, targetPath.lastIndexOf("/"))
      : (this.settings.clipFolder || "FreeQ Clippings");
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    const filePath = targetPath;

    try {
      const created = await this.app.vault.create(filePath, noteText.replace(/^# .+\n\n/, `# ${noteTitle}\n\n`));
      return created.path;
    } catch (e) {
      console.error("[freeq] clipLink vault.create failed:", e);
      new Notice(`Failed to clip link: ${e.message || String(e)}`);
      return null;
    }
  }

  private slugifyUrl(url: string): string {
    try {
      const u = new URL(url);
      const path = u.pathname.replace(/\/$/, "").split("/").pop() || "";
      const name = path.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9_-]/g, " ").trim();
      return name || u.hostname;
    } catch {
      return "clipped-link";
    }
  }

  private async appendToDailyNote(text: string): Promise<string | null> {
    // Try to use the Daily Notes core plugin if available
    const dailyNotes = (this.app as any).internal?.plugins?.plugins?.[
      "daily-notes"
    ];
    if (dailyNotes?.instance) {
      const file = await dailyNotes.instance.openOrCreate(moment());
      if (file instanceof TFile) {
        await this.app.vault.append(file, text);
        return file.path;
      }
    }

    // Fallback: create our own daily note
    const dateStr = moment().format(this.settings.dailyNoteFormat || "YYYY-MM-DD");
    const path = normalizePath(`${dateStr}.md`);
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.vault.append(file, text);
      return file.path;
    }

    const created = await this.app.vault.create(path, `# ${dateStr}\n${text}`);
    return created.path;
  }

  private async appendToFolder(
    text: string,
    channel: string,
    msg: ChatMessage
  ): Promise<string | null> {
    const folderPath = normalizePath(this.settings.clipFolder || "FreeQ Clippings");
    const folder = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folder) {
      await this.app.vault.createFolder(folderPath);
    }

    const dateStr = moment(msg.timestamp).format("YYYY-MM-DD");
    const safeChannel = channel.replace(/[^a-zA-Z0-9_-]/g, "_");
    const fileName = `${dateStr} ${safeChannel}.md`;
    const filePath = normalizePath(`${folderPath}/${fileName}`);

    const existing = this.app.vault.getAbstractFileByPath(filePath);
    if (existing instanceof TFile) {
      await this.app.vault.append(existing, text);
      return existing.path;
    }

    const header = `# ${channel} — ${dateStr}\n\n`;
    const created = await this.app.vault.create(filePath, header + text);
    return created.path;
  }
}
