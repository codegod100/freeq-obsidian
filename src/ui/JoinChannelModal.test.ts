import { describe, it, expect, vi } from "vitest";
import { JoinChannelModal } from "./JoinChannelModal";

describe("JoinChannelModal", () => {
  it("calls onSubmit with trimmed channel on Enter key", () => {
    const onSubmit = vi.fn();
    const modal = new JoinChannelModal({} as any, onSubmit);
    modal.onOpen();

    const input = modal.contentEl.querySelector("input") as HTMLInputElement;
    input.value = "  #general  ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onSubmit).toHaveBeenCalledWith("#general");
    expect(modal.close).toHaveBeenCalled();
  });

  it("calls onSubmit with trimmed channel on button click", () => {
    const onSubmit = vi.fn();
    const modal = new JoinChannelModal({} as any, onSubmit);
    modal.onOpen();

    const input = modal.contentEl.querySelector("input") as HTMLInputElement;
    input.value = "#random";

    const btn = modal.contentEl.querySelector("button") as HTMLButtonElement;
    btn.click();

    expect(onSubmit).toHaveBeenCalledWith("#random");
    expect(modal.close).toHaveBeenCalled();
  });

  it("does not submit if input is empty", () => {
    const onSubmit = vi.fn();
    const modal = new JoinChannelModal({} as any, onSubmit);
    modal.onOpen();

    const input = modal.contentEl.querySelector("input") as HTMLInputElement;
    input.value = "   ";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("clears content on close", () => {
    const onSubmit = vi.fn();
    const modal = new JoinChannelModal({} as any, onSubmit);
    modal.onOpen();
    expect(modal.contentEl.innerHTML).not.toBe("");

    modal.onClose();
    expect(modal.contentEl.innerHTML).toBe("");
  });
});
