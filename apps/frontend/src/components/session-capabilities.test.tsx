// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionCapabilitiesButton } from "./session-capabilities";
import { getSessionCapabilities, updateSessionCapabilities } from "../lib/session-api";

vi.mock("../lib/session-api", () => ({ getSessionCapabilities: vi.fn(), updateSessionCapabilities: vi.fn() }));
const defaults = { selection: null, version: 2, canEdit: true,
  skills: [{ id: "pdf", name: "PDF", description: "Read documents" }],
  connectors: [{ id: "docs", name: "Docs", description: "Company documents" }] };
beforeEach(() => { vi.resetAllMocks(); vi.mocked(getSessionCapabilities).mockResolvedValue(defaults); vi.mocked(updateSessionCapabilities).mockResolvedValue(defaults); });
afterEach(cleanup);
async function open(busy = false) {
  const view = render(<SessionCapabilitiesButton sessionId="session-1" busy={busy} />);
  fireEvent.click(screen.getByRole("button", { name: "Session capabilities" }));
  await screen.findByRole("radio", { name: "Choose for this session" });
  return view;
}
it("saves a narrowed selection and reloads saved choices when reopened", async () => {
  await open();
  expect(screen.getByRole("checkbox", { name: /PDF/ }).matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Choose for this session" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Docs/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  await waitFor(() => expect(updateSessionCapabilities).toHaveBeenCalledWith("session-1", { version: 2, selection: { skillIds: ["pdf"], connectorIds: [] } }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  vi.mocked(getSessionCapabilities).mockResolvedValue({ ...defaults, selection: { skillIds: ["pdf"], connectorIds: [] } });
  fireEvent.click(screen.getByRole("button", { name: "Session capabilities" }));
  await screen.findByRole("checkbox", { name: /Docs/ });
  expect((screen.getByRole("checkbox", { name: /Docs/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Use organization defaults" }));
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  await waitFor(() => expect(updateSessionCapabilities).toHaveBeenLastCalledWith("session-1", { version: 2, selection: null }));
});
it("recovers load and save errors without silently discarding choices", async () => {
  vi.mocked(getSessionCapabilities).mockRejectedValueOnce(new Error("Could not load capabilities."));
  render(<SessionCapabilitiesButton sessionId="session-1" busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Session capabilities" }));
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Reload capabilities" }));
  fireEvent.click(await screen.findByRole("radio", { name: "Choose for this session" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /PDF/ }));
  vi.mocked(updateSessionCapabilities).mockRejectedValueOnce(new Error("The session changed. Reload and try again."));
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  await screen.findByRole("alert");
  expect((screen.getByRole("checkbox", { name: /PDF/ }) as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
it.each([true, false])("blocks edits when the live or server state is busy: %s", async (liveBusy) => {
  vi.mocked(getSessionCapabilities).mockResolvedValue({ ...defaults, canEdit: liveBusy });
  await open(liveBusy);
  expect((screen.getByRole("button", { name: "Save capabilities" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  expect(updateSessionCapabilities).not.toHaveBeenCalled();
});
it("handles an empty catalog and removes unavailable saved IDs before a new save", async () => {
  vi.mocked(getSessionCapabilities).mockResolvedValue({ ...defaults, skills: [], connectors: [], selection: { skillIds: ["removed"], connectorIds: [] } });
  await open();
  expect(screen.getByText("No skills are available under organization policy.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save capabilities" }));
  await waitFor(() => expect(updateSessionCapabilities).toHaveBeenCalledWith("session-1", { version: 2, selection: { skillIds: [], connectorIds: [] } }));
});
