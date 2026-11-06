// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AdminSkillReleaseImpact } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { ReleaseImpactStep } from "./release-impact-step";

const auth = vi.hoisted(() => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
beforeEach(() => { auth.user = { tenantId: "tenant-a", userId: "admin-a" }; });
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

it.each([
  ["off", "test-users", 2, 0], ["off", "members", 10, 0],
  ["test-users", "members", 8, 0], ["members", "test-users", 0, 8],
  ["members", "off", 0, 10], ["test-users", "off", 0, 2]
] as const)("reviews %s to %s with member counts separate from saved references", async (current, proposed, gaining, losing) => {
  const preview = { ...impact, current: { ...impact.current, audience: current }, proposed: { ...impact.proposed, audience: proposed }, members: { ...impact.members, gaining, losing } };
  const confirm = vi.fn(async () => undefined);
  render(<ReleaseImpactStep choiceKey={proposed} load={async () => preview} confirm={confirm} confirmLabel="Confirm change" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  await screen.findByRole("button", { name: "Confirm change" });
  expect(screen.getByText(new RegExp(`${gaining} members become eligible; ${losing} are no longer eligible`))).toBeTruthy();
  expect(screen.getByText("Chats: 5 inherit defaults, 6 select it")).toBeTruthy();
  expect(screen.getByText(/Changes take effect on the next turn/)).toBeTruthy();
  expect(confirm).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
  await waitFor(() => expect(confirm).toHaveBeenCalledExactlyOnceWith(preview.snapshot));
});

it.each(["tenantId", "userId"] as const)("invalidates a pending preview immediately when %s changes", async field => {
  const old = deferred<AdminSkillReleaseImpact>();
  const load = vi.fn().mockReturnValueOnce(old.promise).mockResolvedValue(impact);
  const props = { choiceKey: "members", load, confirm: vi.fn(async () => undefined), confirmLabel: "Confirm release" };
  const view = render(<ReleaseImpactStep {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  auth.user = { ...auth.user, [field]: "other" };
  view.rerender(<ReleaseImpactStep {...props} />);
  const fresh = screen.getByRole("button", { name: "Preview impact" });
  expect(fresh).toHaveProperty("disabled", false);
  fireEvent.click(fresh);
  await screen.findByRole("button", { name: "Confirm release" });
  await act(async () => old.resolve({ ...impact, proposed: { ...impact.proposed, revisionNumber: 99 } }));
  expect(screen.queryByText("Revision 99 · All members")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(props.confirm).toHaveBeenCalledExactlyOnceWith(impact.snapshot));
});

it("does not restore a reviewed snapshot when the choice changes away and back", async () => {
  const props = { load: async () => impact, confirm: vi.fn(), confirmLabel: "Confirm release" };
  const view = render(<ReleaseImpactStep {...props} choiceKey="members" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  await screen.findByRole("button", { name: "Confirm release" });
  view.rerender(<ReleaseImpactStep {...props} choiceKey="off" />);
  view.rerender(<ReleaseImpactStep {...props} choiceKey="members" />);
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
  expect(screen.getByRole("button", { name: "Preview impact" })).toBeTruthy();
});

it("discards an old preview even if the choice changes away and back before it settles", async () => {
  const old = deferred<AdminSkillReleaseImpact>();
  const props = { load: () => old.promise, confirm: vi.fn(), confirmLabel: "Confirm release" };
  const view = render(<ReleaseImpactStep {...props} choiceKey="members" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  view.rerender(<ReleaseImpactStep {...props} choiceKey="off" />);
  view.rerender(<ReleaseImpactStep {...props} choiceKey="members" />);
  await act(async () => old.resolve(impact));
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
});

it.each(["choice", "scope", "unmount"] as const)("ignores a late confirmation access failure after %s changes", async change => {
  const pending = deferred<void>();
  const onAccessError = vi.fn();
  const props = { load: async () => impact, confirm: () => pending.promise, confirmLabel: "Confirm release", onAccessError };
  const view = render(<ReleaseImpactStep {...props} choiceKey="members" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  if (change === "scope") auth.user = { ...auth.user, userId: "other-admin" };
  if (change === "unmount") view.unmount();
  else view.rerender(<ReleaseImpactStep {...props} choiceKey={change === "choice" ? "off" : "members"} />);
  await act(async () => pending.reject(new ApiError({ status: 403, method: "POST", path: "/publish", message: "Old actor lost access" })));
  expect(screen.queryByRole("alert")).toBeNull();
  expect(onAccessError).not.toHaveBeenCalled();
});

it("keeps errors local to the reviewed choice", async () => {
  const props = { load: vi.fn().mockRejectedValue(new Error("Unavailable for members")), confirm: vi.fn(), confirmLabel: "Confirm release" };
  const view = render(<ReleaseImpactStep {...props} choiceKey="members" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  await screen.findByRole("alert");
  view.rerender(<ReleaseImpactStep {...props} choiceKey="off" />);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Preview impact" })).toBeTruthy();
});

it.each([409, 503])("blocks confirmation after an invalid or unavailable preview, status %s", async status => {
  const confirm = vi.fn();
  const load = vi.fn().mockRejectedValue(new ApiError({ status, method: "POST", path: "/release-impact", message: status === 409 ? "Revision is not valid for release" : "Preview unavailable" }));
  render(<ReleaseImpactStep choiceKey="members" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  await screen.findByRole("alert");
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
  expect(confirm).not.toHaveBeenCalled();
});

it("requires a reread after an uncertain failure and confirms only the new snapshot", async () => {
  const reread = { ...impact, snapshot: { ...impact.snapshot, version: 4, activeRevisionId: 12, isPublished: true }, current: { ...impact.proposed } };
  const load = vi.fn().mockResolvedValueOnce(impact).mockResolvedValueOnce(reread);
  const confirm = vi.fn().mockRejectedValueOnce(new ApiError({ status: 500, method: "POST", path: "/publish", message: "Internal server error" })).mockResolvedValueOnce(undefined);
  render(<ReleaseImpactStep choiceKey="members" load={load} confirm={confirm} confirmLabel="Confirm release" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("may have completed"));
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Refresh impact" }));
  fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  await waitFor(() => expect(confirm).toHaveBeenNthCalledWith(2, reread.snapshot));
});

it.each([true, false])("preserves another control's focus when preview resolves successfully=%s", async success => {
  const pending = deferred<AdminSkillReleaseImpact>();
  render(<><input aria-label="Other review" /><ReleaseImpactStep choiceKey="members" load={() => pending.promise} confirm={vi.fn()} confirmLabel="Confirm release" /></>);
  const trigger = screen.getByRole("button", { name: "Preview impact" });
  trigger.focus(); fireEvent.click(trigger);
  const other = screen.getByRole("textbox", { name: "Other review" }); other.focus();
  await act(async () => success ? pending.resolve(impact) : pending.reject(new Error("Preview unavailable")));
  expect(document.activeElement).toBe(other);
});

it("returns focus to preview after confirmation only when the action owns focus", async () => {
  const pending = deferred<void>();
  render(<ReleaseImpactStep choiceKey="members" load={async () => impact} confirm={() => pending.promise} confirmLabel="Confirm release" />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  const button = await screen.findByRole("button", { name: "Confirm release" });
  button.focus(); fireEvent.click(button);
  await act(async () => pending.resolve());
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Preview impact" }));
});

it("disables refresh as well as confirm while the parent disallows release", async () => {
  const props = { choiceKey: "members", load: vi.fn(async () => impact), confirm: vi.fn(), confirmLabel: "Confirm release" };
  const view = render(<ReleaseImpactStep {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  await screen.findByRole("button", { name: "Confirm release" });
  view.rerender(<ReleaseImpactStep {...props} disabled />);
  expect(screen.getByRole("button", { name: "Confirm release" })).toHaveProperty("disabled", true);
  expect(screen.getByRole("button", { name: "Refresh impact" })).toHaveProperty("disabled", true);
});

it.each([
  ["preview", 401], ["preview", 403], ["confirm", 401], ["confirm", 403]
] as const)("reports a current %s permission failure with status %s to the caller", async (phase, status) => {
  const failure = new ApiError({ status, method: "POST", path: "/admin/skills/briefing", message: "Access is no longer available" });
  const onAccessError = vi.fn();
  const load = vi.fn().mockImplementation(async () => { if (phase === "preview") throw failure; return impact; });
  const confirm = vi.fn().mockRejectedValue(failure);
  render(<ReleaseImpactStep choiceKey="members" load={load} confirm={confirm} confirmLabel="Confirm release" onAccessError={onAccessError} />);
  fireEvent.click(screen.getByRole("button", { name: "Preview impact" }));
  if (phase === "confirm") fireEvent.click(await screen.findByRole("button", { name: "Confirm release" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining(failure.message));
  expect(onAccessError).toHaveBeenCalledExactlyOnceWith(failure);
  expect(screen.queryByRole("button", { name: "Confirm release" })).toBeNull();
});
