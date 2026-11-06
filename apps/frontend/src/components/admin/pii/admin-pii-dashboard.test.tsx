// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PiiActivityMetrics } from "@cogniplane/shared-types";
import { AdminPiiDashboard } from "./admin-pii-dashboard";
import { getAdminPiiMetrics, getAdminPiiRecent, getAdminPiiTop, getPiiProviderStatus } from "../../../lib/admin-api";
import { queryKeys } from "../../../lib/query-keys";
import { registerPiiScopeLabel } from "../../../lib/pii-scope-labels";

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
    policy: { enabled: false, mode: "off", rawRetention: "never", scopes: { chatPrompts: true, uploads: true }, entityTypes: [] },
    kpis: { scans: kpi, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi },
    timeSeries: [{ bucket: "2026-09-20T00:00:00Z", allow: 0, report: 0, block: 0, transform: 0, failed: 0 }],
    byEntityType: [],
    byConfidence: [],
    bySubjectType: [],
    ...overrides
  } as PiiActivityMetrics;
}

const clients: QueryClient[] = [];
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getPiiProviderStatus).mockResolvedValue(null);
  vi.mocked(getAdminPiiTop).mockResolvedValue({ range: metrics().range, groupBy: "user", rows: [] });
  vi.mocked(getAdminPiiRecent).mockResolvedValue({ range: metrics().range, actions: [], rows: [] });
});

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
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

const detect = { enabled: true, mode: "detect", rawRetention: "never", scopes: { chatPrompts: true, uploads: true }, entityTypes: [] } as PiiActivityMetrics["policy"];

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
  expect((await screen.findByRole("alert")).textContent).toContain("Could not load activity metrics for 7d.");
  expect(screen.queryByText(/Protection is off/)).toBeNull();
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByRole("heading", { name: "Activity over time" })).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it("separates initial pending, failure, local retry and genuine zero metrics", async () => {
  const first = deferred<PiiActivityMetrics | null>();
  const retry = deferred<PiiActivityMetrics | null>();
  vi.mocked(getAdminPiiMetrics).mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
  mount();
  expect(screen.getByText("Loading activity metrics for 7d...")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
  await act(async () => { first.reject(new Error("Do not show sensitive transport text")); });
  await screen.findByText(/Could not load activity metrics for 7d/);
  expect(screen.queryByText("Loading activity metrics for 7d...")).toBeNull();
  expect(screen.queryByText(/sensitive transport/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry metrics" }));
  await screen.findByText("Loading activity metrics for 7d...");
  await act(async () => { retry.resolve(metrics({ policy: detect })); });
  await screen.findByText("No findings in this range.");
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  expect(within(screen.getAllByRole("listitem")[0]!).getByText("0")).toBeTruthy();
  expect(getAdminPiiMetrics).toHaveBeenCalledTimes(2);
  expect(getAdminPiiTop).toHaveBeenCalledTimes(1);
  expect(getAdminPiiRecent).toHaveBeenCalledTimes(1);
});

it("treats optional endpoint null as unavailable and retries it locally", async () => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValueOnce(null).mockResolvedValueOnce(metrics({ policy: detect }));
  mount();
  await screen.findByText("Activity metrics are unavailable for 7d. Counts are not available.");
  expect(screen.queryByRole("list")).toBeNull();
  expect(screen.queryByText("No completed scans in this range.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry metrics" }));
  await screen.findByText("No completed scans in this range.");
  expect(getAdminPiiMetrics).toHaveBeenCalledTimes(2);
});

it("identifies retained metrics during fast range changes and ignores out-of-order responses", async () => {
  const slow24 = deferred<PiiActivityMetrics | null>();
  const fast30 = deferred<PiiActivityMetrics | null>();
  const seven = metrics({ policy: detect, kpis: { scans: { current: 7, previous: 0 }, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi } });
  const thirty = { ...seven, range: { ...seven.range, preset: "30d" as const, from: "2026-08-28T00:00:00Z" }, kpis: { ...seven.kpis, scans: { current: 30, previous: 0 } } };
  vi.mocked(getAdminPiiMetrics).mockImplementation(params => params.range === "24h" ? slow24.promise : params.range === "30d" ? fast30.promise : Promise.resolve(seven));
  mount();
  await screen.findByText(/^Metrics shown for 7d\./);
  fireEvent.click(screen.getByRole("button", { name: "24h" }));
  await screen.findByText("Loading metrics for 24h. Showing 7d until they arrive.");
  expect(screen.getByRole("button", { name: "24h" }).getAttribute("aria-pressed")).toBe("true");
  expect(within(screen.getAllByRole("listitem")[0]!).getByText("7")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "30d" }));
  await screen.findByText("Loading metrics for 30d. Showing 7d until they arrive.");
  await act(async () => { fast30.resolve(thirty); });
  await screen.findByText(/^Metrics shown for 30d\./);
  await act(async () => { slow24.resolve({ ...seven, range: { ...seven.range, preset: "24h" } }); });
  expect(screen.getByText(/^Metrics shown for 30d\./).querySelector("time")!.dateTime).toBe("2026-08-28T00:00:00Z");
  expect(within(screen.getAllByRole("listitem")[0]!).getByText("30")).toBeTruthy();
  expect(screen.queryByText(/Loading metrics for/)).toBeNull();
});

it("keeps the exact successful window and counts after a failed background refresh", async () => {
  const refresh = deferred<PiiActivityMetrics | null>();
  vi.mocked(getAdminPiiMetrics).mockResolvedValueOnce(metrics({ policy: detect })).mockReturnValueOnce(refresh.promise).mockResolvedValueOnce(metrics({ policy: detect }));
  mount();
  await screen.findByText(/^Metrics shown for 7d\./);
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Refreshing metrics for 7d. Showing the last successful result.");
  await act(async () => { refresh.reject(new Error("offline")); });
  await screen.findByText(/Could not refresh activity metrics for 7d/);
  expect(screen.getByText(/^Metrics shown for 7d\./).querySelector("time")!.dateTime).toBe("2026-09-20T00:00:00Z");
  expect(screen.getAllByRole("listitem")).toHaveLength(5);
  fireEvent.click(screen.getByRole("button", { name: "Retry metrics" }));
  await waitFor(() => expect(screen.queryByText(/Could not refresh activity metrics/)).toBeNull());
});

it("clears retained metrics after the newly requested range fails or is unavailable", async () => {
  const next = deferred<PiiActivityMetrics | null>();
  vi.mocked(getAdminPiiMetrics).mockResolvedValueOnce(metrics({ policy: detect })).mockReturnValueOnce(next.promise).mockResolvedValueOnce(null);
  mount();
  await screen.findByText(/^Metrics shown for 7d\./);
  fireEvent.click(screen.getByRole("button", { name: "24h" }));
  await screen.findByText("Loading metrics for 24h. Showing 7d until they arrive.");
  await act(async () => { next.reject(new Error("offline")); });
  await screen.findByText(/Could not load activity metrics for 24h/);
  expect(screen.queryByText(/^Metrics shown for/)).toBeNull();
  expect(screen.queryByRole("list")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry metrics" }));
  await screen.findByText("Activity metrics are unavailable for 24h. Counts are not available.");
  expect(screen.queryByRole("list")).toBeNull();
});

it("names each import scope that is on with its registered label", async () => {
  registerPiiScopeLabel({ scopeKey: "partnerImports", label: "partner imports" });
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({
    policy: { ...detect, scopes: { chatPrompts: false, uploads: true, partnerImports: true, otherImports: false } },
    kpis: { scans: { current: 1, previous: 0 }, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi }
  }));
  mount();
  expect(await screen.findByText("Detect mode. Scans direct uploads and partner imports.")).toBeTruthy();
});

// The server shows a stored policy that is on with mode Off as Block. A server
// from before that change sends mode Off.
it.each(["block", "off"] as const)("warns when the stored policy is not valid and says that content in scope is stopped (shown mode %s)", async (mode) => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({
    policy: { ...detect, mode },
    policyHealth: { state: "error", reasons: ["mode_off_while_enabled"], fields: ["mode"] }
  }));
  mount();
  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("The stored PII policy is not valid.");
  expect(alert.textContent).toContain("Protection is on, but the mode is Off.");
  expect(alert.textContent).toContain("Fields: mode.");
  expect(screen.getByText("Content in scope is stopped.")).toBeTruthy();
  expect(screen.queryByText(/Protection is off/)).toBeNull();
});

it("shows a recovered policy as a status, and nothing for a valid one", async () => {
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({
    policy: detect,
    policyHealth: { state: "warning", reasons: ["entity_types_unsupported", "future_code"], fields: ["detectors.entityTypes"] },
    kpis: { scans: { current: 1, previous: 0 }, findings: kpi, blocked: kpi, transformed: kpi, failed: kpi }
  }));
  mount();
  expect(await screen.findByText(/Part of the stored PII policy is not valid/)).toBeTruthy();
  expect(screen.getByText("Some personal data types are not supported. Only the supported types are checked.")).toBeTruthy();
  cleanup();
  vi.mocked(getAdminPiiMetrics).mockResolvedValue(metrics({ policy: detect, policyHealth: { state: "ok", reasons: [], fields: [] } }));
  mount();
  await screen.findByText(/Detect mode\./);
  expect(screen.queryByText(/not valid/)).toBeNull();
});
