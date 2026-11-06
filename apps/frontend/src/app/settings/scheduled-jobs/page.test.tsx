// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { ScheduledJob, ScheduledJobRun, UserSettingsSection } from "@cogniplane/shared-types";
import Page from "./page";
import { queryKeys } from "../../../lib/query-keys";
import { useScheduledJobsData } from "../../../hooks/use-scheduled-jobs-data";

const api = vi.hoisted(() => ({ list: vi.fn(), sections: vi.fn(), runs: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), defaults: vi.fn(), preview: vi.fn() }));
vi.mock("../../../lib/settings-api", () => ({
  listScheduledJobs: api.list, listUserSettingsSections: api.sections, listScheduledJobRuns: api.runs,
  createScheduledJob: api.create, updateScheduledJob: api.update, deleteScheduledJob: api.remove,
  updateUserSettingsSection: api.defaults, previewScheduledJob: api.preview
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
const scrollIntoView = vi.fn();
const originalScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView }));
afterAll(() => {
  if (originalScroll) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScroll);
  else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  return client;
}
async function openNew() {
  const button = await screen.findByRole("button", { name: "New job" });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
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
  api.preview.mockResolvedValue("2026-09-27T13:00:00.000Z");
  api.update.mockImplementation(async (id, payload) => {
    jobs = jobs.map(row => row.jobId === id ? { ...row, ...payload } : row);
    return jobs.find(row => row.jobId === id);
  });
  api.create.mockImplementation(async payload => { const created = { ...job, ...payload, jobId: "job-2" }; jobs = [...jobs, created]; return created; });
  api.remove.mockImplementation(async id => { jobs = jobs.filter(row => row.jobId !== id); });
  api.defaults.mockImplementation(async (_key, config) => { section = { ...section, config }; return section; });
});
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); });

it("uses the saved time zone with a paused draft as soon as new-job creation becomes available", async () => {
  section.config.enableOnCreate = true;
  const readyDefaults: unknown[] = [];
  function OpenWhenReady() {
    const data = useScheduledJobsData();
    const opened = useRef(false);
    useLayoutEffect(() => {
      if (data.defaultsLoaded && !opened.current) {
        readyDefaults.push(data.defaultsDraft);
        opened.current = true;
        data.handleNewJob();
      }
    }, [data]);
    return <output>{JSON.stringify(data.jobDraft)}</output>;
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity } } });
  clients.push(client);
  render(<QueryClientProvider client={client}><OpenWhenReady /></QueryClientProvider>);
  await waitFor(() => expect(JSON.parse(screen.getByRole("status").textContent!)).toMatchObject({
    timeZone: "America/Toronto", enabled: false
  }));
  expect(readyDefaults).toEqual([{ defaultTimeZone: "America/Toronto", enableOnCreate: true }]);
});

it("creates a job using the loaded defaults and refreshes the saved list", async () => {
  mount();
  await openNew();
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Job name", "Weekly report");
  change("Prompt", "Summarize project activity");
  change("Schedule", "weekly");
  change("Time", "10:00");
  change("Day", "1");
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await screen.findByText("Weekly report");
  expect(api.create).toHaveBeenCalledWith({ jobName: "Weekly report", description: null,
    cronExpression: "0 10 * * 1", timeZone: "America/Toronto", targetType: "prompt",
    input: { prompt: "Summarize project activity" }, enabled: false });
  expect(screen.queryByLabelText("Job name")).toBeNull();
});

it.each(["Save paused", "Save and enable"])("uses the explicit %s choice even with old enabled defaults", async (choice) => {
  section.config.enableOnCreate = true;
  mount();
  await openNew();
  const paused = screen.getByRole("button", { name: "Save paused" });
  const enabled = screen.getByRole("button", { name: "Save and enable" });
  expect(paused.parentElement).toBe(enabled.parentElement);
  expect(paused.closest("details")).toBeNull();
  expect(enabled.closest("details")).toBeNull();
  expect(screen.getByText("More options").parentElement).toHaveProperty("open", false);
  expect(screen.queryByRole("checkbox", { name: /Enable this job when saved/ })).toBeNull();
  change("Job name", "Explicit choice");
  change("Prompt", "Prepare a report");
  fireEvent.click(screen.getByRole("button", { name: choice }));
  await screen.findByText("Explicit choice");
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledWith({ jobName: "Explicit choice", description: null,
    cronExpression: "0 9 * * *", timeZone: "America/Toronto", targetType: "prompt",
    input: { prompt: "Prepare a report" }, enabled: choice === "Save and enable" });
  expect(api.update).not.toHaveBeenCalled();
});

it("saves paused on a new-form submission without an explicit enable choice", async () => {
  section.config.enableOnCreate = true;
  mount();
  await openNew();
  change("Job name", "Default submission");
  const form = screen.getByLabelText("Job name").closest("form")!;
  expect(form.querySelector('button[type="submit"]')).toBe(screen.getByRole("button", { name: "Save paused" }));
  fireEvent.submit(form);
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: false })));
});

it.each([true, false])("preserves enabled=%s when editing an existing job", async (enabled) => {
  jobs = [{ ...job, enabled }];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  const toggle = screen.getByRole("checkbox", { name: /Enable this job when saved/ });
  expect(toggle).toHaveProperty("checked", enabled);
  expect(toggle.closest("details")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save paused" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Save and enable" })).toBeNull();
  change("Prompt", "Revised prompt");
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith("job-1", {
    jobName: job.jobName, description: job.description, cronExpression: job.cronExpression,
    timeZone: job.timeZone, targetType: "prompt", input: { prompt: "Revised prompt" }, enabled
  }));
  expect(api.create).not.toHaveBeenCalled();
});

it.each([true, false])("lets an edit explicitly change enabled=%s", async (enabled) => {
  jobs = [{ ...job, enabled }];
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  fireEvent.click(screen.getByRole("checkbox", { name: /Enable this job when saved/ }));
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith("job-1", expect.objectContaining({ enabled: !enabled })));
});

it.each(["Save paused", "Save and enable"])("locks both choices during %s and keeps a failed draft for retry", async (choice) => {
  let reject!: (error: Error) => void;
  api.create.mockImplementationOnce(() => new Promise<ScheduledJob>((_resolve, fail) => { reject = fail; }));
  mount();
  await openNew();
  change("Job name", "Retry this job");
  change("Prompt", "Keep this prompt");
  const decision = screen.getByRole("button", { name: choice });
  fireEvent.click(decision);
  fireEvent.click(decision);
  await screen.findByRole("button", { name: "Saving..." });
  expect(api.create).toHaveBeenCalledTimes(1);
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: choice === "Save and enable" }));
  const otherChoice = choice === "Save paused" ? "Save and enable" : "Save paused";
  for (const name of ["Saving...", otherChoice, "Cancel"]) {
    expect(screen.getByRole("button", { name }).matches(":disabled")).toBe(true);
  }
  expect(screen.getByLabelText("Prompt").matches(":disabled")).toBe(true);
  await act(async () => reject(new Error("Save unavailable")));
  const error = await screen.findByRole("alert");
  expect(error.textContent).toBe("Save unavailable");
  expect(document.activeElement).toBe(error);
  expect(screen.getByLabelText("Job name")).toHaveProperty("value", "Retry this job");
  expect(screen.getByLabelText("Prompt")).toHaveProperty("value", "Keep this prompt");
  expect(screen.getByLabelText("Time zone")).toHaveProperty("value", "America/Toronto");
  expect(screen.getByRole("button", { name: "Save paused" }).matches(":disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "Save and enable" }).matches(":disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await screen.findByText("Retry this job");
  expect(api.create).toHaveBeenCalledTimes(2);
  expect(api.create).toHaveBeenLastCalledWith(expect.objectContaining({
    jobName: "Retry this job", input: { prompt: "Keep this prompt" }, enabled: false
  }));
  expect(screen.queryByLabelText("Prompt")).toBeNull();
});

it.each([
  ["Save paused", "Job name"], ["Save and enable", "Job name"],
  ["Save paused", "Prompt"], ["Save and enable", "Prompt"],
  ["Save paused", "Cron expression"], ["Save and enable", "Cron expression"]
])("blocks %s when required %s is empty", async (choice, field) => {
  mount();
  await openNew();
  change("Job name", "Required fields");
  if (field === "Cron expression") change("Schedule", "custom");
  change(field, "");
  fireEvent.click(screen.getByRole("button", { name: choice }));
  expect(api.create).not.toHaveBeenCalled();
  expect(api.update).not.toHaveBeenCalled();
  expect(screen.getByLabelText(field)).toHaveProperty("validity.valueMissing", true);
});

it("keeps schedule validation errors and the selected time zone visible after a rejected enable", async () => {
  api.preview.mockRejectedValue(new Error("Invalid cron expression"));
  api.create.mockRejectedValueOnce(new Error("Invalid cron expression"));
  mount();
  await openNew();
  change("Job name", "Check schedule");
  change("Schedule", "custom");
  change("Cron expression", "invalid");
  change("Time zone", "Europe/Paris");
  await screen.findByText("This schedule cannot be previewed. Check the time zone and cron expression.");
  fireEvent.click(screen.getByRole("button", { name: "Save and enable" }));
  await screen.findByText("Invalid cron expression");
  expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ cronExpression: "invalid", timeZone: "Europe/Paris", enabled: true }));
  expect(screen.getByLabelText("Cron expression")).toHaveProperty("value", "invalid");
  expect(screen.getByLabelText("Time zone")).toHaveProperty("value", "Europe/Paris");
  expect(screen.getByRole("button", { name: "Save paused" }).matches(":disabled")).toBe(false);
  expect(screen.getByRole("button", { name: "Save and enable" }).matches(":disabled")).toBe(false);
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
  expect(api.remove).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
  await screen.findByText("No scheduled jobs yet");
  expect(api.remove).toHaveBeenCalledWith("job-1", expect.anything());
});

it.each([false, true])("preserves legacy activation preference %s when saving time-zone defaults", async (enableOnCreate) => {
  section.config.enableOnCreate = enableOnCreate;
  mount();
  fireEvent.click(screen.getByText("Defaults for new jobs"));
  await waitFor(() => expect((screen.getByLabelText("Default time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Default time zone", "Europe/Paris");
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(api.defaults).toHaveBeenCalled());
  await waitFor(() => expect((screen.getByRole("button", { name: "New job" }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: "New job" }));
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Europe/Paris"));
  expect(api.defaults).toHaveBeenCalledWith("scheduled_jobs", { defaultTimeZone: "Europe/Paris", enableOnCreate });
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
  api.update.mockImplementationOnce(() => new Promise<ScheduledJob>(done => { resolve = () => done(job); }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change("Job name", "Unsaved digest");
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await screen.findByRole("button", { name: "Saving..." });
  expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Job name").matches(":disabled")).toBe(true);
  await act(async () => resolve());
});

it("keeps an open draft until the user saves or cancels it", async () => {
  mount();
  await openNew();
  change("Job name", "Draft report");
  change("Prompt", "Keep this prompt");
  expect((screen.getByRole("button", { name: "New job" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole("button", { name: "Edit" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "New job" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("Draft report");
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this prompt");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("Morning digest");
});

it("keeps an unsaved new job when defaults change", async () => {
  mount();
  await openNew();
  fireEvent.click(screen.getByText("Defaults for new jobs"));
  await waitFor(() => expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto"));
  change("Job name", "Draft report");
  change("Prompt", "Keep this prompt");
  change("Default time zone", "Europe/Paris");
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  await waitFor(() => expect(api.sections).toHaveBeenCalledTimes(2));
  await waitFor(() => expect((screen.getByRole("button", { name: "Save defaults" }) as HTMLButtonElement).disabled).toBe(true));
  expect((screen.getByLabelText("Job name") as HTMLInputElement).value).toBe("Draft report");
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this prompt");
  expect((screen.getByLabelText("Time zone") as HTMLInputElement).value).toBe("America/Toronto");
});

it("keeps custom cron available and previews it with the selected time zone", async () => {
  mount();
  await openNew();
  change("Schedule", "custom");
  change("Cron expression", "15 8 * * 1-5");
  await waitFor(() => expect(api.preview).toHaveBeenCalledWith({
    cronExpression: "15 8 * * 1-5", timeZone: "America/Toronto"
  }));
  expect(await screen.findByText(/Next run:/)).toBeTruthy();
  change("Cron expression", "");
  expect(screen.getByText("Enter a cron expression to see the next run.")).toBeTruthy();
  expect(screen.queryByText("Checking the next run...")).toBeNull();
});

it("moves focus to the job form heading when the form opens", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Edit job" }));
});

it("ignores an incomplete time input until the user chooses a valid time", async () => {
  mount();
  await openNew();
  change("Time", "");
  expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("09:00");
  change("Time", "11:30");
  expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("11:30");
});

it("shows a retry when saved jobs fail to load instead of an empty list", async () => {
  api.list.mockRejectedValueOnce(new Error("Offline"));
  mount();
  expect(await screen.findByText("Saved jobs could not be loaded.")).toBeTruthy();
  expect(screen.queryByText("No scheduled jobs yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry saved jobs" }));
  expect(await screen.findByText("Morning digest")).toBeTruthy();
});

it("keeps failed run history distinct from an empty history and retries locally", async () => {
  api.runs.mockRejectedValueOnce(new Error("Runs unavailable"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Runs" }));
  expect(await screen.findByText("Runs unavailable")).toBeTruthy();
  expect(screen.queryByText("No runs recorded yet")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry runs" }));
  expect(await screen.findByText("No runs recorded yet")).toBeTruthy();
});

it("shows a toggle error beside its job", async () => {
  api.update.mockRejectedValueOnce(new Error("Update unavailable"));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Disable" }));
  const message = await screen.findByText("Update unavailable");
  expect(message.closest("[role=alert]")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Disable" })).toBeTruthy();
});

it("marks changed defaults as unsaved and lets the user cancel a failed save", async () => {
  api.defaults.mockRejectedValueOnce(new Error("Defaults unavailable"));
  mount();
  fireEvent.click(screen.getByText("Defaults for new jobs"));
  await waitFor(() => expect((screen.getByLabelText("Default time zone") as HTMLSelectElement).value).toBe("America/Toronto"));
  change("Default time zone", "Europe/Paris");
  expect(screen.getByText("Unsaved changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));
  expect(await screen.findByText("Defaults unavailable")).toBeTruthy();
  expect((screen.getByLabelText("Default time zone") as HTMLSelectElement).value).toBe("Europe/Paris");
  fireEvent.click(screen.getByRole("button", { name: "Cancel defaults" }));
  expect((screen.getByLabelText("Default time zone") as HTMLSelectElement).value).toBe("America/Toronto");
  expect(screen.queryByText("Defaults unavailable")).toBeNull();
  expect(screen.queryByText("Unsaved changes")).toBeNull();
});

it("explains a security pause and turns the job on again only after a review of its prompt", async () => {
  jobs = [{ ...job, enabled: false, pausedReason: "security_change" }];
  mount();
  expect(await screen.findByText("Paused because your account security changed. Review the job to turn it on again.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Enable" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Read the news");
  expect((screen.getByRole("checkbox", { name: /Enable this job when saved/ }) as HTMLInputElement).checked).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Update job" }));
  await waitFor(() => expect(api.update).toHaveBeenCalledWith("job-1", expect.objectContaining({
    input: { prompt: "Read the news" }, enabled: true
  })));
});

it("keeps the enable toggle for a job that the owner paused", async () => {
  jobs = [{ ...job, enabled: false, pausedReason: null }];
  mount();
  expect(await screen.findByRole("button", { name: "Enable" })).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  expect(screen.queryByText(/account security changed/)).toBeNull();
});

it("waits for unknown defaults and keeps a saved-job edit intact when they arrive", async () => {
  let resolve!: (value: UserSettingsSection[]) => void;
  api.sections.mockImplementationOnce(() => new Promise<UserSettingsSection[]>(done => { resolve = done; }));
  mount();
  expect(screen.getAllByText("Loading defaults before you can create a job...")[0]).toBeTruthy();
  expect((screen.getByRole("button", { name: "New job" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText("Defaults for new jobs"));
  expect(screen.getByLabelText("Default time zone").matches(":disabled")).toBe(true);
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change("Prompt", "Keep the existing job draft");
  await act(async () => resolve([section]));
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("UTC");
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep the existing job draft");
  expect(api.update).not.toHaveBeenCalled();
});

it("requires an explicit defaults retry after failure and then uses loaded values", async () => {
  api.sections.mockRejectedValueOnce(new Error("Defaults offline"));
  mount();
  await screen.findAllByText("Defaults could not be loaded. Retry before creating a job.");
  const button = screen.getByRole("button", { name: "New job" });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(screen.queryByLabelText("Job name")).toBeNull();
  expect(api.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry job defaults" }));
  await openNew();
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("America/Toronto");
  expect(screen.queryByRole("checkbox", { name: /Enable this job when saved/ })).toBeNull();
});

it("uses UTC and saves paused when no defaults have been saved", async () => {
  api.sections.mockResolvedValue([]);
  mount();
  await openNew();
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("UTC");
  change("Job name", "Paused without defaults");
  fireEvent.click(screen.getByRole("button", { name: "Save paused" }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ enabled: false, timeZone: "UTC" })));
});

it("labels retained defaults after a failed refresh and never resets an active pristine form", async () => {
  const client = mount();
  await openNew();
  api.sections.mockRejectedValueOnce(new Error("Refresh offline"));
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.settings.sections() }); });
  await screen.findAllByText("Defaults could not be refreshed. Showing the last loaded defaults.");
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("America/Toronto");
  section = { ...section, config: { defaultTimeZone: "Europe/Paris", enableOnCreate: true } };
  fireEvent.click(screen.getByRole("button", { name: "Retry job defaults" }));
  await waitFor(() => expect(api.sections).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(screen.queryAllByText("Defaults could not be refreshed. Showing the last loaded defaults.")).toHaveLength(0));
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("America/Toronto");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await openNew();
  expect((screen.getByLabelText("Time zone") as HTMLSelectElement).value).toBe("Europe/Paris");
});

it("keeps dirty edits through Keep editing and Escape, and returns focus after discard", async () => {
  mount();
  const edit = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(edit);
  change("Prompt", "Keep this unsaved prompt");
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus();
  fireEvent.click(cancel);
  let dialog = await screen.findByRole("alertdialog", { name: "Discard job changes?" });
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep editing" })));
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(document.activeElement).toBe(cancel));
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this unsaved prompt");
  fireEvent.click(cancel);
  dialog = await screen.findByRole("alertdialog");
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Keep this unsaved prompt");
  fireEvent.click(cancel);
  fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));
  await waitFor(() => expect(document.activeElement).toBe(edit));
  expect(screen.queryByLabelText("Prompt")).toBeNull();
  expect(api.update).not.toHaveBeenCalled();
});

it("compares dirty state with the opened draft, even if remote jobs refresh", async () => {
  const client = mount();
  const edit = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(edit);
  jobs = [{ ...job, input: { prompt: "Changed elsewhere" } }];
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.settings.scheduledJobs() }); });
  expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Read the news");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(document.activeElement).toBe(edit);
});

it("protects a dirty job from same-origin links and page unload", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
  change("Job name", "Unsaved name");
  const unload = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  const link = document.createElement("a");
  link.href = "/another-settings-page";
  document.body.append(link);
  const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
  link.dispatchEvent(click);
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(click.defaultPrevented).toBe(true);
  link.remove();
  confirm.mockRestore();
});

it("submits once while save is pending and returns to the surviving Edit control", async () => {
  let resolve!: (value: ScheduledJob) => void;
  api.update.mockImplementationOnce(() => new Promise<ScheduledJob>(done => { resolve = done; }));
  mount();
  const edit = await screen.findByRole("button", { name: "Edit" });
  fireEvent.click(edit);
  change("Prompt", "Saved prompt");
  const form = screen.getByLabelText("Prompt").closest("form")!;
  fireEvent.submit(form);
  fireEvent.submit(form);
  await screen.findByRole("button", { name: "Saving..." });
  expect(api.update).toHaveBeenCalledTimes(1);
  expect(screen.getByLabelText("Prompt").matches(":disabled")).toBe(true);
  expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Edit job" }));
  expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
  await act(async () => { jobs = [{ ...job, input: { prompt: "Saved prompt" } }]; resolve(jobs[0]); });
  await waitFor(() => expect(screen.queryByLabelText("Prompt")).toBeNull());
  expect(document.activeElement).toBe(edit);
});

it("keeps deletion named and locked while pending, then shows failure and retries in context", async () => {
  let reject!: (error: Error) => void;
  api.remove.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  mount();
  const opener = await screen.findByRole("button", { name: "Delete" });
  fireEvent.click(opener);
  const dialog = await screen.findByRole("alertdialog", { name: "Delete Morning digest?" });
  expect(within(dialog).getByText("This deletes the job and its run history. You cannot undo this action.")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Cancel" })));
  const decision = within(dialog).getByRole("button", { name: "Confirm delete" });
  fireEvent.click(decision);
  fireEvent.click(decision);
  await within(dialog).findByRole("button", { name: "Deleting..." });
  expect(api.remove).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(dialog);
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.getByRole("alertdialog")).toBe(dialog);
  await act(async () => reject(new Error("Delete unavailable")));
  const error = await within(dialog).findByRole("alert");
  expect(error).toHaveProperty("textContent", "Delete unavailable");
  expect(document.activeElement).toBe(error);
  expect(screen.getByText("Morning digest")).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Confirm delete" }));
  await screen.findByText("No scheduled jobs yet");
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Saved jobs" })));
  expect(api.remove).toHaveBeenCalledTimes(2);
});

it("returns cancelled deletion to its opener and successful deletion to the next job", async () => {
  jobs = [job, { ...job, jobId: "next-job", jobName: "Weekly report" }];
  mount();
  await screen.findByText("Morning digest");
  const opener = screen.getAllByRole("button", { name: "Delete" })[0];
  opener.focus();
  fireEvent.click(opener);
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(document.activeElement).toBe(opener));
  fireEvent.click(opener);
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm delete" }));
  await waitFor(() => expect(screen.queryByText("Morning digest")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit" })));
});

it("uses the DELETE acknowledgement when the list refresh fails without replaying the deletion", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Delete" }));
  api.list.mockRejectedValueOnce(new Error("List refresh unavailable"));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Confirm delete" }));
  await screen.findByText("Saved jobs could not be refreshed. Showing the last loaded jobs.");
  expect(screen.queryByText("Morning digest")).toBeNull();
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(api.remove).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Retry saved jobs" }));
  await screen.findByText("No scheduled jobs yet");
  expect(api.remove).toHaveBeenCalledTimes(1);
});

it("connects the Runs disclosure to a stable panel and retains known runs after failed refresh", async () => {
  const run: ScheduledJobRun = { runId: "run-1", jobId: job.jobId, userId: job.userId, sessionId: null, status: "failed", startedAt: job.createdAt, completedAt: job.updatedAt, durationMs: 1000, inputTokens: 0, outputTokens: 0, errorMessage: "Full provider failure", summary: "Full run summary", createdAt: job.createdAt };
  api.runs.mockResolvedValueOnce([run]);
  const client = mount();
  const button = await screen.findByRole("button", { name: "Runs" });
  const id = button.getAttribute("aria-controls")!;
  expect(document.getElementById(id)).toBeTruthy();
  expect(button.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(button);
  await screen.findByText("Full run summary");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(id)?.contains(screen.getByRole("region", { name: "Runs for Morning digest" }))).toBe(true);
  api.runs.mockRejectedValueOnce(new Error("Run refresh offline"));
  await act(async () => { await client.invalidateQueries({ queryKey: queryKeys.settings.scheduledJobRuns(job.jobId) }); });
  await screen.findByText("Showing the last loaded runs.");
  expect(screen.getByText("Full provider failure")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  expect(button.getAttribute("aria-expanded")).toBe("false");
  expect(document.getElementById(id)?.hidden).toBe(true);
});

it.each(["jobs", "defaults", "expanded defaults", "runs"] as const)("restores visible focus after the %s read retry", async (kind) => {
  const source = kind === "jobs" ? api.list : kind === "runs" ? api.runs : api.sections;
  source.mockRejectedValueOnce(new Error("Read unavailable"));
  mount();
  if (kind !== "jobs") await screen.findByRole("button", { name: "Edit" });
  if (kind === "runs") fireEvent.click(screen.getByRole("button", { name: "Runs" }));
  if (kind === "expanded defaults") fireEvent.click(screen.getByText("Defaults for new jobs"));
  const name = kind === "jobs" ? "Retry saved jobs" : kind === "runs" ? "Retry runs" : kind === "defaults" ? "Retry job defaults" : "Retry defaults load";
  const retry = await screen.findByRole("button", { name });
  let resolve!: (value: unknown) => void;
  source.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  retry.focus();
  fireEvent.click(retry);
  await waitFor(() => expect(source).toHaveBeenCalledTimes(2));
  // Chrome drops focus when a pending control becomes disabled; jsdom does not.
  document.body.tabIndex = -1;
  document.body.focus();
  document.body.removeAttribute("tabindex");
  await act(async () => resolve(kind === "jobs" ? [job] : kind === "runs" ? [] : [section]));
  await waitFor(() => expect(screen.queryByRole("button", { name })).toBeNull());
  const target = kind === "runs" ? screen.getByRole("button", { name: "Runs" }) : kind === "expanded defaults" ? screen.getByText("Defaults for new jobs") : screen.getByRole("heading", { name: "Saved jobs" });
  await waitFor(() => expect(document.activeElement).toBe(target));
});

it("preserves a field chosen while a defaults retry waits", async () => {
  api.sections.mockRejectedValueOnce(new Error("Read unavailable"));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry job defaults" });
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  let resolve!: (value: UserSettingsSection[]) => void;
  api.sections.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  retry.focus();
  fireEvent.click(retry);
  const prompt = screen.getByLabelText("Prompt");
  prompt.focus();
  await act(async () => resolve([section]));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry job defaults" })).toBeNull());
  expect(document.activeElement).toBe(prompt);
});
