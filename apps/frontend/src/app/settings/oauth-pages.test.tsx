// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  params: new URLSearchParams(),
  github: {
    status: null as null | Record<string, unknown>,
    busyKey: null as "connect" | "disconnect" | null,
    error: null as string | null,
    connect: vi.fn(),
    disconnect: vi.fn()
  },
  notion: {
    status: null as null | Record<string, unknown>,
    busyKey: null as "connect" | "disconnect" | null,
    error: null as string | null,
    connect: vi.fn(),
    disconnect: vi.fn()
  }
}));

vi.mock("next/navigation", () => ({ useSearchParams: () => state.params }));
vi.mock("../../hooks/use-github-connection", () => ({
  useGithubConnection: () => state.github
}));
vi.mock("../../hooks/use-notion-connection", () => ({
  useNotionConnection: () => state.notion
}));

import SettingsGithubPage from "./github/page";
import SettingsNotionPage from "./notion/page";

beforeEach(() => {
  state.params = new URLSearchParams();
  state.github.status = null;
  state.github.busyKey = null;
  state.github.error = null;
  state.notion.status = null;
  state.notion.busyKey = null;
  state.notion.error = null;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe.each([
  {
    provider: "GitHub",
    Page: SettingsGithubPage,
    stateKey: "github" as const,
    param: "githubAuth",
    success: "GitHub personal authorization connected.",
    connectLabel: "Connect GitHub",
    reconnectLabel: "Reconnect GitHub",
    consentText: /read repositories, write files, and open pull requests/,
    notConfiguredText: "GitHub OAuth is not configured on this deployment yet.",
    connectedStatus: {
      configured: true,
      tenantEnabled: true,
      userConnection: {
        githubUserId: "gh-1",
        githubLogin: "octocat",
        githubName: "Octo Cat",
        githubEmail: "octo@example.com",
        githubAvatarUrl: null,
        scopes: ["repo"],
        accessTokenExpiresAt: null,
        refreshTokenExpiresAt: null,
        connectedAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:00.000Z",
        lastUsedAt: null
      }
    },
    identityText: "Authorized as octocat"
  },
  {
    provider: "Notion",
    Page: SettingsNotionPage,
    stateKey: "notion" as const,
    param: "notionAuth",
    success: "Notion account connected successfully.",
    connectLabel: "Connect my Notion account",
    reconnectLabel: "Reconnect my account",
    consentText: /only sees workspaces and pages you grant access/,
    notConfiguredText: /Notion OAuth is not configured on this deployment yet/,
    connectedStatus: {
      configured: true,
      tenantEnabled: true,
      userConnection: {
        notionUserId: "notion-1",
        notionWorkspaceId: "workspace-1",
        notionWorkspaceName: "Product",
        notionWorkspaceIcon: null,
        notionOwnerEmail: "owner@example.com",
        notionOwnerName: "Ada",
        notionOwnerType: "user",
        accessTokenExpiresAt: null,
        connectedAt: "2026-09-04T12:00:00.000Z",
        updatedAt: "2026-09-04T12:00:00.000Z",
        lastUsedAt: null
      }
    },
    identityText: "Connected as Ada in Product"
  }
])("$provider settings page", (testCase) => {
  const { provider, Page, stateKey, param, success } = testCase;

  it("renders the tenant-disabled state", () => {
    state[stateKey].status = { tenantEnabled: false };
    render(<Page />);

    expect(screen.getByRole("heading", { name: provider })).toBeTruthy();
    expect(screen.getByText(new RegExp(`${provider} is not enabled for this tenant`))).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("preserves the provider-specific callback success message", () => {
    state.params = new URLSearchParams({ [param]: "connected" });
    render(<Page />);
    expect(screen.getByText(success)).toBeTruthy();
  });

  it("normalizes the callback error reason", () => {
    state.params = new URLSearchParams({ [param]: "error", reason: "access_denied" });
    render(<Page />);
    expect(screen.getByText(`${provider} authorization failed: access denied.`)).toBeTruthy();
  });

  it("renders provider consent copy and dispatches connect", () => {
    state[stateKey].status = { configured: true, tenantEnabled: true, userConnection: null };
    render(<Page />);

    expect(screen.getByText(testCase.consentText)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: testCase.connectLabel }));
    expect(state[stateKey].connect).toHaveBeenCalledOnce();
  });

  it("renders provider identity and dispatches disconnect", () => {
    state[stateKey].status = testCase.connectedStatus;
    render(<Page />);

    expect(screen.getByRole("heading", { name: testCase.identityText })).toBeTruthy();
    expect(screen.getByRole("button", { name: testCase.reconnectLabel })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(state[stateKey].disconnect).toHaveBeenCalledOnce();
  });

  it("disables an unconfigured connection", () => {
    state[stateKey].status = { configured: false, tenantEnabled: true, userConnection: null };
    render(<Page />);

    expect(
      (screen.getByRole("button", { name: testCase.connectLabel }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect(screen.getByText(testCase.notConfiguredText)).toBeTruthy();
  });

  it("shows the shared busy labels and disables both actions", () => {
    state[stateKey].status = testCase.connectedStatus;
    state[stateKey].busyKey = "connect";
    const { rerender } = render(<Page />);

    expect(
      (screen.getByRole("button", { name: "Redirecting..." }) as HTMLButtonElement).disabled
    ).toBe(true);
    expect((screen.getByRole("button", { name: "Disconnect" }) as HTMLButtonElement).disabled).toBe(
      true
    );

    state[stateKey].busyKey = "disconnect";
    rerender(<Page />);
    expect(
      (screen.getByRole("button", { name: "Disconnecting..." }) as HTMLButtonElement).disabled
    ).toBe(true);
  });

  it("renders connection failures through the shared action presentation", () => {
    state[stateKey].status = { configured: true, tenantEnabled: true, userConnection: null };
    state[stateKey].error = `${provider} connection failed.`;
    render(<Page />);

    expect(screen.getByText(`${provider} connection failed.`)).toBeTruthy();
  });
});
