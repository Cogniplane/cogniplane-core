// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  disconnect: vi.fn(),
  selectionEnabled: vi.fn()
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("../../../hooks/use-jira-connection", () => ({
  useJiraConnection: () => ({
    status: {
      configured: true,
      tenantEnabled: false,
      tenantReadsEnabled: false,
      authorizationStarted: true,
      cleanupPending: false,
      userConnection: {
        accountId: "apn_1",
        accountName: null,
        site: { siteId: "11111111-2222-4333-8444-555555555555", name: "Acme", url: "https://acme.atlassian.net" },
        connectedAt: "2026-09-30T12:00:00Z",
        updatedAt: "2026-09-30T12:00:00Z"
      }
    },
    busyKey: null,
    error: null,
    connect: vi.fn(),
    disconnect: state.disconnect
  }),
  useJiraAccountSelection: (enabled: boolean) => {
    state.selectionEnabled(enabled);
    return { accounts: [], isLoading: false, error: null, isSaving: false, reload: vi.fn(), loadSites: vi.fn(), select: vi.fn() };
  }
}));

import SettingsJiraPage from "./page";

afterEach(cleanup);

it("shows the connection and disconnect when the organization turned Jira off", () => {
  render(<SettingsJiraPage />);
  expect(screen.getByText("Connected to Acme")).toBeTruthy();
  expect(screen.queryByText(/is not enabled for this tenant/)).toBeNull();
  expect(state.selectionEnabled).toHaveBeenCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
  expect(state.disconnect).toHaveBeenCalled();
});
