// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AdminSkillEditModal } from "./admin-skill-edit-modal";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function renderModal(isBusy = false) {
  const onCancel = vi.fn();
  const onSubmit = vi.fn(async () => undefined);
  render(<AdminSkillEditModal skillId="briefing" initialSkillName="Briefing" initialDescription="Write a briefing"
    initialInstructions="Write a concise briefing." isBusy={isBusy} onCancel={onCancel} onSubmit={onSubmit} />);
  return { onCancel, onSubmit };
}

const save = () => screen.getByRole("button", { name: /Save as new revision|Saving/ }) as HTMLButtonElement;

it("names the skill and starts from the given text", () => {
  renderModal();

  expect(screen.getByRole("dialog", { name: "Edit skill: briefing" })).toBeTruthy();
  expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Briefing");
  expect((screen.getByLabelText("Instructions (SKILL.md body)") as HTMLTextAreaElement).value).toBe("Write a concise briefing.");
});

it("trims the name and description but keeps the instructions exactly", () => {
  const { onSubmit } = renderModal();
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "  Daily briefing " } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: " Write it daily  " } });
  fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), { target: { value: "  ## Steps\n" } });

  fireEvent.click(save());

  expect(onSubmit).toHaveBeenCalledWith({ skillName: "Daily briefing", description: "Write it daily", instructions: "  ## Steps\n" });
});

it.each([
  ["Display name", "   "],
  ["Description", ""],
  ["Instructions (SKILL.md body)", " \n "]
])("blocks saving while %s is blank", (label, value) => {
  renderModal();

  fireEvent.change(screen.getByLabelText(label), { target: { value } });

  expect(save().disabled).toBe(true);
});

it("blocks saving while a save runs", () => {
  renderModal(true);

  expect(save().textContent).toBe("Saving...");
  expect(save().disabled).toBe(true);
});

it("cancels from the button and from Escape", () => {
  const { onCancel } = renderModal();

  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

  expect(onCancel).toHaveBeenCalledTimes(2);
});

it("holds fields, cancellation, Escape and duplicate submits until a save settles", async () => {
  let reject!: (error: Error) => void;
  const onSubmit = vi.fn(() => new Promise<void>((_, no) => { reject = no; }));
  const onCancel = vi.fn();
  render(<AdminSkillEditModal skillId="briefing" initialSkillName="Briefing" initialDescription="Purpose" initialInstructions="Text" isBusy={false} onCancel={onCancel} onSubmit={onSubmit} />);
  const form = screen.getByLabelText("Display name").closest("form")!;
  fireEvent.submit(form); fireEvent.submit(form);
  expect(onSubmit).toHaveBeenCalledOnce();
  expect((screen.getByLabelText("Display name") as HTMLInputElement).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onCancel).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Close" })).toBeNull();
  await act(async () => { reject(new Error("Save refused")); });
  expect(screen.getByRole("alert").textContent).toBe("Save refused");
  expect((screen.getByLabelText("Display name") as HTMLInputElement).matches(":disabled")).toBe(false);
});

it("asks before discarding changed text and keeps it when discard is refused", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const { onCancel } = renderModal();
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New purpose" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(confirm).toHaveBeenCalledOnce();
  expect(onCancel).not.toHaveBeenCalled();
  expect((screen.getByLabelText("Description") as HTMLInputElement).value).toBe("New purpose");
  confirm.mockReturnValue(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(onCancel).toHaveBeenCalledOnce());
});
