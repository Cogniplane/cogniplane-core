// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { AdminSkillReleaseImpact } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { ReleaseImpactStep } from "./release-impact-step";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
afterEach(cleanup);
const impact: AdminSkillReleaseImpact = {
  skillId: "briefing", snapshot: { version: 3, activeRevisionId: 11, latestRevisionId: 12, enabled: true, isPublished: false },
  current: { revisionId: 11, revisionNumber: 2, audience: "test-users" }, proposed: { revisionId: 12, revisionNumber: 3, audience: "members" },
  members: { total: 10, testUsers: 2, gaining: 8, losing: 0 },
  configuredReferences: { projects: { inherited: 1, explicitSelected: 2 }, personalDefaults: { inherited: 3, explicitSelected: 4 },
    sessions: { inherited: 5, explicitSelected: 6 } }
};

it("loads a readable preview and requires a separate confirm action", async () => {
  const load = vi.fn(async () => impact);
  const confirm = vi.fn(async () => undefined);
  render(<ReleaseImpactStep choiceKey="revision-12:members" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  const trigger = screen.getByRole("button", { name: "Preview impact" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(confirm).not.toHaveBeenCalled();
  expect(await screen.findByText("Revision 3 · All members")).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Release impact" })));
  expect(screen.getByText(/8 members become eligible/)).toBeTruthy();
  expect(screen.getByText(/saved settings, not affected chats/)).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith(impact.snapshot));
});

it("discards an in-flight preview when the choice changes", async () => {
  let finish!: (value: AdminSkillReleaseImpact) => void;
  const load = vi.fn(() => new Promise<AdminSkillReleaseImpact>((resolve) => { finish = resolve; }));
  const confirm = vi.fn(async () => undefined);
  const view = render(<ReleaseImpactStep choiceKey="members" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  view.rerender(<ReleaseImpactStep choiceKey="test-users" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  finish(impact);
  await waitFor(() => expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull());
  expect(confirm).not.toHaveBeenCalled();
});

it("blocks a second submit and makes a stale snapshot require a fresh preview", async () => {
  let fail!: (error: Error) => void;
  const load = vi.fn(async () => impact);
  const confirm = vi.fn(() => new Promise<void>((_resolve, reject) => { fail = reject; }));
  render(<ReleaseImpactStep choiceKey="members" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  const button = await screen.findByRole("button", { name: "Confirm release" });
  button.focus();
  fireEvent.click(button); fireEvent.click(button);
  expect(confirm).toHaveBeenCalledTimes(1);
  fail(new ApiError({ status: 409, code: "stale_release_preview", method: "POST", path: "/admin/skills/briefing/publish", message: "Stale" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Refresh the impact"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh impact" }));
  expect(await screen.findByRole("button", { name: "Confirm release" })).toBeTruthy();
  expect(load).toHaveBeenCalledTimes(2);
});

it("offers retry when preview fails, with no confirm action", async () => {
  let failPreview!: (error: Error) => void;
  const load = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { failPreview = reject; })).mockResolvedValueOnce(impact);
  render(<ReleaseImpactStep choiceKey="members" load={load} confirm={vi.fn()} confirmLabel="Confirm release" />);
  const trigger = screen.getByRole("button", { name: "Preview impact" });
  trigger.focus();
  fireEvent.click(trigger);
  trigger.blur();
  failPreview(new Error("Preview unavailable"));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("Preview unavailable"));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("alert")));
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh impact" }));
  expect(await screen.findByRole("button", { name: "Confirm release" })).toBeTruthy();
});
