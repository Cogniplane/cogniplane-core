// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type TenantDetails } from "@cogniplane/shared-types";

import { getTenantDetails } from "../../../lib/admin-api";
import AdminPrivacyPage from "./page";

// A small browser history: push adds an entry, back and forward move in it.
const nav = vi.hoisted(() => {
  let entries = ["/admin/privacy"];
  let index = 0;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    reset(url: string) { entries = [url]; index = 0; },
    current: () => entries[index],
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    push(url: string) { entries = [...entries.slice(0, index + 1), url]; index += 1; emit(); },
    back() { index = Math.max(0, index - 1); emit(); },
    forward() { index = Math.min(entries.length - 1, index + 1); emit(); }
  };
});

vi.mock("next/navigation", async () => {
  const { useSyncExternalStore } = await import("react");
  const useUrl = () => useSyncExternalStore(nav.subscribe, nav.current);
  return {
    usePathname: () => useUrl().split("?")[0],
    useSearchParams: () => new URLSearchParams(useUrl().split("?")[1] ?? ""),
    useRouter: () => ({ push: nav.push, replace: vi.fn() })
  };
});

const dashboard = vi.hoisted(() => ({ mounts: 0 }));
// The dashboard keeps its range in local state, like the real one.
vi.mock("../../../components/admin/pii/admin-pii-dashboard", async () => {
  const { useEffect, useState } = await import("react");
  return {
    AdminPiiDashboard: function AdminPiiDashboard() {
      const [range, setRange] = useState("7d");
      useEffect(() => { dashboard.mounts += 1; }, []);
      return <div><p>Activity range {range}</p><button type="button" onClick={() => setRange("30d")}>Show 30 days</button></div>;
    }
  };
});

vi.mock("../../../lib/admin-api", () => ({ getTenantDetails: vi.fn(), updateTenantPiiProtection: vi.fn() }));

function tenant(): TenantDetails {
  return { tenantId: "tenant-1", tenantName: "Acme", slug: "acme", settings: { piiProtection: DEFAULT_PII_PROTECTION } } as unknown as TenantDetails;
}

function mount(url: string) {
  nav.reset(url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminPrivacyPage /></QueryClientProvider>);
}

function panelFor(tab: string): HTMLElement {
  const panel = document.getElementById(screen.getByRole("tab", { name: tab }).getAttribute("aria-controls") ?? "");
  if (!panel) throw new Error(`No panel for ${tab}`);
  return panel;
}
const settingsPanel = () => panelFor("Settings");
const activityPanel = () => panelFor("Activity");

beforeEach(() => { dashboard.mounts = 0; });
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it("loads the activity dashboard only after the first visit to its tab", async () => {
  vi.mocked(getTenantDetails).mockResolvedValue(tenant());
  mount("/admin/privacy");
  await screen.findByText("PII protection");
  expect(dashboard.mounts).toBe(0);
  expect(activityPanel().hidden).toBe(true);

  fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), { button: 0 });
  expect(nav.current()).toBe("/admin/privacy?tab=activity");
  expect(await screen.findByText("Activity range 7d")).toBeTruthy();
  expect(dashboard.mounts).toBe(1);
  expect(settingsPanel().hidden).toBe(true);
  expect(screen.getByRole("tab", { name: "Activity" }).getAttribute("aria-selected")).toBe("true");
});

it("keeps the settings draft and the activity range when tabs switch by click, back, and forward", async () => {
  vi.mocked(getTenantDetails).mockResolvedValue(tenant());
  mount("/admin/privacy");
  const chatPrompts = await screen.findByLabelText("Chat prompts") as HTMLInputElement;
  const before = chatPrompts.checked;
  fireEvent.click(chatPrompts);
  expect(within(settingsPanel()).getByText("Unsaved changes")).toBeTruthy();

  fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), { button: 0 });
  fireEvent.click(await screen.findByRole("button", { name: "Show 30 days" }));
  expect(screen.getByText("Activity range 30d")).toBeTruthy();

  act(() => nav.back());
  expect(nav.current()).toBe("/admin/privacy");
  expect(settingsPanel().hidden).toBe(false);
  expect((screen.getByLabelText("Chat prompts") as HTMLInputElement).checked).toBe(!before);
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  act(() => nav.forward());
  expect(activityPanel().hidden).toBe(false);
  expect(screen.getByText("Activity range 30d")).toBeTruthy();
  expect(dashboard.mounts).toBe(1);
  expect(getTenantDetails).toHaveBeenCalledOnce();
});

it("opens the Activity tab from the URL and keeps other query values when switching", async () => {
  vi.mocked(getTenantDetails).mockResolvedValue(tenant());
  mount("/admin/privacy?tab=activity&from=overview");
  expect(await screen.findByText("Activity range 7d")).toBeTruthy();
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Settings" }), { button: 0 });
  expect(nav.current()).toBe("/admin/privacy?from=overview");
});

it("shows Activity when the settings load fails, and offers a retry on Settings", async () => {
  vi.mocked(getTenantDetails).mockRejectedValueOnce(new Error("Could not load privacy settings."));
  mount("/admin/privacy?tab=activity");
  expect(await screen.findByText("Activity range 7d")).toBeTruthy();

  fireEvent.mouseDown(screen.getByRole("tab", { name: "Settings" }), { button: 0 });
  const alert = await within(settingsPanel()).findByRole("alert");
  expect(alert.textContent).toContain("Could not load privacy settings.");
  vi.mocked(getTenantDetails).mockResolvedValue(tenant());
  fireEvent.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByText("PII protection")).toBeTruthy());
});

it("shows a loading state instead of an empty card", () => {
  vi.mocked(getTenantDetails).mockReturnValue(new Promise(() => {}));
  mount("/admin/privacy");
  expect(within(settingsPanel()).getByRole("status").textContent).toBe("Loading privacy settings...");
  expect(screen.queryByText("PII protection")).toBeNull();
});
