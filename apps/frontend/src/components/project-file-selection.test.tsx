// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ProjectFilePickerEntry } from "@cogniplane/shared-types";

import * as api from "../lib/project-file-api";
import { useProjectFileSelection } from "../hooks/use-project-library";
import { ProjectFileSelection } from "./project-file-selection";

vi.mock("../lib/project-file-api", () => ({
  listProjectFilePicker: vi.fn(),
  getProjectFilePickerSelection: vi.fn(),
}));

const entry = (fileId: string, name: string, folderPath = "Files"): ProjectFilePickerEntry => ({
  fileId, name, kind: "published", folderId: null, folderPath, versionId: `${fileId}-v1`, versionNumber: 1,
});
const files = [entry("a", "Agenda.txt"), entry("b", "Budget.txt", "Files / Finance"), entry("c", "Charter.txt")];
let client: QueryClient;

// Mirrors how the chat shell keeps selected IDs and loads them through the selection endpoint.
function Harness() {
  const [ids, setIds] = useState<string[]>([]);
  const selection = useProjectFileSelection("p", ids);
  return (
    <ProjectFileSelection
      projectId="p"
      selectedIds={ids}
      selectedEntries={selection.data?.items ?? []}
      unavailableCount={0}
      onToggle={(fileId) => setIds((current) =>
        current.includes(fileId) ? current.filter((id) => id !== fileId) : [...current, fileId])}
    />
  );
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(api.listProjectFilePicker).mockImplementation(async (_projectId, input) => {
    const q = input.q?.toLowerCase();
    const matches = files.filter((file) => !q || file.name.toLowerCase().includes(q));
    const start = Number(input.cursor ?? 0);
    // The second page repeats the last row of the first page. The picker must show it once.
    const items = matches.slice(Math.max(0, start - 1), start + 2);
    return { items, nextCursor: start + 2 < matches.length ? String(start + 2) : null };
  });
  vi.mocked(api.getProjectFilePickerSelection).mockImplementation(async (_projectId, ids) => ({
    items: files.filter((file) => ids.includes(file.fileId)),
  }));
});
afterEach(() => {
  cleanup();
  client.clear();
  vi.resetAllMocks();
});

it("loads more results on request and keeps selections visible outside the current search", async () => {
  render(<QueryClientProvider client={client}><Harness /></QueryClientProvider>);
  await screen.findByRole("checkbox", { name: "Budget.txt" });
  expect(screen.queryByRole("checkbox", { name: "Charter.txt" })).toBeNull();
  expect(screen.getByRole("region", { name: "Files / Finance" })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "More results" }));
  await screen.findByRole("checkbox", { name: "Charter.txt" });
  expect(screen.getAllByRole("checkbox", { name: "Budget.txt" })).toHaveLength(1);
  expect(screen.queryByRole("button", { name: "More results" })).toBeNull();

  fireEvent.click(screen.getByRole("checkbox", { name: "Charter.txt" }));
  await waitFor(() => expect(api.getProjectFilePickerSelection).toHaveBeenCalledWith("p", ["c"], expect.anything()));

  fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "agen" } });
  await waitFor(() => expect(api.listProjectFilePicker).toHaveBeenLastCalledWith(
    "p", { q: "agen", kind: "any", cursor: undefined }, expect.anything(),
  ));
  const others = await screen.findByRole("region", { name: "Other selected files" });
  const charter = within(others).getByRole("checkbox", { name: "Charter.txt" }) as HTMLInputElement;
  expect(charter.checked).toBe(true);
  expect(screen.getByText("1/20 prioritized")).toBeTruthy();

  fireEvent.click(charter);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Other selected files" })).toBeNull());
  expect(screen.getByText("0/20 prioritized")).toBeTruthy();
});
