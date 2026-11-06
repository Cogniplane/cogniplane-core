// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { GithubConnectionStatus } from "@cogniplane/shared-types";

import { GithubAccountRow, GithubSettingsDetail } from "./github-settings";

const api = vi.hoisted(() => ({
  status: vi.fn(), authorize: vi.fn(), disconnect: vi.fn(), confirm: vi.fn(), repositories: vi.fn(), save: vi.fn()
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../lib/settings-api", () => ({
  fetchGithubConnectionStatus: api.status,
  createGithubAuthorizationUrl: api.authorize,
  deleteGithubConnection: api.disconnect,
  confirmGithubConnection: api.confirm,
  listGithubRepositories: api.repositories,
  updateGithubAllowedRepositories: api.save
}));

const connection: NonNullable<GithubConnectionStatus["userConnection"]> = {
  githubUserId: "12345", githubLogin: "octocat", githubName: null, githubEmail: null, githubAvatarUrl: null,
  scopes: ["repo"], allowedRepositories: ["acme/app"], accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
  connectedAt: "2026-10-01T12:00:00Z", updatedAt: "2026-10-01T12:00:00Z", lastUsedAt: null, suspended: false
};
const active: GithubConnectionStatus = { configured: true, tenantEnabled: true, userConnection: connection };
const suspended: GithubConnectionStatus = { ...active, userConnection: { ...connection, suspended: true } };
const clients: QueryClient[] = [];

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
  return client;
}

beforeEach(() => {
  vi.resetAllMocks();
  api.repositories.mockResolvedValue({ repositories: [], truncated: false });
});
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
});

// q4w0.8: a security change of the owner's account suspended the connection.
it("shows a suspended connection, lists no repositories, and confirms the account on the page", async () => {
  api.status.mockResolvedValue(suspended);
  api.confirm.mockImplementationOnce(async () => {
    api.status.mockResolvedValue(active);
    return connection;
  });
  mount(<GithubSettingsDetail />);
  await screen.findByText("Suspended because your account security changed");
  expect(screen.getByText(/Confirm only if you connected the GitHub account octocat yourself/)).toBeTruthy();
  expect(screen.getByText("The agent may use these repositories after you confirm: acme/app.")).toBeTruthy();
  // The backend does not use a suspended token, so the page does not ask GitHub for repositories.
  expect(api.repositories).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole("button", { name: "Confirm connection" }));
  await screen.findByText("connected");
  expect(api.confirm).toHaveBeenCalledWith("12345");
  expect(screen.queryByText("Suspended because your account security changed")).toBeNull();
  expect(api.repositories).toHaveBeenCalled();
});

it("labels a suspended connection in the connected accounts list", async () => {
  api.status.mockResolvedValue(suspended);
  mount(<ul><GithubAccountRow /></ul>);
  await screen.findByText("Suspended");
  expect(screen.getByText("Your account security changed. Open Details to review this connection.")).toBeTruthy();
  cleanup();

  api.status.mockResolvedValue(active);
  mount(<ul><GithubAccountRow /></ul>);
  await screen.findByText("Connected");
  expect(screen.queryByText(/Open Details to confirm/)).toBeNull();
});


it("retries a failed status read without clearing a repository draft or starting authorization", async () => {
  api.status.mockResolvedValue(active);
  const client = mount(<GithubSettingsDetail />);
  await screen.findByRole("heading", { name: "Authorized as octocat" });
  fireEvent.change(screen.getByRole("textbox", { name: "Add a repository by name" }), { target: { value: "acme/new-research" } });
  fireEvent.click(screen.getByRole("button", { name: "Add by name" }));
  api.status.mockRejectedValueOnce(new Error("Status refresh unavailable"));
  await act(async () => { await client.invalidateQueries({ queryKey: ["settings", "github"], exact: true }); });
  await screen.findByText("Status refresh unavailable");
  expect((screen.getByRole("checkbox", { name: "acme/new-research" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry status" }));
  await screen.findByRole("button", { name: "Reconnect GitHub" });
  expect((screen.getByRole("checkbox", { name: "acme/new-research" }) as HTMLInputElement).checked).toBe(true);
  expect(api.authorize).not.toHaveBeenCalled();
  expect(api.confirm).not.toHaveBeenCalled();
  expect(api.save).not.toHaveBeenCalled();
});
