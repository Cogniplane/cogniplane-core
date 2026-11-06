// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MicrosoftConnectionStatus } from "../../../../private/sharepoint-overlay-contracts/src/index";
import SettingsMicrosoftPage from "../../../../private/sharepoint-overlay-frontend/src/pages/microsoft-settings";

const api = vi.hoisted(() => ({ status: vi.fn(), authorize: vi.fn(), disconnect: vi.fn(), confirm: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../../../../private/sharepoint-overlay-frontend/src/lib/settings-api", () => ({ fetchMicrosoftConnectionStatus: api.status, createMicrosoftAuthorizationUrl: api.authorize, deleteMicrosoftConnection: api.disconnect, confirmMicrosoftConnection: api.confirm }));
const status: MicrosoftConnectionStatus = { configured: true, tenantEnabled: true, userConnection: { microsoftUserId: "sample-ms-user", microsoftEmail: "sample@example.test", microsoftDisplayName: "Sample member", scopes: [], connectedAt: "2026-11-01T12:00:00Z", updatedAt: "2026-11-01T12:00:00Z", lastUsedAt: null, accessTokenExpiresAt: null, refreshTokenExpiresAt: null, suspended: false } };
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><SettingsMicrosoftPage /></QueryClientProvider>);
}
beforeEach(() => { vi.resetAllMocks(); api.status.mockResolvedValue(status); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("loads a direct Microsoft detail URL without a false negative and retries its status read", async () => {
  let reject!: (reason: Error) => void;
  api.status.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
  mount();
  expect(screen.getByRole("status").textContent).toContain("Checking your connection");
  expect(screen.queryByText(/not connected|not configured/)).toBeNull();
  await act(async () => reject(new Error("Sample status failure")));
  expect((await screen.findByRole("alert")).textContent).toContain("Sample status failure");
  fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
  await screen.findByText("sample@example.test");
  expect(api.authorize).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
});

it("keeps disabled Microsoft removal reachable and stops new authorization", async () => {
  api.status.mockResolvedValueOnce({ ...status, tenantEnabled: false });
  api.disconnect.mockImplementationOnce(async () => { api.status.mockResolvedValue({ ...status, tenantEnabled: false, userConnection: null }); });
  mount();
  await screen.findByText("Microsoft 365 is disabled by your organization");
  expect(screen.getByText("sample@example.test")).toBeTruthy();
  expect((screen.getByRole("button", { name: "Reconnect my account" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  await screen.findByText("Microsoft 365 not connected");
  expect(api.disconnect).toHaveBeenCalledOnce();
  expect(api.authorize).not.toHaveBeenCalled();
});

it("confirms the attested Microsoft account on the page once and reloads after a refusal", async () => {
  api.status.mockResolvedValue({ ...status, userConnection: { ...status.userConnection!, suspended: true } });
  api.confirm.mockRejectedValue(new Error("Sample account changed"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Confirm connection" }));
  await screen.findByText("Sample account changed");
  expect(api.confirm).toHaveBeenCalledOnce();
  expect(api.confirm.mock.calls[0][0]).toBe("sample-ms-user");
  expect(screen.getByText("Suspended because your account security changed")).toBeTruthy();
  expect(api.status.mock.calls.length).toBeGreaterThan(1);
});
