import { Modal, App } from "obsidian";

export class JoinChannelModal extends Modal {
  private onSubmit: (channel: string) => void;

  constructor(app: App, onSubmit: (channel: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: "Join channel" });

    const input = contentEl.createEl("input", {
      type: "text",
      placeholder: "#general",
    });
    input.style.width = "100%";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const value = input.value.trim();
        if (value) {
          this.close();
          this.onSubmit(value);
        }
      }
    });

    const btn = contentEl.createEl("button", {
      text: "Join",
      cls: "mod-cta",
    });
    btn.addEventListener("click", () => {
      const value = input.value.trim();
      if (value) {
        this.close();
        this.onSubmit(value);
      }
    });

    input.focus();
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
