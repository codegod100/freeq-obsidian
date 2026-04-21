import { App, TFile, TFolder, moment, normalizePath } from "obsidian";
import type { FreeQSettings } from "../settings";
import type { ChatMessage } from "../irc/client";

export interface ClipContext {
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
