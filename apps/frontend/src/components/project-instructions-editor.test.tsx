// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { Project } from "@cogniplane/shared-types";
import { ProjectInstructionsEditor } from "./project-instructions-editor";
import { updateProjectInstructions } from "@/lib/project-api";
vi.mock("@/lib/project-api", () => ({ updateProjectInstructions: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const project: Project = { projectId: "p1", name: "Proposal", instructions: "Use CAD", instructionsRevision: 3,
  referenceSessionId: "refs", approvalMode: "organization_default", agentFileMode: "read-only", archivedAt: null, createdAt: "2026-09-14T00:00:00Z", updatedAt: "2026-09-14T00:00:00Z" };
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const view = (value: Project) => <QueryClientProvider client={client}><ProjectInstructionsEditor project={value} /></QueryClientProvider>;
  const result = render(view(project));
  return { ...result, changeProject: (value: Project) => result.rerender(view(value)) };
}
it("saves a draft with its starting revision and shows confirmation", async () => {
  vi.mocked(updateProjectInstructions).mockResolvedValue({ ...project, instructions: "Write in French", instructionsRevision: 4 });
  const h = setup();
  fireEvent.change(screen.getByLabelText("Project instructions"), { target: { value: "Write in French" } });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => expect(updateProjectInstructions).toHaveBeenCalledWith("p1", "Write in French", 3));
  h.changeProject({ ...project, instructions: "Write in French", instructionsRevision: 4 });
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("Instructions saved"));
});
it("preserves a draft on failed save and allows retry", async () => {
  vi.mocked(updateProjectInstructions).mockRejectedValue(new Error("Could not save instructions"));
  setup();
  fireEvent.change(screen.getByLabelText("Project instructions"), { target: { value: "Keep this draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await screen.findByRole("alert");
  expect((screen.getByLabelText("Project instructions") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect((screen.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled).toBe(false);
});
it("does not overwrite an unsaved draft when a newer revision arrives", () => {
  const h = setup();
  fireEvent.change(screen.getByLabelText("Project instructions"), { target: { value: "My draft" } });
  h.changeProject({ ...project, instructions: "Other tab", instructionsRevision: 4 });
  expect(screen.getByRole("alert").textContent).toContain("another tab");
  expect((screen.getByLabelText("Project instructions") as HTMLTextAreaElement).value).toBe("My draft");
  expect((screen.getByRole("button", { name: "Save instructions" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Use saved version" }));
  expect((screen.getByLabelText("Project instructions") as HTMLTextAreaElement).value).toBe("Other tab");
});
it("allows clearing instructions and disables edits while saving", async () => {
  let finish!: (value: Project) => void;
  vi.mocked(updateProjectInstructions).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  setup();
  fireEvent.change(screen.getByLabelText("Project instructions"), { target: { value: "" } });
  fireEvent.click(screen.getByRole("button", { name: "Save instructions" }));
  await waitFor(() => expect((screen.getByLabelText("Project instructions") as HTMLTextAreaElement).disabled).toBe(true));
  expect(updateProjectInstructions).toHaveBeenCalledWith("p1", "", 3);
  finish({ ...project, instructions: "", instructionsRevision: 4 });
  await screen.findByRole("status");
});
