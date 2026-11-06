// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminMcpServer } from "@cogniplane/shared-types";

import { AdminMcpContent } from "./admin-mcp-content";

const data = vi.hoisted(() => ({ saveError: null as string | null, handleSubmit: vi.fn(), loaded: true, loadError: null as string | null, reload: vi.fn() }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "sample", userId: "sample-admin" } }) }));
vi.mock("../../../hooks/use-admin-mcp-data", () => ({ useAdminMcpData: () => ({
  mcpServers: [
    { serverId: "personal", serverName: "Personal sample", mode: "managed", routePath: "/mcp/personal", upstreamAuthType: "none", transportKind: "http", credentialScope: "personal", enabled: true, isAllowed: true, isPublished: true, version: 1 },
    { serverId: "inherited", serverName: "Built-in sample", ownerTenantId: "system", mode: "managed", routePath: "/mcp/inherited", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: true, version: 1 }
  ] as AdminMcpServer[],
  loaded: data.loaded, loading: false, busyKey: null, listGeneration: 1, loadError: data.loadError,
  saveError: data.saveError, handleSubmit: data.handleSubmit,
  handleSetInheritedAudience: vi.fn(), reload: data.reload
}) }));

afterEach(() => { cleanup(); data.saveError = null; data.handleSubmit.mockReset(); data.loaded = true; data.loadError = null; data.reload.mockReset(); });

it.each([false, true])("labels initial list failure and recovers focus only when owned, outside=%s", async (outside) => {
  data.loaded = false;
  data.loadError = "Sample list unavailable";
  let finish!: () => void;
  data.reload.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
  const content = () => <><AdminMcpContent /><button>Outside sample</button></>;
  const view = render(content());
  const heading = screen.getByRole("heading", { name: "MCP connections" });
  const error = screen.getByRole("alert");
  expect(heading.closest("section")?.contains(error)).toBe(true);
  expect(heading.compareDocumentPosition(error) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const button = screen.getByRole("button", { name: "Reload" });
  button.focus();
  fireEvent.click(button); fireEvent.click(button);
  expect(data.reload).toHaveBeenCalledTimes(1);
  if (outside) screen.getByRole("button", { name: "Outside sample" }).focus();
  data.loaded = true; data.loadError = null;
  view.rerender(content());
  await act(async () => { finish(); });
  expect(document.activeElement).toBe(outside ? screen.getByRole("button", { name: "Outside sample" }) : heading);
});

it("keeps a rejected save with its editor and does not carry it into another editor", async () => {
  data.handleSubmit.mockRejectedValue(new Error("Sample personal save failed"));
  const view = render(<AdminMcpContent />);
  fireEvent.click(screen.getByRole("button", { name: "Manage Personal sample" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Retain until discarded" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Sample personal save failed"));
  data.saveError = "Sample personal save failed";
  view.rerender(<AdminMcpContent />);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  fireEvent.click(screen.getByRole("button", { name: "Manage Built-in sample" }));
  expect(screen.queryByText(/Sample personal save failed/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  expect(screen.getByRole("form", { name: "Add connection" })).toBeTruthy();
  expect(screen.queryByText(/Sample personal save failed/)).toBeNull();
});
