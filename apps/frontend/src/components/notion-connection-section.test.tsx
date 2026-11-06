// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NotionConnectionStatus } from "@cogniplane/shared-types";
import { useNotionConnection } from "../hooks/use-notion-connection";
import { NotionConnectionSection } from "./notion-connection-section";

const api = vi.hoisted(() => ({ status: vi.fn(), authorize: vi.fn(), disconnect: vi.fn(), confirm: vi.fn() }));
vi.mock("../lib/settings-api", () => ({
  fetchNotionConnectionStatus: api.status,
  createNotionAuthorizationUrl: api.authorize,
  deleteNotionConnection: api.disconnect,
  confirmNotionConnection: api.confirm
}));
const connected: NotionConnectionStatus = {
  configured: true,
  userConnection: {
    notionUserId: "notion-1", notionWorkspaceId: "workspace-1", notionWorkspaceName: "Team wiki",
    notionWorkspaceIcon: null, notionOwnerEmail: "alex@example.com", notionOwnerName: "Alex",
    scopes: [], accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
    connectedAt: "2026-09-21T12:00:00Z", updatedAt: "2026-09-21T12:00:00Z", lastUsedAt: null,
    suspended: false
  }
};
const clients: QueryClient[] = [];
function Connection() {
  const connection = useNotionConnection();
  return <NotionConnectionSection {...connection} flashMessage={null}
    onConnect={() => void connection.connect()} onDisconnect={connection.disconnect} onConfirm={connection.confirm} />;
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><Connection /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); api.status.mockResolvedValue(connected); });
afterEach(() => {
  cleanup();
  clients.splice(0).forEach(client => client.clear());
  window.history.replaceState(null, "", "/");
});

it("disables authorization until the deployment is configured", async () => {
  api.status.mockResolvedValue({ configured: false, userConnection: null });
  mount();
  await screen.findByText("Notion not configured");
  const connect = screen.getByRole("button", { name: "Connect my Notion account" });
  expect((connect as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(connect);
  expect(api.authorize).not.toHaveBeenCalled();
  expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
});

it("shows connection identity and retains it after a failed disconnect, then retries", async () => {
  let reject!: (reason: Error) => void;
  api.disconnect.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  api.disconnect.mockImplementationOnce(async () => {
    api.status.mockResolvedValue({ configured: true, userConnection: null });
  });
  mount();
  await screen.findByText("Connected as Alex in Team wiki");
  expect(screen.getByText("alex@example.com")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByRole("button", { name: "Disconnecting..." });
  expect((screen.getByRole("button", { name: "Reconnect my account" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Disconnecting..." }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => reject(new Error("Disconnect unavailable")));
  await screen.findByText("Disconnect unavailable");
  expect(screen.getByText("Connected as Alex in Team wiki")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByText("Notion not connected");
  expect(screen.queryByText("Disconnect unavailable")).toBeNull();
  expect(screen.queryByText("alex@example.com")).toBeNull();
  expect(api.disconnect).toHaveBeenCalledTimes(2);
});

it("blocks duplicate authorization and recovers from an authorization failure", async () => {
  let reject!: (reason: Error) => void;
  api.authorize.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect my account" }));
  const redirect = await screen.findByRole("button", { name: "Redirecting..." });
  expect((redirect as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(redirect);
  expect(api.authorize).toHaveBeenCalledTimes(1);
  await act(async () => reject(new Error("Authorization unavailable")));
  await screen.findByText("Authorization unavailable");
  expect((screen.getByRole("button", { name: "Reconnect my account" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows a status failure without enabling authorization", async () => {
  api.status.mockRejectedValue(new Error("Status unavailable"));
  mount();
  await screen.findByText("Status unavailable");
  expect(screen.queryByRole("button", { name: "Connect my Notion account" })).toBeNull();
  expect(screen.getByRole("alert").textContent).toContain("Status unavailable");
});

it("navigates to the returned authorization URL and keeps actions disabled", async () => {
  // A same-document URL exercises navigation without jsdom's unsupported page load.
  api.authorize.mockResolvedValue(`${window.location.origin}/#notion-consent`);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Reconnect my account" }));
  const redirect = await screen.findByRole("button", { name: "Redirecting..." });
  expect(window.location.hash).toBe("#notion-consent");
  expect((redirect as HTMLButtonElement).disabled).toBe(true);
});

// q4w0.8: a security change of the owner's account suspended the connection.
it("shows a suspended connection and confirms it for the account on the page", async () => {
  const suspended = { ...connected, userConnection: { ...connected.userConnection!, suspended: true } };
  api.status.mockResolvedValue(suspended);
  api.confirm.mockImplementationOnce(async () => {
    api.status.mockResolvedValue(connected);
    return connected.userConnection;
  });
  mount();
  await screen.findByText("Suspended because your account security changed");
  expect(screen.getByText("suspended")).toBeTruthy();
  // Notion attests the email. The display name is not unique, so the notice does not lead with it.
  expect(screen.getByText(/Confirm only if you connected the Notion account alex@example\.com yourself/)).toBeTruthy();
  expect(screen.queryByText(/Notion account Alex/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
  await screen.findByText("connected");
  expect(api.confirm).toHaveBeenCalledWith({ notionUserId: "notion-1", notionWorkspaceId: "workspace-1" });
  expect(screen.queryByText("Suspended because your account security changed")).toBeNull();
});

// q4w0.8 review: Notion returned no owner email. The user ID and the workspace
// name prove nothing (the workspace owner chooses the name), so there is no confirm.
it("offers no confirm for a suspended connection without an owner email", async () => {
  api.status.mockResolvedValue({ ...connected,
    userConnection: { ...connected.userConnection!, notionOwnerEmail: null, suspended: true } });
  mount();
  await screen.findByText("Suspended because your account security changed");
  expect(screen.getByText(/The agent does not use this connection\. Connect again, or disconnect it\./)).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Confirm connection" })).toBeNull();
  expect(screen.getByRole("button", { name: "Reconnect my account" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disconnect" })).toBeTruthy();
  expect(api.confirm).not.toHaveBeenCalled();
});

it("keeps the suspended notice and shows the error when the confirm fails", async () => {
  api.status.mockResolvedValue({ ...connected, userConnection: { ...connected.userConnection!, suspended: true } });
  api.confirm.mockRejectedValueOnce(new Error("The connected Notion account changed."));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm connection" }));
  await screen.findByText("The connected Notion account changed.");
  expect(screen.getByText("Suspended because your account security changed")).toBeTruthy();
  // The status reloads after a failed confirm: the account can have changed.
  expect(api.status.mock.calls.length).toBeGreaterThan(1);
});
