// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Project } from "@cogniplane/shared-types";
import { SessionCreateDialog } from "./session-create-dialog";

afterEach(cleanup);

const project = { projectId: "project-1", name: "Launch plan", archivedAt: null } as Project;
const archived = { projectId: "project-2", name: "Old project", archivedAt: "2026-09-01T00:00:00.000Z" } as Project;

it("creates the session in the chosen active project and closes", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  const onOpenChange = vi.fn();
  render(<SessionCreateDialog open onOpenChange={onOpenChange} projects={[project, archived]} onCreate={onCreate} />);
  expect(screen.queryByRole("option", { name: "Old project" })).toBeNull();
  fireEvent.change(screen.getByLabelText("Project"), { target: { value: project.projectId } });
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith(project.projectId));
  expect(onOpenChange).toHaveBeenCalledWith(false);
});

it("keeps the dialog open and shows a creation error", async () => {
  const onCreate = vi.fn().mockRejectedValue(new Error("Session service unavailable"));
  const onOpenChange = vi.fn();
  render(<SessionCreateDialog open onOpenChange={onOpenChange} projects={[]} onCreate={onCreate} />);
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  expect((await screen.findByRole("alert")).textContent).toContain("Session service unavailable");
  expect(onCreate).toHaveBeenCalledWith(null);
  expect(onOpenChange).not.toHaveBeenCalled();
});

it("does not close a new opening when a create from an earlier opening finishes", async () => {
  let finish!: () => void;
  const onCreate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const onOpenChange = vi.fn();
  const view = render(<SessionCreateDialog key={1} open onOpenChange={onOpenChange} projects={[]} onCreate={onCreate} />);
  fireEvent.click(screen.getByRole("button", { name: "Create session" }));
  // The user dismisses that opening and opens New session again.
  view.rerender(<SessionCreateDialog key={2} open onOpenChange={onOpenChange} projects={[]} onCreate={onCreate} />);
  await act(async () => finish());
  expect(onOpenChange).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "New session" })).toBeTruthy();
});
