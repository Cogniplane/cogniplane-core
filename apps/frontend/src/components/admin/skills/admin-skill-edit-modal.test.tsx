// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { AdminSkillEditModal } from "./admin-skill-edit-modal";

afterEach(cleanup);

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
