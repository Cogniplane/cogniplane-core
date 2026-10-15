// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminMcpConnectionTest, AdminMcpServer } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { testAdminMcpConnection } from "@/lib/admin-api";
import { AdminMcpConnectionTestCard } from "./admin-mcp-connection-test";

const auth = vi.hoisted(() => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/lib/admin-api", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/admin-api")>()), testAdminMcpConnection: vi.fn() }));
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const server = { serverId: "research", serverName: "Research", description: null, mode: "proxy", routePath: "/mcp/research",
  upstreamUrl: "https://example.com/mcp", upstreamAuthType: "bearer", upstreamAuthName: null, upstreamAuthConfigured: true,
  credentialScope: "organization", transportKind: "http", enabled: true, isAllowed: true, isPublished: false,
  version: 2, configHash: hashA, connectionTest: null } as AdminMcpServer;
const result: AdminMcpConnectionTest = { serverId: "research", configVersion: 2, configHash: hashA,
  checkedAt: "2026-09-26T12:00:00Z", credentialScope: "organization", testedUserId: null,
  reachability: "reachable", authentication: "accepted", toolDiscovery: "succeeded", toolCount: 3,
  message: "Connection and discovery succeeded." };
beforeEach(() => { vi.resetAllMocks(); auth.user = { tenantId: "tenant-a", userId: "admin-a" }; vi.mocked(testAdminMcpConnection).mockResolvedValue(result); });
afterEach(cleanup);

it("tests the saved version once and reports discovery without running tools", async () => {
  let finish!: (value: AdminMcpConnectionTest) => void;
  vi.mocked(testAdminMcpConnection).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  render(<AdminMcpConnectionTestCard server={server} unsavedChanges={false} />);
  const button = screen.getByRole("button", { name: "Test saved version 2" });
  button.focus();
  fireEvent.click(button); fireEvent.click(button);
  expect(testAdminMcpConnection).toHaveBeenCalledExactlyOnceWith("research", { expectedVersion: 2, expectedConfigHash: hashA });
  expect(screen.getByRole("status").textContent).toContain("tool discovery");
  finish(result);
  expect(await screen.findByRole("heading", { name: "Organization connection check" })).toBeTruthy();
  expect(screen.getByText("Succeeded · 3 tools seen")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Organization connection check" })));
  expect(screen.getByText("Discovery only. No tools run.")).toBeTruthy();
});

it("blocks a test while the saved connection has unsaved edits", () => {
  render(<AdminMcpConnectionTestCard server={server} unsavedChanges />);
  expect((screen.getByRole("button", { name: "Test saved version 2" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Save or discard your edits/)).toBeTruthy();
  expect(testAdminMcpConnection).not.toHaveBeenCalled();
});

it("does not show a late check for an older config hash", async () => {
  let finish!: (value: AdminMcpConnectionTest) => void;
  vi.mocked(testAdminMcpConnection).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<AdminMcpConnectionTestCard server={server} unsavedChanges={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Test saved version 2" }));
  view.rerender(<AdminMcpConnectionTestCard server={{ ...server, configHash: hashB }} unsavedChanges={false} />);
  finish(result);
  await waitFor(() => expect(screen.queryByRole("heading", { name: "Organization connection check" })).toBeNull());
  expect(screen.getByText("Test needed for saved version 2.")).toBeTruthy();
});

it("shows only this admin's personal credential result", async () => {
  const personal = { ...server, credentialScope: "personal" as const,
    connectionTest: { ...result, credentialScope: "personal" as const, testedUserId: "other-admin" } };
  const view = render(<AdminMcpConnectionTestCard server={personal} unsavedChanges={false} />);
  expect(screen.getByText("Test needed for saved version 2.")).toBeTruthy();
  expect(screen.getByText(/Each member needs their own credential/)).toBeTruthy();
  view.rerender(<AdminMcpConnectionTestCard server={{ ...personal, connectionTest: { ...personal.connectionTest, testedUserId: "admin-a" } }} unsavedChanges={false} />);
  expect(screen.getByRole("heading", { name: "Your credential check" })).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "Organization connection check" })).toBeNull();
});

it("keeps an organization result when the list refetches during and after the test", async () => {
  let finish!: (value: AdminMcpConnectionTest) => void;
  vi.mocked(testAdminMcpConnection).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const view = render(<AdminMcpConnectionTestCard server={server} listGeneration={100} unsavedChanges={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Test saved version 2" }));
  // Another query, such as quick jump, refetches the list before the test finishes.
  view.rerender(<AdminMcpConnectionTestCard server={server} listGeneration={101} unsavedChanges={false} />);
  finish(result);
  expect(await screen.findByRole("heading", { name: "Organization connection check" })).toBeTruthy();
  view.rerender(<AdminMcpConnectionTestCard server={server} listGeneration={102} unsavedChanges={false} />);
  expect(screen.getByRole("heading", { name: "Organization connection check" })).toBeTruthy();
});

it("keeps a personal result that finishes after a list refetch", async () => {
  let finish!: (value: AdminMcpConnectionTest) => void;
  vi.mocked(testAdminMcpConnection).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  const personal = { ...server, credentialScope: "personal" as const, connectionTest: null };
  const view = render(<AdminMcpConnectionTestCard server={personal} listGeneration={100} unsavedChanges={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Test saved version 2" }));
  view.rerender(<AdminMcpConnectionTestCard server={personal} listGeneration={101} unsavedChanges={false} />);
  finish({ ...result, credentialScope: "personal", testedUserId: "admin-a" });
  expect(await screen.findByRole("heading", { name: "Your credential check" })).toBeTruthy();
});

it("drops a local personal success when a fresh server list has no check", async () => {
  const personal = { ...server, credentialScope: "personal" as const, connectionTest: null };
  vi.mocked(testAdminMcpConnection).mockResolvedValue({ ...result, credentialScope: "personal", testedUserId: "admin-a" });
  const view = render(<AdminMcpConnectionTestCard server={personal} listGeneration={100} unsavedChanges={false} />);
  fireEvent.click(screen.getByRole("button", { name: "Test saved version 2" }));
  expect(await screen.findByRole("heading", { name: "Your credential check" })).toBeTruthy();
  view.rerender(<AdminMcpConnectionTestCard server={personal} listGeneration={101} unsavedChanges={false} />);
  expect(screen.queryByRole("heading", { name: "Your credential check" })).toBeNull();
  expect(screen.getByText("Test needed for saved version 2.")).toBeTruthy();
});

it("hides a previous check when access is denied and offers a safe error", async () => {
  vi.mocked(testAdminMcpConnection).mockRejectedValue(new ApiError({ status: 403, code: "forbidden", method: "POST",
    path: "/admin/mcp-servers/research/connection-test", message: "Internal provider detail" }));
  render(<AdminMcpConnectionTestCard server={{ ...server, connectionTest: result }} unsavedChanges={false} />);
  const button = screen.getByRole("button", { name: "Test saved version 2" });
  button.focus(); fireEvent.click(button);
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("no longer have access"));
  expect(screen.queryByRole("heading", { name: "Organization connection check" })).toBeNull();
  expect(screen.queryByText("Internal provider detail")).toBeNull();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
});
