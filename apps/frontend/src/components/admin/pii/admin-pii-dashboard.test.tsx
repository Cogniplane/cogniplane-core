// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PiiActivityMetrics } from "@cogniplane/shared-types";
import { AdminPiiDashboard } from "./admin-pii-dashboard";
import { getAdminPiiMetrics, getAdminPiiRecent, getAdminPiiTop, getPiiProviderStatus } from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";

vi.mock("../../../lib/admin-api", () => ({
  getAdminPiiMetrics: vi.fn(),
  getAdminPiiTop: vi.fn(),
  getAdminPiiRecent: vi.fn(),
  getAdminPiiJobsStats: vi.fn(),
  getPiiProviderStatus: vi.fn()
}));

const kpi = { current: 0, previous: 0 };
function metrics(overrides: Partial<PiiActivityMetrics> = {}): PiiActivityMetrics {
  return {
    range: { preset: "7d", from: "2026-09-20T00:00:00Z", to: "2026-09-27T00:00:00Z", bucket: "day" },
    policy: { enabled: false, mode: "off", rawRetention: "never", scopes: { chatPrompts: true, uploads: true, microsoftImports: false }, entityTypes: [] },
    kpis: { scans: kpi, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi },
    timeSeries: [{ bucket: "2026-09-20T00:00:00Z", allow: 0, report: 0, block: 0, transform: 0, failed: 0 }],
    byEntityType: [],
    byConfidence: [],
    bySubjectType: [],
    ...overrides
  } as PiiActivityMetrics;
}

afterEach(cleanup);
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPiiProviderStatus).mockResolvedValue(null);
  vi.mocked(getAdminPiiTop).mockResolvedValue({ groupBy: "user", rows: [] } as never);
  vi.mocked(getAdminPiiRecent).mockResolvedValue({ rows: [] } as never);
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminPiiDashboard /></QueryClientProvider>);
  return client;
}

it("refreshes the active range and keeps cached data for other ranges", async () => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics());
  const client = mount();
  await screen.findByText(/Protection is off, so nothing is scanned\./);
  const otherRange = queryKeys.admin.piiMetrics({ range: "30d" });
  client.setQueryData(otherRange, metrics());

  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));

  await waitFor(() => expect(getAdminPiiMetrics).toHaveBeenCalledTimes(2));
  expect(vi.mocked(getAdminPiiMetrics).mock.calls[1]![0]).toEqual({ range: "7d" });
  expect(client.getQueryState(otherRange)!.isInvalidated).toBe(false);
});

it("explains an empty range when protection is off and links to the Settings tab", async () => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics());
  mount();
  expect(await screen.findByText(/Protection is off, so nothing is scanned\./)).toBeTruthy();
  expect(screen.getByRole("link", { name: "Turn it on in Settings" }).getAttribute("href")).toBe("/admin/privacy");
  expect(screen.queryByRole("heading", { name: "Activity over time" })).toBeNull();
});

const detect = { enabled: true, mode: "detect", rawRetention: "never", scopes: { chatPrompts: true, uploads: true, microsoftImports: false }, entityTypes: [] } as PiiActivityMetrics["policy"];

it("states the mode and sources in one line and names each section with a heading", async () => {
  // Four finished scans with no findings, as the backend reports them.
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({
    policy: detect,
    kpis: { scans: { current: 4, previous: 0 }, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi },
    timeSeries: [{ bucket: "2026-09-20T00:00:00Z", allow: 4, report: 0, block: 0, transform: 0, failed: 0 }],
    bySubjectType: [{ subjectType: "message", count: 4 }]
  }));
  mount();
  expect(await screen.findByText("Detect mode. Scans chat prompts and direct uploads.")).toBeTruthy();
  for (const name of ["Activity over time", "Findings breakdown", "Most findings", "Recent activity", "Operational health"]) {
    expect(screen.getByRole("heading", { name })).toBeTruthy();
  }
  // Scans ran, so the chart is drawn, but no findings means one line instead of three empty cards.
  expect(screen.queryByText("No completed scans in this range.")).toBeNull();
  expect(screen.getByText("No findings in this range.")).toBeTruthy();
  expect(screen.queryByRole("heading", { name: "By source" })).toBeNull();
  expect(await screen.findByText("No users with findings in this range.")).toBeTruthy();
});

it("keeps the dashboard when protection is off now but the range has scans", async () => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({
    kpis: { scans: { current: 3, previous: 0 }, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi },
    timeSeries: [{ bucket: "2026-09-20T00:00:00Z", allow: 3, report: 0, block: 0, transform: 0, failed: 0 }]
  }));
  mount();
  expect(await screen.findByText("Protection is off.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Activity over time" })).toBeTruthy();
  expect(screen.queryByText(/nothing is scanned/)).toBeNull();
});

it("shows a metrics error without claiming protection is off", async () => {
  vi.mocked(getAdminPiiMetrics).mockRejectedValue(new Error("Metrics offline"));
  mount();
  expect((await screen.findByRole("alert")).textContent).toBe("Metrics offline");
  expect(screen.queryByText(/Protection is off/)).toBeNull();
});
