import { Modal, App } from "obsidian";

export class ClipLinkModal extends Modal {
	private onSubmit: (noteName: string) => void;
	private defaultValue: string;

	constructor(app: App, defaultValue: string, onSubmit: (noteName: string) => void) {
		super(app);
		this.defaultValue = defaultValue;
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "Clip link as note" });

		const input = contentEl.createEl("input", {
			type: "text",
			value: this.defaultValue,
		});
		input.style.width = "100%";
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				const value = input.value.trim();
				if (value) {
					this.onSubmit(value);
					this.close();
				}
			}
			if (e.key === "Escape") {
				this.close();
			}
		});

		const btnRow = contentEl.createDiv({ cls: "clip-link-modal-btns" });
		const cancelBtn = btnRow.createEl("button", { text: "Cancel" });
		cancelBtn.addEventListener("click", () => this.close());

		const saveBtn = btnRow.createEl("button", { text: "Save", cls: "mod-cta" });
		saveBtn.addEventListener("click", () => {
			const value = input.value.trim();
			if (value) {
				this.onSubmit(value);
				this.close();
			}
		});

		input.focus();
		input.select();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
