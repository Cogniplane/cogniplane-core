// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ScheduledJob, ScheduledJobRun, UserSettingsSection } from "@cogniplane/shared-types";
import Page from "./page";

const api = vi.hoisted(() => ({ list: vi.fn(), sections: vi.fn(), runs: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), defaults: vi.fn() }));
vi.mock("../../../lib/settings-api", () => ({
  listScheduledJobs: api.list, listUserSettingsSections: api.sections, listScheduledJobRuns: api.runs,
  createScheduledJob: api.create, updateScheduledJob: api.update, deleteScheduledJob: api.remove,
  updateUserSettingsSection: api.defaults
}));
const job: ScheduledJob = {
  jobId: "job-1", userId: "user-1", jobName: "Morning digest", description: "Daily news",
  scheduleKind: "cron", cronExpression: "0 9 * * 1-5", timeZone: "UTC", targetType: "prompt",
  targetRef: null, input: { prompt: "Read the news" }, settingsSnapshot: {}, enabled: true,
  lastRunAt: null, nextRunAt: null, createdAt: "2026-09-21T12:00:00Z", updatedAt: "2026-09-21T12:00:00Z"
};
let jobs: ScheduledJob[];
let section: UserSettingsSection;
const clients: QueryClient[] = [];
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
}
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
beforeEach(() => {
  vi.resetAllMocks();
  jobs = [job];
  section = { sectionKey: "scheduled_jobs", title: "Jobs", status: "live", version: 1,
    config: { defaultTimeZone: "America/Toronto", enableOnCreate: false }, updatedAt: null };
  api.list.mockImplementation(async () => [...jobs]);
  api.sections.mockImplementation(async () => [section]);
  api.runs.mockResolvedValue([]);
  api.update.mockImplementation(async (id, payload) => {
    jobs = jobs.map(row => row.jobId === id ? { ...row, ...payload } : row);
    return jobs.find(row => row.jobId === id);
  });
  api.create.mockImplementation(async payload => { const created = { ...job, ...payload, jobId: "job-2" }; jobs = [...jobs, created]; return created; });
  api.remove.mockImplementation(async id => { jobs = jobs.filter(row => row.jobId !== id); });
  api.defaults.mockImplementation(async (_key, config) => { section = { ...section, config }; return section; });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("creates a job using the loaded defaults and refreshes the saved list", async () => {
  mount();
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Job name", "Weekly report");
  change("Prompt", "Summarize project activity");
  change("Cron expression", "0 10 * * 1");
  fireEvent.click(screen.getByRole("button", { name: "Create job" }));
  await screen.findByText("Weekly report");
  expect(api.create).toHaveBeenCalledWith({ jobName: "Weekly report", description: null,
    cronExpression: "0 10 * * 1", timeZone: "America/Toronto", targetType: "prompt",
    input: { prompt: "Summarize project activity" }, enabled: false });
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("");
});

it("preserves a failed edit for retry, then toggles and deletes the saved job", async () => {
  api.update.mockRejectedValueOnce(new Error("Save unavailable"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change("Job name", "Updated digest");
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await screen.findByText("Save unavailable");
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("Updated digest");
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await screen.findByText("Updated digest");
  fireEvent.click(screen.getByRole("button", { name: "Disable" }));
  await screen.findByRole("button", { name: "Enable" });
  expect(jobs[0].enabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  await screen.findByText("No scheduled jobs yet");
  expect(api.remove).toHaveBeenCalledWith("job-1", expect.anything());
});

it("saves defaults and uses them for the next composer", async () => {
  mount();
  await waitFor(() => expect((screen.getByLabelText("Default time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Default time zone", "Europe/Paris");
  fireEvent.click(screen.getByRole("checkbox", { name: /Enable new jobs by default/ }));
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("Europe/Paris"));
  expect(api.defaults).toHaveBeenCalledWith("scheduled_jobs", { defaultTimeZone: "Europe/Paris", enableOnCreate: true });
});

it("shows run loading, failure details and summary, then collapses history", async () => {
  let resolve!: (runs: ScheduledJobRun[]) => void;
  api.runs.mockImplementation(() => new Promise< ScheduledJobRun[] >(done => { resolve = done; }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  expect((await screen.findByRole("button", { name: "Loading..." }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => resolve([{
    runId: "run-1", jobId: "job-1", userId: "user-1", sessionId: null, status: "failed",
    startedAt: job.createdAt, completedAt: job.updatedAt, durationMs: 1250, inputTokens: 0, outputTokens: 0,
    errorMessage: "Provider unavailable", summary: "Retry tomorrow", createdAt: job.createdAt
  }]));
  await screen.findByText("Provider unavailable");
  expect(screen.getByText("Retry tomorrow")).toBeTruthy();
  expect(screen.getByText("1.3s")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  expect(screen.queryByText("Provider unavailable")).toBeNull();
});

it("prevents changing the edited job while its save is pending", async () => {
  let resolve!: () => void;
  api.update.mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change("Job name", "Unsaved digest");
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await screen.findByRole("button", { name: "Saving..." });
  expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel edit" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Job name").matches(":disabled")).toBe(true);
  await act(async () => resolve());
});

it("keeps an unsaved new job when defaults change", async () => {
  mount();
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Job name", "Draft report");
  change("Prompt", "Keep this prompt");
  change("Default time zone", "Europe/Paris");
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(api.sections).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("Draft report");
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this prompt");
  expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto");
});
