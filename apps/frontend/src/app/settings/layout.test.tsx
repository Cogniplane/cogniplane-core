// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { NavigationItem } from "@cogniplane/shared-types";

import SettingsLayout from "./layout";
import { listSettingsLiveSections, listSettingsNavigationItems } from "./settings-sections";

// The layout picks the section and the counts. Data hooks, the auth guard, and
// the two chrome components are boundaries: they fetch or have their own tests.
const state = vi.hoisted(() => ({
  pathname: "/settings",
  scheduledJobsCount: 0,
  updates: { isError: false, data: undefined as { unreadCount: number } | undefined },
  user: null as { tenantId: string; userId: string } | null,
  updatesScope: undefined as unknown,
  navigation: undefined as { activeSectionId: string; navigationItems: (NavigationItem & { count?: number })[] } | undefined,
  header: undefined as { title: string; subtitle?: string } | undefined
}));

vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("../../overlays", () => ({}));
vi.mock("../../lib/auth-guard", () => ({ AuthGuard: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("../../lib/auth-context", () => ({ useAuth: () => ({ user: state.user }) }));
vi.mock("../../hooks/use-enabled-settings-sections", async () => {
  const sections = await import("./settings-sections");
  return {
    useEnabledSettingsSections: () => ({
      liveSections: sections.listSettingsLiveSections(),
      navigationItems: sections.listSettingsNavigationItems()
    })
  };
});
vi.mock("../../hooks/use-settings-overview-data", () => ({
  useSettingsOverviewData: () => ({ scheduledJobsCount: state.scheduledJobsCount })
}));
vi.mock("../../hooks/use-skill-updates", () => ({
  useSkillUpdates: (scope: unknown) => {
    state.updatesScope = scope;
    return state.updates;
  }
}));
vi.mock("../../components/console-navigation", () => ({
  ConsoleNavigation: (props: NonNullable<typeof state.navigation>) => {
    state.navigation = props;
    return null;
  }
}));
vi.mock("../../components/console-page-header", () => ({
  ConsolePageHeader: (props: NonNullable<typeof state.header>) => {
    state.header = props;
    return null;
  }
}));

beforeEach(() => {
  state.pathname = "/settings";
  state.scheduledJobsCount = 0;
  state.updates = { isError: false, data: undefined };
  state.user = null;
  // Reset what the mocks capture, so a missing render cannot reuse an earlier value.
  state.updatesScope = undefined;
  state.navigation = undefined;
  state.header = undefined;
});
afterEach(cleanup);

const section = (id: string) => listSettingsLiveSections().find((entry) => entry.id === id)!;
const countOf = (id: string) => state.navigation!.navigationItems.find((item) => item.id === id)?.count;

it("defaults to Connected accounts and renders the page", () => {
  render(<SettingsLayout><p>page body</p></SettingsLayout>);

  expect(screen.getByText("page body")).toBeTruthy();
  expect(state.navigation!.activeSectionId).toBe("connections");
  expect(state.header).toMatchObject({ title: "Connected accounts", subtitle: section("connections").subtitle });
});

it("selects the section that the path names, including nested pages", () => {
  state.pathname = "/settings/scheduled-jobs/job-1";
  render(<SettingsLayout>{null}</SettingsLayout>);

  expect(state.navigation!.activeSectionId).toBe("scheduled-jobs");
  expect(state.header).toMatchObject({ title: "Scheduled jobs", subtitle: section("scheduled-jobs").subtitle });
});

it("keeps Connected accounts selected in the menu for an integration page, but titles the page after it", () => {
  state.pathname = "/settings/notion";
  render(<SettingsLayout>{null}</SettingsLayout>);

  expect(state.navigation!.activeSectionId).toBe("connections");
  expect(state.header).toMatchObject({ title: "Notion", subtitle: section("notion").subtitle });
});

it("shows the scheduled job count and the unread skill update count in the menu", () => {
  state.user = { tenantId: "t1", userId: "u1" };
  state.scheduledJobsCount = 3;
  state.updates = { isError: false, data: { unreadCount: 2 } };
  render(<SettingsLayout>{null}</SettingsLayout>);

  expect(state.updatesScope).toEqual({ tenantId: "t1", userId: "u1" });
  expect(countOf("scheduled-jobs")).toBe(3);
  expect(countOf("skill-updates")).toBe(2);
  // Other items carry no count, and the menu keeps every item in order.
  expect(countOf("connections")).toBeUndefined();
  expect(state.navigation!.navigationItems.map((item) => item.id)).toEqual(listSettingsNavigationItems().map((item) => item.id));
});

it.each([
  ["nothing is unread", { isError: false, data: { unreadCount: 0 } }],
  ["the updates failed to load", { isError: true, data: { unreadCount: 5 } }]
])("hides the skill update count when %s", (_case, updates) => {
  state.updates = updates;
  render(<SettingsLayout>{null}</SettingsLayout>);

  expect(countOf("skill-updates")).toBeUndefined();
  // Signed out, the updates query gets no scope.
  expect(state.updatesScope).toBeNull();
});
