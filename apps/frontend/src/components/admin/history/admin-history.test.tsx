// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { AdminHistoryEvent } from "@cogniplane/shared-types";
import { AdminHistoryPage } from "./admin-history-page";
import { LastAdminChange, RecentAdminChanges } from "./history-widgets";
import { getAdminHistoryEvent, listAdminHistory } from "../../../lib/admin-history-api";
import { ApiError } from "../../../lib/api-client";
import { cloneElement } from "react";
const navigation = vi.hoisted(() => ({ search: "", replace: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => "/admin/history", useSearchParams: () => new URLSearchParams(navigation.search), useRouter: () => navigation }));
vi.mock("../../../lib/admin-history-api", () => ({ listAdminHistory: vi.fn(), getAdminHistoryEvent: vi.fn() }));
const event: AdminHistoryEvent = { eventId: "9007199254740993", type: "admin.tenant_settings.updated", category: "settings", title: "Organization settings saved", createdAt: "2026-09-27T12:00:00.000001Z", actor: { userId: "alex", name: "Alex" }, details: [], target: { label: "Open agent behavior", href: "/admin/capabilities" }, settingsVersion: 4 };
function mount(component = <AdminHistoryPage />) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const view = render(<QueryClientProvider client={client}>{component}</QueryClientProvider>);
  return { ...view, client, refresh: () => view.rerender(<QueryClientProvider client={client}>{cloneElement(component)}</QueryClientProvider>) };
}
beforeEach(() => { navigation.search = ""; vi.mocked(listAdminHistory).mockResolvedValue({ items: [event], nextCursor: null }); vi.mocked(getAdminHistoryEvent).mockResolvedValue({ event, comparison: null }); });
afterEach(() => { cleanup(); vi.resetAllMocks(); });
test("opens records through shareable links and changes filters without a form", async () => {
  mount();
  expect((await screen.findByRole("link", { name: /Organization settings saved/ })).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  fireEvent.click(screen.getByRole("button", { name: "People" }));
  expect(navigation.replace).toHaveBeenCalledWith("/admin/history?category=people", { scroll: false });
});

test("keeps the version picker and record while the selected comparison loads and fails", async () => {
  navigation.search = `event=${event.eventId}`;
  let rejectComparison!: (reason: Error) => void;
  vi.mocked(getAdminHistoryEvent).mockImplementation(async (_id, compareTo) => {
    if (compareTo) return new Promise((_resolve, reject) => { rejectComparison = reject; });
    return { event, comparison: {
      before: { eventId: "1", version: 1, createdAt: event.createdAt, actorName: "Sam" },
      after: { eventId: event.eventId, version: 4, createdAt: event.createdAt, actorName: "Alex" },
      unchangedCount: 0, changes: [{ field: "allowCommandExecution", label: "Command execution", before: "Old comparison value", after: "On", status: "changed" }]
    } };
  });
  const view = mount();
  const picker = await screen.findByLabelText("Compare with");
  expect(screen.getByText("Old comparison value")).toBeTruthy();
  navigation.search += "&compareTo=2";
  view.refresh();
  expect(await screen.findByText("Loading comparison...")).toBeTruthy();
  expect(screen.getByLabelText("Compare with")).toBe(picker);
  expect(screen.queryByText(/This is the first recorded settings snapshot/)).toBeNull();
  expect(screen.queryByText("Old comparison value")).toBeNull();
  await act(async () => rejectComparison(new ApiError({ message: "Unavailable", status: 404, method: "GET", path: "/admin/history" })));
  expect(await screen.findByText(/Could not load the selected comparison/)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Open agent behavior" })).toBeTruthy();
  expect(screen.getByLabelText("Compare with")).toBe(picker);
  fireEvent.click(screen.getByRole("button", { name: "Use previous record" }));
  expect(navigation.replace).toHaveBeenCalledWith(`/admin/history?event=${event.eventId}`, { scroll: false });
});

test("keeps the initial failure retry mounted and deduplicates retries in a real query client", async () => {
  let resolve!: (value: { items: AdminHistoryEvent[]; nextCursor: null }) => void;
  vi.mocked(listAdminHistory).mockRejectedValueOnce(new Error("Offline"))
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry history" });
  fireEvent.click(retry);
  fireEvent.click(retry);
  expect(screen.getByRole("button", { name: "Retry history" })).toBe(retry);
  await waitFor(() => expect(retry.hasAttribute("disabled")).toBe(true));
  expect(listAdminHistory).toHaveBeenCalledTimes(2);
  await act(async () => resolve({ items: [event], nextCursor: null }));
  expect(await screen.findByRole("link", { name: /Organization settings saved/ })).toBeTruthy();
});

test("keeps loaded version options after an older-version error and retries the same cursor", async () => {
  navigation.search = `event=${event.eventId}`;
  let failed = false;
  vi.mocked(listAdminHistory).mockImplementation(async filters => {
    if (filters?.category !== "settings") return { items: [event], nextCursor: null };
    if (!filters.cursor) return { items: [{ ...event, eventId: "2", settingsVersion: 2 }], nextCursor: "older-versions" };
    if (!failed) { failed = true; throw new Error("Offline"); }
    return { items: [{ ...event, eventId: "1", settingsVersion: 1 }], nextCursor: null };
  });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Load older versions" }));
  expect(await screen.findByText(/Could not load older versions/)).toBeTruthy();
  expect(screen.getByRole("option", { name: /Version 2/ })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry older versions" }));
  expect(await screen.findByRole("option", { name: /Version 1/ })).toBeTruthy();
  expect(vi.mocked(listAdminHistory).mock.calls.at(-1)?.[0]?.cursor).toBe("older-versions");
});

test("deduplicates rapid older-page requests without aborting the pending page", async () => {
  let resolve!: (value: { items: AdminHistoryEvent[]; nextCursor: null }) => void;
  vi.mocked(listAdminHistory).mockResolvedValueOnce({ items: [event], nextCursor: "next" })
    .mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  mount();
  const load = await screen.findByRole("button", { name: "Load older changes" });
  fireEvent.click(load); fireEvent.click(load);
  expect(listAdminHistory).toHaveBeenCalledTimes(2);
  expect(vi.mocked(listAdminHistory).mock.calls.at(-1)?.[1]?.aborted).toBe(false);
  await act(async () => resolve({ items: [{ ...event, eventId: "1", title: "Older settings" }], nextCursor: null }));
  expect(await screen.findByRole("link", { name: /Older settings/ })).toBeTruthy();
});

test("returns focus to the opener and to the history heading for a direct record", async () => {
  const view = mount();
  const opener = await screen.findByRole("link", { name: /Organization settings saved/ });
  opener.focus();
  opener.addEventListener("click", click => click.preventDefault(), { once: true });
  fireEvent.click(opener);
  navigation.search = `event=${event.eventId}`; view.refresh();
  await screen.findByRole("dialog");
  navigation.search = ""; view.refresh();
  await waitFor(() => expect(document.activeElement).toBe(opener));
  view.unmount();
  navigation.search = `event=${event.eventId}`;
  const direct = mount(); await screen.findByRole("dialog");
  navigation.search = ""; direct.refresh();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "What changed" })));
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
  const { client } = mount(<><RecentAdminChanges /><LastAdminChange section="agent" /><LastAdminChange section="policy" /></>);
  expect((await screen.findByRole("link", { name: /Last recorded settings save/ })).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  expect(screen.getByRole("link", { name: "Organization settings saved" }).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  expect(screen.getByRole("link", { name: "View history" }).getAttribute("href")).toBe("/admin/history");
  expect(screen.getByRole("link", { name: /Last recorded rules or settings change/ }).getAttribute("href")).toBe(`/admin/history?event=${event.eventId}`);
  vi.mocked(listAdminHistory).mockRejectedValue(new Error("Offline"));
  await client.invalidateQueries();
  await waitFor(() => expect(screen.getAllByText("Could not check change history.")).toHaveLength(2));
  expect(screen.queryByRole("link", { name: /Last recorded settings save/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /Last recorded rules or settings change/ })).toBeNull();
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
