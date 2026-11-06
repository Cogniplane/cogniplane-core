// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminSkillGithubImportTab } from "./admin-skill-github-import-tab";
import { AdminSkillInlineTab } from "./admin-skill-inline-tab";
import { AdminSkillZipUploadTab } from "./admin-skill-zip-upload-tab";

afterEach(cleanup);
it("exposes native inline validation and keeps fields editable while another operation blocks submission", () => {
  const onDraftChange = vi.fn();
  function Inline() {
    const [draft, setDraft] = useState({ skillId: "bad/id", skillName: "Brief", description: "Purpose", instructions: "Text" });
    return <AdminSkillInlineTab busyKey="skill-import-github" draft={draft} onDraftChange={next => { onDraftChange(next); setDraft(next); }} onSubmit={vi.fn()} error="Save failed. Draft kept." />;
  }
  render(<Inline />);
  const identity = screen.getByLabelText("Skill ID") as HTMLInputElement;
  expect(identity.checkValidity()).toBe(false);
  fireEvent.change(identity, { target: { value: "  valid_id--1  " } });
  expect(identity.checkValidity()).toBe(true);
  expect((screen.getByRole("button", { name: "Create skill" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText("Instructions (SKILL.md body)"), { target: { value: "Later text" } });
  expect(onDraftChange).toHaveBeenCalledWith(expect.objectContaining({ instructions: "Later text" }));
  expect(screen.getByRole("alert").textContent).toBe("Save failed. Draft kept.");
});
it("keeps GitHub source details available and blocks submission during any pending save", () => {
  render(<AdminSkillGithubImportTab busyKey="skill-import-zip" draft={{ githubUrl: "https://github.com/fictional/skills", ref: "main", subdirectory: "skills/research-brief" }} onDraftChange={vi.fn()} onSubmit={vi.fn()} />);
  expect((screen.getByRole("button", { name: "Import GitHub skill" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("Ref") as HTMLInputElement).disabled).toBe(false);
});
it("reports ZIP selection and replacement without starting an import", () => {
  const onZipFileNameChange = vi.fn(); const onSubmit = vi.fn();
  render(<AdminSkillZipUploadTab zipFileName="fictional-briefing.zip" busyKey="skill-import-inline" onZipFileNameChange={onZipFileNameChange} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByLabelText("ZIP file"), { target: { files: [new File(["fictional"], "fictional-replacement.zip")] } });
  expect(onZipFileNameChange).toHaveBeenCalledWith("fictional-replacement.zip");
  expect(onSubmit).not.toHaveBeenCalled();
  expect((screen.getByRole("button", { name: "Import ZIP" }) as HTMLButtonElement).disabled).toBe(true);
});
