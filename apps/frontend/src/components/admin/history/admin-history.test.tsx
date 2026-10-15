// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AdminHistoryEvent } from "@cogniplane/shared-types";
import { AdminHistoryPage } from "./admin-history-page";
import { LastAdminChange, RecentAdminChanges } from "./history-widgets";
import { getAdminHistoryEvent, listAdminHistory } from "../../../lib/admin-history-api";
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/history", useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => navigation }));
vi.mock("../../../lib/admin-history-api", () => ({ listAdminHistory: vi.fn(), getAdminHistoryEvent: vi.fn() }));
const event: AdminHistoryEvent = { eventId: "9007199254740993", type: "admin.tenant_settings.updated", category: "settings", title: "Organization settings saved", createdAt: "2026-09-27T12:00:00.000001Z", actor: { userId: "alex", name: "Alex" }, details: [], target: { label: "Open agent behavior", href: "/admin/capabilities" }, settingsVersion: 4 };
function mount(component = <AdminHistoryPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return { ...view, client };
}
beforeEach(() => { navigation.search = ""; vi.mocked(listAdminHistory).mockResolvedValue({ items: [event], nextCursor: null }); vi.mocked(getAdminHistoryEvent).mockResolvedValue({ event, comparison: null }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
test("opens records through shareable links and changes filters without a form", async () => {
  mount();
  expect((await screen.findByRole("link", { name: /Organization settings saved/ })).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  fireEvent.click(screen.getByRole("button", { name: "People" }));
  expect(navigation.replace).toHaveBeenCalledWith("/admin/history?category=people", { scroll: false });
});
test("retains loaded records after an older-page failure and retries the cursor", async () => {
  vi.mocked(listAdminHistory).mockResolvedValueOnce({ items: [event], nextCursor: "next" }).mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce({ items: [{ ...event, eventId: "2", title: "Older settings" }], nextCursor: null });
  mount(); fireEvent.click(await screen.findByRole("button", { name: "Load older changes" }));
  const retry = await screen.findByRole("button", { name: "Retry older changes" });
  expect(screen.getByRole("link", { name: /Organization settings saved/ })).toBeTruthy();
  fireEvent.click(retry); expect(await screen.findByRole("link", { name: /Older settings/ })).toBeTruthy();
  expect(vi.mocked(listAdminHistory).mock.calls.at(-1)?.[0]?.cursor).toBe("next");
});
test("loads a direct record link and exposes the first-snapshot state without invented values", async () => {
  navigation.search = `event=${event.eventId}`;
  mount(); expect(await screen.findByText(/This is the first recorded settings snapshot/)).toBeTruthy();
  expect(getAdminHistoryEvent).toHaveBeenCalledWith(event.eventId, undefined, expect.any(AbortSignal));
  expect(screen.getByRole("dialog")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(navigation.replace).toHaveBeenCalledWith("/admin/history", { scroll: false });
});
test("selects a comparison using the URL and retains explicit record IDs", async () => {
  navigation.search = `category=settings&event=${event.eventId}`;
  vi.mocked(listAdminHistory).mockResolvedValue({ items: [event, { ...event, eventId: "2", settingsVersion: 1 }], nextCursor: null });
  mount(); const picker = await screen.findByLabelText("Compare with");
  await waitFor(() => expect((picker as HTMLSelectElement).disabled).toBe(false));
  fireEvent.change(picker, { target: { value: "2" } });
  expect(navigation.replace).toHaveBeenCalledWith(`/admin/history?category=settings&event=${event.eventId}&compareTo=2`, { scroll: false });
});
test("recent and latest-record links lead to history; failed refresh hides a stale latest claim", async () => {
  const { client } = mount(<><RecentAdminChanges /><LastAdminChange section="agent" /></>);
  expect((await screen.findByRole("link", { name: /Last recorded settings save/ })).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  expect(screen.getByRole("link", { name: "Organization settings saved" }).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  expect(screen.getByRole("link", { name: "View history" }).getAttribute("href")).toBe("/admin/history");
  vi.mocked(listAdminHistory).mockRejectedValue(new Error("Offline"));
  await client.invalidateQueries();
  expect(await screen.findByText("Could not check change history.")).toBeTruthy();
  expect(screen.queryByRole("link", { name: /Last recorded settings save/ })).toBeNull();
  expect(screen.getByText("Could not load recent changes.").getAttribute("role")).toBe("alert");
});

test("renders before and after values separately from incomplete historical fields", async () => {
  navigation.search = `event=${event.eventId}`;
  vi.mocked(getAdminHistoryEvent).mockResolvedValue({ event, comparison: {
    before: { eventId: "1", version: 1, createdAt: event.createdAt, actorName: "Sam" },
    after: { eventId: event.eventId, version: 4, createdAt: event.createdAt, actorName: "Alex" },
    unchangedCount: 2, changes: [
      { field: "allowCommandExecution", label: "Command execution", before: "Off", after: "On", status: "changed" },
      { field: "defaultModelId", label: "Default model", before: "Not recorded", after: "No organization default", status: "unavailable" }
    ]
  } });
  mount(); expect(await screen.findByText("1 setting changed")).toBeTruthy();
  expect(screen.getByText("Off")).toBeTruthy(); expect(screen.getByText("On")).toBeTruthy();
  fireEvent.click(screen.getByText("1 setting cannot be compared completely"));
  expect(screen.getByText("Not recorded")).toBeTruthy();
  expect(screen.getByText("No organization default")).toBeTruthy();
});
