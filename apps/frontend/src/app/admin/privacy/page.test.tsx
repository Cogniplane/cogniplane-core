// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_PII_PROTECTION, type PiiPolicyHealth, type PiiProtectionSettings, type TenantDetails } from "@cogniplane/shared-types";

import { getTenantDetails, updateTenantPiiProtection } from "../../../lib/admin-api";
import { ApiError } from "../../../lib/api-client";
import { queryKeys } from "../../../lib/query-keys";
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
    push(url: string) {
      // Next replaces the current entry when the URL is unchanged.
      if (url === entries[index]) return;
      entries = [...entries.slice(0, index + 1), url]; index += 1; emit();
    },
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
    AdminPiiDashboard: function AdminPiiDashboard({ active }: { active?: boolean }) {
      const [range, setRange] = useState("7d");
      useEffect(() => { dashboard.mounts += 1; }, []);
      return <div data-active={String(active)}><p>Activity range {range}</p><button type="button" onClick={() => setRange("30d")}>Show 30 days</button></div>;
    }
  };
});

vi.mock("../../../lib/admin-api", () => ({ getTenantDetails: vi.fn(), updateTenantPiiProtection: vi.fn() }));

function tenant(piiProtection: PiiProtectionSettings = DEFAULT_PII_PROTECTION, piiProtectionRevision?: number, piiProtectionHealth?: PiiPolicyHealth): TenantDetails {
  return { tenantId: "tenant-1", tenantName: "Acme", slug: "acme", settings: { piiProtection, piiProtectionRevision, piiProtectionHealth } } as unknown as TenantDetails;
}

function mount(url: string): QueryClient {
  nav.reset(url);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminPrivacyPage /></QueryClientProvider>);
  return client;
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

it("marks the kept Activity panel inactive while Settings shows", async () => {
  vi.mocked(getTenantDetails).mockResolvedValue(tenant());
  mount("/admin/privacy?tab=activity");
  const activity = (await screen.findByText("Activity range 7d")).parentElement!;
  expect(activity.dataset.active).toBe("true");

  fireEvent.mouseDown(screen.getByRole("tab", { name: "Settings" }), { button: 0 });
  expect(activity.dataset.active).toBe("false");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Activity" }), { button: 0 });
  expect(activity.dataset.active).toBe("true");
  expect(dashboard.mounts).toBe(1);
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

it("keeps the draft after a save conflict, and Reload settings shows the current settings", async () => {
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(DEFAULT_PII_PROTECTION, 3));
  mount("/admin/privacy");
  fireEvent.click(await screen.findByLabelText("Direct uploads"));
  // Another session saved block mode as revision 4.
  vi.mocked(getTenantDetails).mockResolvedValue(tenant({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" }, 4));
  vi.mocked(updateTenantPiiProtection).mockRejectedValueOnce(new ApiError({
    status: 409, code: "pii_settings_conflict", method: "PUT", path: "/tenant/settings/pii", message: "Server text."
  }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  const alert = await within(settingsPanel()).findByRole("alert");
  expect(alert.textContent).toBe("These settings changed in another session. Your changes are not saved. Reload to see the current settings.");
  expect(updateTenantPiiProtection).toHaveBeenCalledWith(expect.objectContaining({ scopes: expect.objectContaining({ uploads: false }) }), 3);
  // The failed save reads the settings again. The form keeps the draft.
  expect(await screen.findByText(/Saved mode: Block\./)).toBeTruthy();
  expect(getTenantDetails).toHaveBeenCalledTimes(2);
  expect((screen.getByLabelText("Direct uploads") as HTMLInputElement).checked).toBe(false);
  expect(screen.getByText("Unsaved changes")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Reload settings" }));
  expect((screen.getByLabelText("Direct uploads") as HTMLInputElement).checked).toBe(true);
  expect(screen.getByRole("combobox", { name: "Protection mode" }).textContent).toContain("Block");
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});

it("shows the policy health on Settings, and a save of the shown values repairs the policy", async () => {
  const shown = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" as const };
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(shown, 2, { state: "error", reasons: ["mode_invalid"], fields: ["mode"] }));
  mount("/admin/privacy");
  const notice = await within(settingsPanel()).findByRole("alert");
  expect(notice.textContent).toContain("The protection mode is not valid.");
  expect(dashboard.mounts).toBe(0);

  vi.mocked(updateTenantPiiProtection).mockResolvedValueOnce({ ok: true, piiProtection: shown, piiProtectionRevision: 3 });
  vi.mocked(getTenantDetails).mockResolvedValue(tenant(shown, 3, { state: "ok", reasons: [], fields: [] }));
  fireEvent.click(screen.getByRole("button", { name: "Save policy" }));

  expect(await screen.findByText("PII protection settings saved.")).toBeTruthy();
  expect(updateTenantPiiProtection).toHaveBeenCalledWith(shown, 2);
  expect(within(settingsPanel()).queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save policy" })).toBeNull();
});

it("marks the PII activity as old after a successful save, so the Activity tab reads the policy again", async () => {
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(DEFAULT_PII_PROTECTION, 3));
  const client = mount("/admin/privacy");
  const metrics = queryKeys.admin.piiMetrics({ range: "7d" });
  client.setQueryData(metrics, { policyHealth: { state: "error", reasons: [], fields: [] } });
  fireEvent.click(await screen.findByLabelText("Direct uploads"));
  const saved = { ...DEFAULT_PII_PROTECTION, scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: false } };
  vi.mocked(updateTenantPiiProtection).mockResolvedValueOnce({ ok: true, piiProtection: saved, piiProtectionRevision: 4 });
  vi.mocked(getTenantDetails).mockResolvedValue(tenant(saved, 4));
  expect(client.getQueryState(metrics)?.isInvalidated).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("PII protection settings saved.")).toBeTruthy();
  expect(client.getQueryState(metrics)?.isInvalidated).toBe(true);
});

it("marks the PII activity as old after a conflict, because another session changed the policy", async () => {
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(DEFAULT_PII_PROTECTION, 3));
  const client = mount("/admin/privacy");
  const metrics = queryKeys.admin.piiMetrics({ range: "7d" });
  client.setQueryData(metrics, { policyHealth: { state: "ok", reasons: [], fields: [] } });
  fireEvent.click(await screen.findByLabelText("Direct uploads"));
  vi.mocked(getTenantDetails).mockResolvedValue(tenant({ ...DEFAULT_PII_PROTECTION, enabled: true, mode: "block" }, 4));
  vi.mocked(updateTenantPiiProtection).mockRejectedValueOnce(new ApiError({
    status: 409, code: "pii_settings_conflict", method: "PUT", path: "/tenant/settings/pii", message: "Server text."
  }));

  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await within(settingsPanel()).findByRole("alert")).toBeTruthy();
  expect(client.getQueryState(metrics)?.isInvalidated).toBe(true);
});


it("confirms the written settings when the following read fails, and keeps later edits based on that revision", async () => {
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(DEFAULT_PII_PROTECTION, 3));
  const client = mount("/admin/privacy");
  fireEvent.click(await screen.findByLabelText("Direct uploads"));
  const saved = { ...DEFAULT_PII_PROTECTION, scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: false } };
  vi.mocked(updateTenantPiiProtection).mockResolvedValueOnce({ ok: true, piiProtection: saved, piiProtectionRevision: 4 });
  vi.mocked(getTenantDetails).mockRejectedValue(new Error("Refresh failed."));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

  expect(await screen.findByText("PII protection settings saved.")).toBeTruthy();
  expect(await screen.findByText("Could not refresh privacy settings. Showing the last confirmed settings.")).toBeTruthy();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
  expect((screen.getByLabelText("Direct uploads") as HTMLInputElement).checked).toBe(false);
  expect(client.getQueryData<TenantDetails>(queryKeys.admin.tenant())?.settings.piiProtectionRevision).toBe(4);
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(false);

  fireEvent.click(screen.getByLabelText("Chat prompts"));
  const next = { ...saved, scopes: { ...saved.scopes, chatPrompts: false } };
  vi.mocked(updateTenantPiiProtection).mockResolvedValueOnce({ ok: true, piiProtection: next, piiProtectionRevision: 5 });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(updateTenantPiiProtection).toHaveBeenLastCalledWith(next, 4));
  await screen.findByText("PII protection settings saved.");
  vi.mocked(getTenantDetails).mockResolvedValue(tenant(next, 5));
  fireEvent.click(screen.getByRole("button", { name: "Retry settings" }));
  await waitFor(() => expect(screen.queryByText(/Could not refresh privacy settings/)).toBeNull());
});

it("keeps newer confirmed settings if an older write finishes after their read", async () => {
  vi.mocked(getTenantDetails).mockResolvedValueOnce(tenant(DEFAULT_PII_PROTECTION, 3));
  const client = mount("/admin/privacy");
  fireEvent.click(await screen.findByLabelText("Direct uploads"));
  let complete!: (value: Awaited<ReturnType<typeof updateTenantPiiProtection>>) => void;
  vi.mocked(updateTenantPiiProtection).mockReturnValueOnce(new Promise(resolve => { complete = resolve; }));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  const newer = { ...DEFAULT_PII_PROTECTION, enabled: true, mode: "transform" as const };
  act(() => client.setQueryData(queryKeys.admin.tenant(), tenant(newer, 5)));
  vi.mocked(getTenantDetails).mockRejectedValue(new Error("Refresh failed."));
  const older = { ...DEFAULT_PII_PROTECTION, scopes: { ...DEFAULT_PII_PROTECTION.scopes, uploads: false } };
  await act(async () => complete({ ok: true, piiProtection: older, piiProtectionRevision: 4 }));
  await screen.findByText(/Could not refresh privacy settings/);
  expect(client.getQueryData<TenantDetails>(queryKeys.admin.tenant())?.settings.piiProtection).toEqual(newer);
  expect(client.getQueryData<TenantDetails>(queryKeys.admin.tenant())?.settings.piiProtectionRevision).toBe(5);
});
