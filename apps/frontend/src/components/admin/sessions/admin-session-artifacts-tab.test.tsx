// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AdminSessionArtifactsTab } from "./admin-session-artifacts-tab";
import { createAdminArtifactDownload } from "../../../lib/admin-api";
vi.mock("../../../lib/admin-api", () => ({ createAdminArtifactDownload: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it("tracks each download independently and keeps a failed result in its own row", async () => {
  const reject: Record<string, (error: Error) => void> = {};
  vi.mocked(createAdminArtifactDownload).mockImplementation(id => new Promise((_resolve, fail) => { reject[id] = fail; }));
  render(<AdminSessionArtifactsTab artifacts={["a", "b"].map(id => ({ artifactId: id, artifactType: "file", artifactName: `Sample ${id}`, mimeType: "text/plain", fileSizeBytes: 1, status: "ready", createdAt: "2026-10-01T00:00:00Z" }))} />);
  const buttons = screen.getAllByRole("button", { name: "Download" });
  fireEvent.click(buttons[0]); fireEvent.click(buttons[0]); fireEvent.click(buttons[1]);
  expect(createAdminArtifactDownload).toHaveBeenCalledTimes(2);
  expect(screen.getAllByRole("button", { name: "Preparing…" })).toHaveLength(2);
  await act(async () => reject.a(new Error("Download a refused")));
  expect(buttons[0].getAttribute("aria-busy")).toBe("false");
  expect(buttons[1].getAttribute("aria-busy")).toBe("true");
  expect(within(buttons[0].parentElement!).getByRole("alert").textContent).toBe("Download a refused");
  await act(async () => reject.b(new Error("Download b refused")));
  expect(screen.getAllByRole("alert")).toHaveLength(2);
});
