// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { focusManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectInstructionsIndicator } from "./project-instructions-indicator";
import { getProjectInstructionsStatus } from "@/lib/project-api";
vi.mock("@/lib/project-api", () => ({ getProjectInstructionsStatus: vi.fn() }));
afterEach(() => { cleanup(); vi.useRealTimers(); focusManager.setFocused(undefined); vi.resetAllMocks(); });
function open() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000, refetchOnWindowFocus: false } } });
  render(<QueryClientProvider client={client}><ProjectInstructionsIndicator projectId="p1" /></QueryClientProvider>);
  return client;
}
it("shows the instruction indicator and a link to the project", async () => {
  vi.mocked(getProjectInstructionsStatus).mockResolvedValue({ projectId: "p1", hasInstructions: true, instructionsRevision: 1 });
  open();
  const link = await screen.findByRole("link", { name: "Project instructions" });
  expect(link.getAttribute("href")).toBe("/projects?project=p1");
  expect(link.title).toContain("next turn");
});
it("makes failed context loading visible", async () => {
  vi.mocked(getProjectInstructionsStatus).mockRejectedValue(new Error("Unavailable"));
  open();
  expect((await screen.findByRole("link", { name: "Project context unavailable" })).title).toContain("retry");
});

it("does not poll and refreshes when the tab regains focus", async () => {
  vi.useFakeTimers();
  focusManager.setFocused(true);
  vi.mocked(getProjectInstructionsStatus).mockResolvedValue({ projectId: "p1", hasInstructions: false, instructionsRevision: 0 });
  open();
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
  expect(getProjectInstructionsStatus).toHaveBeenCalledTimes(1);
  vi.mocked(getProjectInstructionsStatus).mockResolvedValue({ projectId: "p1", hasInstructions: true, instructionsRevision: 1 });
  await act(async () => {
    focusManager.setFocused(false);
    focusManager.setFocused(true);
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(getProjectInstructionsStatus).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("link", { name: "Project instructions" })).toBeTruthy();
});
it("refreshes under the project's shared invalidation prefix", async () => {
  vi.mocked(getProjectInstructionsStatus).mockResolvedValue({ projectId: "p1", hasInstructions: true, instructionsRevision: 1 });
  const client = open();
  await screen.findByRole("link", { name: "Project instructions" });
  vi.mocked(getProjectInstructionsStatus).mockResolvedValue({ projectId: "p1", hasInstructions: false, instructionsRevision: 2 });
  await act(async () => { await client.invalidateQueries({ queryKey: ["projects"] }); });
  await screen.findByRole("link", { name: "Project" });
});
