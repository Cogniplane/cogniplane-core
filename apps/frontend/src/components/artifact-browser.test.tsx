// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Artifact } from "@cogniplane/shared-types";
import { ArtifactBrowser } from "./artifact-browser";

const api = vi.hoisted(() => ({
  browse: vi.fn(), preview: vi.fn(), download: vi.fn(), replace: vi.fn(), error: vi.fn(), search: ""
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: api.replace }), usePathname: () => "/artifacts",
  useSearchParams: () => new URLSearchParams(api.search)
}));
vi.mock("../lib/artifact-api", () => ({ browseArtifacts: api.browse, createArtifactDownload: api.download }));
vi.mock("../lib/artifact-preview-loader", () => ({ loadArtifactPreview: api.preview, artifactApiBase: () => "http://localhost:3001" }));
vi.mock("sonner", () => ({ toast: { error: api.error } }));

const artifact: Artifact = {
  artifactId: "artifact-1", sessionId: "session-1", userId: "user-1", artifactType: "generated",
  sourceArtifactId: null, artifactName: "notes.md", mimeType: "text/markdown", storageBackend: "local",
  storageKey: "artifact-1/notes.md", fileSizeBytes: 42, checksumSha256: "checksum", status: "ready",
  createdByType: "user", createdByRef: "user-1", detail: {},
  createdAt: "2026-09-04T12:00:00.000Z", updatedAt: "2026-09-04T12:00:00.000Z"
};
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><ArtifactBrowser /></QueryClientProvider>);
}
beforeEach(() => {
  vi.resetAllMocks();
  api.search = "";
  api.browse.mockResolvedValue({ items: [artifact], nextCursor: null });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers(); });

it("keeps loaded rows when the next page fails and retries the same cursor", async () => {
  api.browse.mockResolvedValueOnce({ items: [artifact], nextCursor: "page-2" })
    .mockRejectedValueOnce(new Error("Page unavailable"))
    .mockResolvedValueOnce({ items: [{ ...artifact, artifactId: "artifact-2", artifactName: "second.md" }], nextCursor: null });
  mount();
  await screen.findByText("notes.md");
  fireEvent.click(screen.getByRole("button", { name: "Load more" }));
  await screen.findByText("Page unavailable");
  expect(screen.getByText("notes.md")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry loading more" }));
  await screen.findByText("second.md");
  expect(screen.getByText("notes.md")).toBeTruthy();
  expect(api.browse.mock.calls.slice(1).map(([params]) => params.cursor)).toEqual(["page-2", "page-2"]);
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("recovers an initial fetch failure without reloading the page", async () => {
  api.browse.mockRejectedValueOnce(new Error("Temporarily unavailable"));
  mount();
  await screen.findByText("Temporarily unavailable");
  expect(screen.queryByText("No artifacts yet.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByText("notes.md");
  expect(screen.queryByText("Temporarily unavailable")).toBeNull();
});

it("debounces search, preserves bookmark filters and clears immediately", async () => {
  api.search = "type=generated&sort=name_asc";
  mount();
  await screen.findByText("notes.md");
  expect(api.browse).toHaveBeenLastCalledWith({ type: ["generated"], sort: "name_asc", cursor: undefined });
  vi.useFakeTimers();
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "budget" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(299); });
  expect(api.browse).toHaveBeenCalledTimes(1);
  await act(async () => { await vi.advanceTimersByTimeAsync(1); });
  expect(api.browse).toHaveBeenLastCalledWith({ type: ["generated"], sort: "name_asc", q: "budget", cursor: undefined });
  expect(api.replace).toHaveBeenLastCalledWith("/artifacts?q=budget&type=generated&sort=name_asc");
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  expect((screen.getByRole("searchbox") as HTMLInputElement).value).toBe("");
  expect(api.replace).toHaveBeenLastCalledWith("/artifacts");
});

it("opens and closes a real preview and reports a download failure", async () => {
  api.preview.mockResolvedValue({ kind: "text", text: "Preview contents" });
  api.download.mockRejectedValue(new Error("Download unavailable"));
  mount();
  await screen.findByText("notes.md");
  fireEvent.click(screen.getByRole("button", { name: "Preview notes.md" }));
  expect(await screen.findByRole("dialog")).toBeTruthy();
  await screen.findByText("Preview contents");
  expect(api.preview).toHaveBeenCalledWith(artifact);
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Download notes.md" }));
  await waitFor(() => expect(api.error).toHaveBeenCalledWith("Failed to download artifact."));
  expect(api.download).toHaveBeenCalledWith("artifact-1");
});

it("disables preview and download for a generated artifact still processing", async () => {
  api.browse.mockResolvedValue({ items: [{ ...artifact, status: "processing" }], nextCursor: null });
  mount();
  await screen.findByText("notes.md");
  expect((screen.getByRole("button", { name: "Preview notes.md" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Download notes.md" }) as HTMLButtonElement).disabled).toBe(true);
});


it("announces loading and explains an empty library, including a sort-only URL", async () => {
  api.search = "sort=name_asc";
  let resolve!: (value: unknown) => void;
  api.browse.mockReturnValue(new Promise(done => { resolve = done; }));
  mount();
  expect(screen.getByRole("status").textContent).toBe("Loading artifacts…");
  await act(async () => { resolve({ items: [], nextCursor: null }); });
  await screen.findByText("No artifacts yet.");
  expect(screen.getByText(/Upload a file in a session/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Clear filters" })).toBeNull();
});

it("clears a filtered no-match result locally without dropping recovery", async () => {
  api.search = "q=missing&type=upload";
  api.browse.mockResolvedValueOnce({ items: [], nextCursor: null });
  mount();
  await screen.findByText("No artifacts match these filters.");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  await screen.findByText("notes.md");
  expect(api.replace).toHaveBeenLastCalledWith("/artifacts");
  expect(api.browse).toHaveBeenLastCalledWith({ sort: "created_desc", cursor: undefined });
});

it("names filter purposes and shows readable source values while preserving multiselect enums", async () => {
  mount();
  await screen.findByText("notes.md");
  expect(screen.getByRole("combobox", { name: "Sort artifacts" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "File format" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "File status" })).toBeTruthy();
  fireEvent.keyDown(screen.getByRole("button", { name: "Source" }), { key: "Enter" });
  const upload = await screen.findByRole("menuitemcheckbox", { name: "Uploaded" });
  fireEvent.click(upload);
  fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Generated" }));
  await waitFor(() => expect(api.browse).toHaveBeenLastCalledWith({ sort: "created_desc", type: ["upload", "generated"], cursor: undefined }));
  expect(screen.getByRole("menuitemcheckbox", { name: "Uploaded" }).getAttribute("aria-checked")).toBe("true");
});

it("explains unsupported formats separately from processing and keeps full contextual names", async () => {
  const fullName = "A very long supporting research archive with customer evidence.zip";
  api.browse.mockResolvedValue({ items: [
    { ...artifact, artifactName: fullName, mimeType: "application/zip" },
    { ...artifact, artifactId: "processing", artifactName: "Processing.pdf", status: "processing" }
  ], nextCursor: null });
  mount();
  await screen.findByText(fullName);
  const row = screen.getByText(fullName).closest('[role="listitem"]') as HTMLElement;
  expect(within(row).getByText(/Preview is not supported/)).toBeTruthy();
  expect((within(row).getByRole("button", { name: `Preview ${fullName}` }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(row).getByRole("button", { name: `Download ${fullName}` }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getByText("Preview and download will be available when the file is ready.")).toBeTruthy();
});

it("announces preview failure and retries the same artifact without changing eligibility", async () => {
  api.preview.mockRejectedValueOnce(new Error("Unavailable")).mockResolvedValueOnce({ kind: "text", text: "Recovered preview" });
  mount();
  await screen.findByText("notes.md");
  fireEvent.click(screen.getByRole("button", { name: "Preview notes.md" }));
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Failed to load preview");
  fireEvent.click(screen.getByRole("button", { name: "Retry preview" }));
  await screen.findByText("Recovered preview");
  expect(api.preview.mock.calls.map(([target]) => target)).toEqual([artifact, artifact]);
  expect(screen.queryByRole("button", { name: "Retry preview" })).toBeNull();
});
