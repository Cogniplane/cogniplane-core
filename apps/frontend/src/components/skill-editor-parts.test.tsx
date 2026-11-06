// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SkillConflictChoice, SkillHistory, SkillInstructions, SkillSourceFields, type SkillEditorState } from "./skill-editor-parts";

afterEach(cleanup);
const content = { name: "meeting-notes", description: "Prepare notes", instructions: "Summarize decisions." };
const revision = (number: number) => ({ revision: number, content, validationMessages: [], createdAt: "2026-11-04T12:00:00.000Z" });

it("edits a long purpose in a multiline field without cutting it", () => {
  const onChange = vi.fn();
  const long = "Purpose ".repeat(128).slice(0, 1024);
  const editor: SkillEditorState = { kind: "inline", content: { ...content, description: long } };
  render(<SkillSourceFields idPrefix="test" editor={editor} disabled={false} onChange={onChange} onSwitch={vi.fn()} onFile={vi.fn()} />);
  const purpose = screen.getByRole("textbox", { name: "Purpose" }) as HTMLTextAreaElement;
  expect(purpose.tagName).toBe("TEXTAREA");
  expect(purpose.value).toBe(long);
  expect(purpose.maxLength).toBe(1024);
  fireEvent.change(purpose, { target: { value: "First line\nSecond line" } });
  expect(onChange).toHaveBeenCalledWith({ kind: "inline", content: { ...content, description: "First line\nSecond line" } });
});

it("shows a file message under the upload control only for Markdown import", () => {
  const editor: SkillEditorState = { kind: "markdown", markdown: "" };
  render(<SkillSourceFields idPrefix="test" editor={editor} disabled={false} onChange={vi.fn()} onSwitch={vi.fn()} onFile={vi.fn()} fileMessage={<p>File problem</p>} />);
  const upload = screen.getByLabelText("Upload SKILL.md");
  expect(upload.parentElement?.parentElement?.textContent).toContain("File problem");
});

it("lists history in a focusable bounded region with role markers and notes", () => {
  render(<SkillHistory revisions={[revision(2), revision(1)]} markers={(item) => item.revision === 1 ? ["In use"] : ["Latest draft"]} note={(item) => item.revision === 2 ? "Copied from private revision 4" : null} />);
  const region = screen.getByRole("region", { name: "Revision history" });
  expect(region.tabIndex).toBe(0);
  const rows = within(region).getAllByRole("listitem");
  expect(rows).toHaveLength(2);
  expect(rows[0].textContent).toContain("Revision 2");
  expect(rows[0].textContent).toContain("Latest draft");
  expect(rows[0].textContent).toContain("Copied from private revision 4");
  expect(rows[1].textContent).toContain("In use");
  expect(screen.getByText(/2 saved revisions, newest first/)).toBeTruthy();
});

it("names the instruction well so keyboard users can scroll it", () => {
  render(<SkillInstructions title="Draft instructions" text="Long text" />);
  const well = screen.getByRole("region", { name: "Draft instructions" });
  expect(well.tabIndex).toBe(0);
  expect(well.textContent).toBe("Long text");
});

it("asks for one version after a conflict", () => {
  const onKeep = vi.fn(), onUseLatest = vi.fn();
  render(<SkillConflictChoice content={{ ...content, instructions: "Other tab text." }} disabled={false} onKeep={onKeep} onUseLatest={onUseLatest} />);
  const group = screen.getByRole("group", { name: "Latest saved version" });
  expect(group.textContent).toContain("A newer version was saved elsewhere");
  expect(group.textContent).toContain("Other tab text.");
  fireEvent.click(within(group).getByRole("button", { name: "Keep my text" }));
  fireEvent.click(within(group).getByRole("button", { name: "Use the latest version" }));
  expect(onKeep).toHaveBeenCalledOnce();
  expect(onUseLatest).toHaveBeenCalledOnce();
});
