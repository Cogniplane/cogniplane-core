// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelSpendingReservation, ModelSpendingResponse } from "@cogniplane/shared-types";

import { ApiError } from "../../../lib/api-client";
import { utcMonth } from "../../../lib/model-budget";
import {
  closeModelSpendingReservation,
  getModelSpending,
  reconcileModelSpendingReservation,
  updateModelSpendingPolicy
} from "../../../lib/model-spending-api";
import { ModelBudgetPanel } from "./model-budget-panel";

const nav = vi.hoisted(() => ({ query: "", replace: vi.fn() }));
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(nav.query),
  useRouter: () => ({ replace: nav.replace, push: vi.fn() }),
  usePathname: () => "/admin/token-usage"
}));
vi.mock("../../../lib/model-spending-api", () => ({
  getModelSpending: vi.fn(),
  updateModelSpendingPolicy: vi.fn(),
  closeModelSpendingReservation: vi.fn(),
  reconcileModelSpendingReservation: vi.fn()
}));

const month = utcMonth();
const now = new Date();
const olderMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);

function reservation(id: string, overrides: Partial<ModelSpendingReservation> = {}): ModelSpendingReservation {
  return { reservationId: id, sessionId: `session-${id}`, turnContext: "interactive", period: month, status: "reserved",
    chargedMicroUsd: 1_000_000, updatedAt: "2026-09-27T12:00:00.000Z", ...overrides };
}

function spending(overrides: Partial<ModelSpendingResponse> & { limit?: number | null; version?: number } = {}): ModelSpendingResponse {
  const { limit = 100, version = 3, ...rest } = overrides;
  return { policy: { monthlyLimitUsd: limit, turnReservationUsd: 1, version }, chargedUsd: 84.2,
    activeReservations: 2, unknownReservations: 0, unresolved: [], nextCursor: null, ...rest };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const conflict = () => new ApiError({ status: 409, method: "PUT", path: "/admin/model-spending", message: "Spending policy changed." });

let client: QueryClient;
beforeEach(() => {
  nav.query = "";
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(getModelSpending).mockResolvedValue(spending());
});
afterEach(() => { cleanup(); client.clear(); vi.resetAllMocks(); vi.useRealTimers(); });

function mount() {
  render(<QueryClientProvider client={client}><ModelBudgetPanel /></QueryClientProvider>);
}

async function openEditor() {
  mount();
  const trigger = await screen.findByRole("button", { name: "Change budget" });
  fireEvent.click(trigger);
  return { trigger, dialog: await screen.findByRole("dialog") };
}

function limitInput(dialog: HTMLElement) {
  return within(dialog).getByLabelText("Limit per month (USD)") as HTMLInputElement;
}

describe("status", () => {
  it("shows the month status with held amounts, remaining allowance, and no settings form", async () => {
    mount();
    expect(await screen.findByText("Near the limit")).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "Monthly budget used" });
    expect(meter.getAttribute("aria-valuenow")).toBe("84");
    expect(meter.getAttribute("aria-valuetext")).toBe("$84.20 of $100.00 charged or held, 84%. The next turn's hold fits.");
    expect(screen.getByText("Room to start 15 more turns at $1.00 each.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Remaining").nextElementSibling?.textContent).toBe("$15.80");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
  });

  it("shows stored millionths and names the warning line only in the legend", async () => {
    vi.mocked(getModelSpending).mockResolvedValue({ ...spending({ limit: 1.000001, chargedUsd: 0 }), policy: { monthlyLimitUsd: 1.000001, turnReservationUsd: 1.000002, version: 3 } });
    mount();
    expect(await screen.findByText("New turns blocked")).toBeTruthy();
    const meter = screen.getByRole("progressbar", { name: "Monthly budget used" });
    expect(meter.getAttribute("aria-valuetext")).toBe("$0.00 of $1.000001 charged or held, 0%. The next turn's hold does not fit.");
    expect(screen.getByText("Hold per turn").nextElementSibling?.textContent).toBe("$1.000002");
    expect(screen.queryByText("80%")).toBeNull();
    expect(screen.getByText("Warning at 80%")).toBeTruthy();
  });

  it("refreshes when the page gets focus again", async () => {
    mount();
    expect(await screen.findByText("Near the limit")).toBeTruthy();
    vi.mocked(getModelSpending).mockResolvedValue(spending({ chargedUsd: 10 }));
    act(() => { window.dispatchEvent(new Event("visibilitychange")); });
    expect(await screen.findByText("Budget allows new turns")).toBeTruthy();
  });

  it("moves to the new UTC month on focus after a suspended tab, and keeps an open draft", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:00.000Z"));
    const { dialog } = await openEditor();
    expect(screen.getByText(/^September 2026, UTC\./)).toBeTruthy();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });

    const october = deferred<ModelSpendingResponse>();
    vi.mocked(getModelSpending).mockReturnValue(october.promise);
    vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z"));
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText(/^October 2026, UTC\./)).toBeTruthy();
    // The September summary only keeps the dialog: no status until October loads.
    expect(screen.queryByText("Near the limit")).toBeNull();
    expect(limitInput(screen.getByRole("dialog")).value).toBe("150");

    october.resolve(spending({ chargedUsd: 0 }));
    expect(await screen.findByText("Budget allows new turns")).toBeTruthy();
    expect(limitInput(screen.getByRole("dialog")).value).toBe("150");
  });

  it("keeps an open draft when the new month's first load fails, without showing old totals", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:00.000Z"));
    const { dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });
    expect(within(dialog).getByText(/^After you save:/)).toBeTruthy();

    vi.mocked(getModelSpending).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z"));
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("Could not check the model budget. Its status is unknown.")).toBeTruthy();
    expect(screen.getByText(/^October 2026, UTC\./)).toBeTruthy();
    expect(screen.queryByText("Near the limit")).toBeNull();
    expect(screen.queryByRole("progressbar")).toBeNull();
    // Same dialog, same draft, and no preview built from September's totals.
    expect(screen.getByRole("dialog")).toBe(dialog);
    expect(limitInput(dialog).value).toBe("150");
    expect(within(dialog).queryByText(/^After you save:/)).toBeNull();

    // The saved policy version still applies once October loads.
    vi.mocked(getModelSpending).mockResolvedValue(spending({ chargedUsd: 0 }));
    vi.mocked(updateModelSpendingPolicy).mockResolvedValue(spending({ limit: 150, chargedUsd: 0, version: 4 }));
    await act(() => client.refetchQueries());
    expect(await screen.findByText("Budget allows new turns")).toBeTruthy();
    expect(limitInput(dialog).value).toBe("150");
    expect(within(dialog).getByText(/^After you save:/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(updateModelSpendingPolicy).toHaveBeenCalledWith({ monthlyLimitUsd: 150, turnReservationUsd: 1, version: 3 }));
  });

  it("does not claim a block without a limit, even with unknown usage", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ limit: null, chargedUsd: 3, unknownReservations: 1 }));
    mount();
    expect(await screen.findByText("No limit")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set a limit" })).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
    expect(screen.queryByText(/blocked/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Advanced: unresolved reservations/ }));
    expect(screen.getByText(/They do not block new turns while there is no limit/)).toBeTruthy();
  });

  it("shows no state after a failed check, then retries", async () => {
    vi.mocked(getModelSpending).mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(spending({ limit: 0, chargedUsd: 0 }));
    mount();
    expect((await screen.findByRole("alert")).textContent).toBe("Could not check the model budget. Its status is unknown.");
    expect(screen.queryByText("Budget allows new turns")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change budget" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry budget check" }));
    expect(await screen.findByText("New turns paused")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });
});

describe("budget dialog", () => {
  it("validates inline and tells blank apart from zero", async () => {
    const { dialog } = await openEditor();
    const input = limitInput(dialog);
    expect(input.value).toBe("100");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(within(dialog).getByText("Enter a monthly limit, or pick No limit.")).toBeTruthy();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    fireEvent.change(input, { target: { value: "0" } });
    expect(within(dialog).getByText(/Enter an amount above \$0\. To pause all new turns/)).toBeTruthy();
    const hold = within(dialog).getByLabelText("Hold per turn (USD)");
    fireEvent.change(hold, { target: { value: "1e3" } });
    fireEvent.blur(hold);
    expect(within(dialog).getByText("Use digits and one decimal point, for example 250.00.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(updateModelSpendingPolicy).not.toHaveBeenCalled();
  });

  it("saves with the opened version, closes, announces, and returns focus", async () => {
    vi.mocked(updateModelSpendingPolicy).mockResolvedValue(spending({ limit: 150, version: 4 }));
    const { trigger, dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });
    expect(within(dialog).getByText("After you save: budget allows new turns")).toBeTruthy();
    vi.mocked(getModelSpending).mockResolvedValue(spending({ limit: 150, version: 4 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateModelSpendingPolicy).toHaveBeenCalledWith({ monthlyLimitUsd: 150, turnReservationUsd: 1, version: 3 });
    expect(screen.getByText("Budget saved. Limit $150.00, hold per turn $1.00. It applies to new turns.")).toBeTruthy();
    expect(screen.getByText("Budget allows new turns")).toBeTruthy();
    expect(document.activeElement).toBe(trigger);
  });

  it("says what the server stored when it rounds a typed amount up", async () => {
    const stored = spending({ limit: 4.030001, version: 4 });
    vi.mocked(updateModelSpendingPolicy).mockResolvedValue(stored);
    const { dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "4.03" } });
    vi.mocked(getModelSpending).mockResolvedValue(stored);
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(updateModelSpendingPolicy).toHaveBeenCalledWith({ monthlyLimitUsd: 4.03, turnReservationUsd: 1, version: 3 });
    expect(screen.getByText("Budget saved. Limit $4.030001, hold per turn $1.00. It applies to new turns. The server rounds up to a whole $0.000001, so a stored amount differs from what you entered.")).toBeTruthy();
    expect(screen.getByText(/of \$4\.030001 charged or held/)).toBeTruthy();
  });

  it("keeps the draft on a conflict and saves again only after the admin reviews the current budget", async () => {
    vi.mocked(updateModelSpendingPolicy).mockRejectedValueOnce(conflict()).mockResolvedValueOnce(spending({ limit: 150, version: 5 }));
    const { dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));

    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/Someone else changed the budget.*Your draft is kept/);
    expect(limitInput(dialog).value).toBe("150");
    expect((within(dialog).getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled).toBe(true);
    expect(updateModelSpendingPolicy).toHaveBeenCalledTimes(1);

    vi.mocked(getModelSpending).mockResolvedValue(spending({ limit: 120, version: 4 }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Load current budget" }));
    expect(await within(dialog).findByText("Compare before you save")).toBeTruthy();
    expect(within(dialog).getByText("Limit $120.00, hold per turn $1.00")).toBeTruthy();
    expect(within(dialog).getByText("Limit $150.00, hold per turn $1.00")).toBeTruthy();
    expect(limitInput(dialog).value).toBe("150");

    fireEvent.click(within(dialog).getByRole("button", { name: "Save my draft" }));
    await waitFor(() => expect(updateModelSpendingPolicy).toHaveBeenCalledTimes(2));
    expect(vi.mocked(updateModelSpendingPolicy).mock.calls[1]![0]).toEqual({ monthlyLimitUsd: 150, turnReservationUsd: 1, version: 4 });
  });

  it("blocks a save when a newer version arrives while the dialog is open", async () => {
    const { dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });
    vi.mocked(getModelSpending).mockResolvedValue(spending({ limit: 90, version: 4 }));
    await client.refetchQueries();
    expect(await within(dialog).findByText(/Someone else changed the budget/)).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Save budget" }) as HTMLButtonElement).disabled).toBe(true);
    expect(limitInput(dialog).value).toBe("150");
  });

  it("keeps a retryable draft after a network failure", async () => {
    vi.mocked(updateModelSpendingPolicy).mockRejectedValueOnce(new TypeError("Failed to fetch")).mockResolvedValueOnce(spending({ limit: 150, version: 4 }));
    const { dialog } = await openEditor();
    fireEvent.change(limitInput(dialog), { target: { value: "150" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not save the budget. Your changes are kept. Try again.");
    expect(limitInput(dialog).value).toBe("150");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(vi.mocked(updateModelSpendingPolicy).mock.calls[1]![0]).toEqual({ monthlyLimitUsd: 150, turnReservationUsd: 1, version: 3 });
  });

  it("confirms the consequences before pausing new turns with a $0 limit", async () => {
    vi.mocked(updateModelSpendingPolicy).mockResolvedValue(spending({ limit: 0, version: 4 }));
    const { dialog } = await openEditor();
    fireEvent.click(within(dialog).getByRole("radio", { name: /Pause new turns/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(within(dialog).getByRole("heading", { name: "Pause new turns?" })).toBeTruthy();
    expect(dialog.textContent).toContain("The pause continues into the next month.");
    expect(dialog.textContent).toContain("Turns that already hold a reservation keep it and can continue within it.");
    expect(dialog.textContent).not.toMatch(/turn off|model work is off/i);
    expect(updateModelSpendingPolicy).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause new turns" }));
    await waitFor(() => expect(updateModelSpendingPolicy).toHaveBeenCalledWith({ monthlyLimitUsd: 0, turnReservationUsd: 1, version: 3 }));
  });

  it("confirms the consequences before removing the limit, and Back saves nothing", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unknownReservations: 1 }));
    const { dialog } = await openEditor();
    fireEvent.click(within(dialog).getByRole("radio", { name: /No limit/ }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Save budget" }));
    expect(within(dialog).getByRole("heading", { name: "Remove the monthly limit?" })).toBeTruthy();
    expect(dialog.textContent).toContain("Unknown usage stops blocking new turns.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Back" }));
    expect((within(dialog).getByRole("radio", { name: /No limit/ }) as HTMLInputElement).checked).toBe(true);
    expect(updateModelSpendingPolicy).not.toHaveBeenCalled();
  });

  it("opens from an Overview link once the budget is loaded, and clears the link on close", async () => {
    nav.query = "budget=edit";
    mount();
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(nav.replace).toHaveBeenCalledWith("/admin/token-usage", { scroll: false });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Change budget" }));
  });
});

describe("recovery", () => {
  function openRecovery() {
    nav.query = "budget=recovery";
    mount();
  }

  it("opens from the work-queue link and pages without duplicates", async () => {
    vi.mocked(getModelSpending).mockImplementation(async (cursor) => cursor === "c1"
      ? spending({ unresolved: [reservation("r-2"), reservation("r-3", { status: "unknown", period: olderMonth })], nextCursor: null })
      : spending({ unknownReservations: 0, unresolved: [reservation("r-1"), reservation("r-2")], nextCursor: "c1" }));
    openRecovery();
    const list = await screen.findByRole("list", { name: "Unresolved reservations list" });
    expect(screen.getByRole("button", { name: /Advanced: unresolved reservations/ }).getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("This month: 2 active, 0 with unknown usage.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more reservations" }));
    await waitFor(() => expect(within(list).getAllByRole("listitem")).toHaveLength(3));
    expect(getModelSpending).toHaveBeenLastCalledWith("c1");
    expect(within(list).getByText("Earlier month, does not block")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Load more reservations" })).toBeNull();
  });

  it("confirms a close, shows it pending, and reloads only the first page", async () => {
    vi.mocked(getModelSpending).mockImplementation(async (cursor) => cursor === "c1"
      ? spending({ unresolved: [reservation("r-9")], nextCursor: null })
      : spending({ unresolved: [reservation("r-1")], nextCursor: "c1" }));
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Load more reservations" }));
    await screen.findByText("r-9");

    const pending = deferred<void>();
    vi.mocked(closeModelSpendingReservation).mockReturnValue(pending.promise);
    const trigger = screen.getAllByRole("button", { name: "Close reservation…" })[0]!;
    fireEvent.click(trigger);
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Requests already sent to a provider keep running. Closing does not cancel them.");
    expect(dialog.textContent).toContain("No new turn can start this month until you reconcile it.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close reservation" }));
    expect(await within(dialog).findByRole("button", { name: "Closing…" })).toBeTruthy();

    vi.mocked(getModelSpending).mockClear();
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unknownReservations: 1, unresolved: [reservation("r-1", { status: "unknown" })], nextCursor: "c1" }));
    pending.resolve();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(closeModelSpendingReservation).toHaveBeenCalledWith("r-1");
    expect(vi.mocked(getModelSpending).mock.calls).toEqual([[null]]);
    expect(screen.queryByText("r-9")).toBeNull();
    expect(screen.getByText("Reservation closed. Its usage is now unknown and it needs reconciliation.")).toBeTruthy();
    expect(document.activeElement?.textContent).toBe("Reconcile…");
  });

  it("keeps a failed close retryable", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-1")] }));
    vi.mocked(closeModelSpendingReservation).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Close reservation…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Close reservation" }));
    expect((await within(dialog).findByRole("alert")).textContent).toBe("Could not close the reservation. Try again.");
    expect(within(dialog).getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("refreshes and asks for review when a close meets a changed reservation", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-1")] }));
    vi.mocked(closeModelSpendingReservation).mockRejectedValue(conflict());
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Close reservation…" }));
    const dialog = await screen.findByRole("alertdialog");
    vi.mocked(getModelSpending).mockClear();
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [] }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close reservation" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/changed after the list loaded/);
    expect(within(dialog).queryByRole("button", { name: /Close reservation|Try again/ })).toBeNull();
    expect(await within(dialog).findByText(/The list is now current\. Review it before you act\./)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Back to the list" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(await screen.findByText("No unresolved reservations.")).toBeTruthy();
    // The row is gone, so focus goes to the section control.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /Advanced: unresolved reservations/ }));
    expect(closeModelSpendingReservation).toHaveBeenCalledTimes(1);
  });

  it("does not claim a current list when the reload after a conflict fails", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-1")] }));
    vi.mocked(closeModelSpendingReservation).mockRejectedValue(conflict());
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Close reservation…" }));
    const dialog = await screen.findByRole("alertdialog");
    vi.mocked(getModelSpending).mockRejectedValue(new TypeError("Failed to fetch"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Close reservation" }));
    expect(await within(dialog).findByText(/Could not load the list again\./)).toBeTruthy();
    expect(dialog.textContent).not.toContain("now current");
    // The failed reload hides the list, but the open dialog stays.
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect(screen.queryByRole("list", { name: "Unresolved reservations list" })).toBeNull();
    expect(closeModelSpendingReservation).toHaveBeenCalledTimes(1);
  });

  it("keeps a typed cost when a background check fails", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-u", { status: "unknown" })] }));
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Verified total cost (USD)"), { target: { value: "1.5" } });
    vi.mocked(getModelSpending).mockRejectedValue(new TypeError("Failed to fetch"));
    await act(() => client.refetchQueries());
    expect(await screen.findByText("Could not check the model budget. Its status is unknown.")).toBeTruthy();
    expect((within(screen.getByRole("alertdialog")).getByLabelText("Verified total cost (USD)") as HTMLInputElement).value).toBe("1.5");
  });

  it("keeps a typed cost when the new month's first load fails", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:00.000Z"));
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-u", { status: "unknown", period: "2026-09" })] }));
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Verified total cost (USD)"), { target: { value: "1.5" } });

    vi.mocked(getModelSpending).mockRejectedValue(new TypeError("Failed to fetch"));
    vi.setSystemTime(new Date("2026-10-01T08:00:00.000Z"));
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(await screen.findByText("Could not check the model budget. Its status is unknown.")).toBeTruthy();
    expect(screen.getByText(/^October 2026, UTC\./)).toBeTruthy();
    expect(screen.queryByRole("list", { name: "Unresolved reservations list" })).toBeNull();
    expect(screen.getByRole("alertdialog")).toBe(dialog);
    expect((within(dialog).getByLabelText("Verified total cost (USD)") as HTMLInputElement).value).toBe("1.5");
  });

  it("never prefills a cost and needs both acknowledgements before reconciling", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unknownReservations: 1, unresolved: [reservation("r-u", { status: "unknown", chargedMicroUsd: 2_500_000 })] }));
    vi.mocked(reconcileModelSpendingReservation).mockResolvedValue(undefined);
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const dialog = await screen.findByRole("alertdialog");
    const amount = within(dialog).getByLabelText("Verified total cost (USD)") as HTMLInputElement;
    expect(amount.value).toBe("");
    expect(dialog.textContent).toContain("Held now: $2.50");
    expect(dialog.textContent).toContain("You cannot undo or repeat this.");

    fireEvent.click(within(dialog).getByRole("button", { name: "Record verified cost" }));
    expect(within(dialog).getByText("Enter the verified total cost.")).toBeTruthy();
    expect(within(dialog).getByText("Confirm both statements before you record the cost.")).toBeTruthy();
    fireEvent.change(amount, { target: { value: "0.42" } });
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "No provider request from this turn is still running." }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record verified cost" }));
    expect(reconcileModelSpendingReservation).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("checkbox", { name: "This total comes from provider records and recorded call usage." }));
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [] }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Record verified cost" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(reconcileModelSpendingReservation).toHaveBeenCalledWith("r-u", 0.42);
    expect(screen.getByText("Verified cost of $0.42 recorded. The reservation is settled.")).toBeTruthy();
  });

  it("does not repeat a reconciliation after a conflict", async () => {
    vi.mocked(getModelSpending).mockResolvedValue(spending({ unresolved: [reservation("r-u", { status: "unknown" })] }));
    vi.mocked(reconcileModelSpendingReservation).mockRejectedValue(new ApiError({ status: 409, method: "POST", path: "/admin/model-spending/r-u/reconcile", message: "Only an unresolved reservation can be reconciled." }));
    openRecovery();
    fireEvent.click(await screen.findByRole("button", { name: "Reconcile…" }));
    const dialog = await screen.findByRole("alertdialog");
    fireEvent.change(within(dialog).getByLabelText("Verified total cost (USD)"), { target: { value: "1" } });
    for (const box of within(dialog).getAllByRole("checkbox")) fireEvent.click(box);
    fireEvent.click(within(dialog).getByRole("button", { name: "Record verified cost" }));
    expect((await within(dialog).findByRole("alert")).textContent).toMatch(/changed after the list loaded/);
    expect(within(dialog).queryByRole("button", { name: /Record verified cost|Try again/ })).toBeNull();
    expect(reconcileModelSpendingReservation).toHaveBeenCalledTimes(1);
  });
});
