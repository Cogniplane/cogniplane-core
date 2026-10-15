// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  user: { tenantId: "tenant-a", userId: "user-a" },
  sections: [] as Array<{ id: string; label: string; kind: "integration"; accountRow?: () => React.JSX.Element }>,
  loading: false,
  error: null as string | null,
  retry: vi.fn(),
  github: {
    status: null as null | Record<string, unknown>,
    isLoading: false,
    busyKey: null,
    error: null,
    statusError: null as string | null,
    connect: vi.fn(),
    reload: vi.fn()
  },
  notion: {
    status: null as null | Record<string, unknown>,
    isLoading: false,
    busyKey: null,
    error: null,
    statusError: null as string | null,
    connect: vi.fn(),
    reload: vi.fn()
  },
  jira: {
    status: null as null | Record<string, unknown>,
    isLoading: false,
    busyKey: null,
    error: null,
    statusError: null as string | null,
    connect: vi.fn(),
    reload: vi.fn()
  }
}));

vi.mock("../../../hooks/use-enabled-settings-sections", () => ({
  useEnabledSettingsSections: () => ({
    liveSections: state.sections,
    isLoading: state.loading,
    error: state.error,
    retry: state.retry
  })
}));
vi.mock("../../../hooks/use-github-connection", () => ({ useGithubConnection: () => state.github }));
vi.mock("../../../hooks/use-notion-connection", () => ({ useNotionConnection: () => state.notion }));
vi.mock("../../../hooks/use-jira-connection", () => ({ useJiraConnection: () => state.jira }));
vi.mock("../../../lib/auth-context", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("../../../components/member-mcp-accounts", () => ({ MemberMcpAccounts: ({ expectedScope }: { expectedScope: { tenantId: string; userId: string } }) => <div data-testid="member-mcp">{expectedScope.tenantId}:{expectedScope.userId}</div> }));

import ConnectedAccountsPage from "./page";

beforeEach(() => {
  state.sections = [
    { id: "github", label: "GitHub", kind: "integration" },
    { id: "notion", label: "Notion", kind: "integration" }
  ];
  state.loading = false;
  state.error = null;
  state.github.status = { configured: true, tenantEnabled: true, userConnection: null };
  state.github.isLoading = false;
  state.github.statusError = null;
  state.notion.status = { configured: true, tenantEnabled: true, userConnection: null };
  state.notion.isLoading = false;
  state.notion.statusError = null;
  vi.clearAllMocks();
});

afterEach(cleanup);

describe("Connected accounts landing", () => {
  it("shows only organization-enabled services and starts personal authorization", () => {
    state.sections = [state.sections[0]];
    render(<ConnectedAccountsPage />);

    expect(screen.getByRole("heading", { name: "GitHub" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Notion" })).toBeNull();
    expect(screen.getByText("Not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect GitHub" }));
    expect(state.github.connect).toHaveBeenCalledOnce();
    expect(screen.getByTestId("member-mcp").textContent).toBe("tenant-a:user-a");
  });

  it("shows connected identity, a reconnect action, and a details route", () => {
    state.github.status = {
      configured: true,
      tenantEnabled: true,
      userConnection: { githubLogin: "octocat" }
    };
    render(<ConnectedAccountsPage />);

    expect(screen.getByText(/octocat/)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Reconnect GitHub" }));
    expect(state.github.connect).toHaveBeenCalledOnce();
    expect(screen.getByRole("link", { name: "Details for GitHub" }).getAttribute("href")).toBe("/settings/github");
  });

  it("keeps an overlay service in the same list without adding a core dependency", () => {
    state.sections = [{
      id: "microsoft",
      label: "Microsoft 365",
      kind: "integration",
      accountRow: () => <li>Microsoft personal connection</li>
    }];
    render(<ConnectedAccountsPage />);
    expect(screen.getByText("Microsoft personal connection")).toBeTruthy();
  });

  it("does not show an empty state while availability is loading or has failed", () => {
    state.loading = true;
    state.sections = [];
    const { rerender } = render(<ConnectedAccountsPage />);
    expect(screen.getByRole("status").textContent).toContain("Loading available services");
    expect(screen.queryByText("No built-in account services are enabled for your organization.")).toBeNull();

    state.loading = false;
    state.error = "Could not load available services.";
    rerender(<ConnectedAccountsPage />);
    expect(screen.getByRole("alert").textContent).toContain("Could not load available services.");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.retry).toHaveBeenCalledOnce();
    expect(screen.queryByText("No built-in account services are enabled for your organization.")).toBeNull();
  });

  it("offers retry after a status failure without starting authorization", () => {
    state.sections = [state.sections[0]];
    state.github.statusError = "Could not load GitHub status.";
    render(<ConnectedAccountsPage />);

    expect(screen.getByText("Status unavailable")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect GitHub" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(state.github.reload).toHaveBeenCalledOnce();
    expect(state.github.connect).not.toHaveBeenCalled();
  });

  it("offers Jira authorization only when the organization enabled Jira reads", () => {
    state.sections = [{ id: "jira", label: "Jira", kind: "integration" }];
    // Writes alone make Jira available, but authorization requires reads.
    state.jira.status = {
      configured: true, tenantEnabled: true, tenantReadsEnabled: false, tenantWritesEnabled: true, userConnection: null
    };
    const { rerender } = render(<ConnectedAccountsPage />);
    expect(screen.getByText("Not available")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Connect Jira" }) as HTMLButtonElement).disabled).toBe(true);

    state.jira.status = { ...state.jira.status, tenantReadsEnabled: true, tenantWritesEnabled: false };
    rerender(<ConnectedAccountsPage />);
    expect(screen.getByText("Not connected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Connect Jira" }));
    expect(state.jira.connect).toHaveBeenCalledOnce();
  });

  it("does not claim a saved identity is usable when setup is unavailable", () => {
    state.sections = [state.sections[0]];
    state.github.status = {
      configured: false,
      tenantEnabled: true,
      userConnection: { githubLogin: "octocat" }
    };
    render(<ConnectedAccountsPage />);

    expect(screen.getByText("Not available")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Reconnect GitHub" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
