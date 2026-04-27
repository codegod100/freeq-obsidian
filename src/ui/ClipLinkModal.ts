import { App, FuzzySuggestModal } from "obsidian";

const CREATE_NEW = "__create_new__";

export class ClipLinkModal extends FuzzySuggestModal<string> {
	private onSubmit: (path: string) => void;
	private defaultName: string;

	constructor(app: App, defaultName: string, onSubmit: (path: string) => void) {
		super(app);
		this.defaultName = defaultName;
		this.onSubmit = onSubmit;
		this.setPlaceholder("Select a note or create a new one…");
	}

	getItems(): string[] {
		return [CREATE_NEW, ...this.app.vault.getMarkdownFiles().map((file) => file.path)];
	}

	getItemText(item: string): string {
		return item === CREATE_NEW ? `✏️ Create new note: ${this.defaultName}` : item;
	}

	onChooseItem(item: string): void {
		if (item === CREATE_NEW) {
			const fileName = this.defaultName.endsWith(".md") ? this.defaultName : `${this.defaultName}.md`;
			this.onSubmit(fileName);
			return;
		}

		this.onSubmit(item);
	}
}
