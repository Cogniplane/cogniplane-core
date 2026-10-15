// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { OrganizationSkillSubmissionUpdate } from "@cogniplane/shared-types";
import { ApiError } from "@/lib/api-client";
import { listMySkillSubmissionUpdates, readMySkillSubmissionUpdate } from "@/lib/organization-skill-submissions-api";
import SkillUpdatesPage from "./page";

vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "author-a" } }) }));
vi.mock("@/lib/organization-skill-submissions-api", () => ({ listMySkillSubmissionUpdates: vi.fn(), readMySkillSubmissionUpdate: vi.fn() }));
const scope = { tenantId: "tenant-a", userId: "author-a" };
const update = (id: string): OrganizationSkillSubmissionUpdate => ({
  id, submissionId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb", attempt: 1, kind: "changes_requested",
  skillName: `Skill ${id[0]}`, feedback: "Add an example", organizationSkillId: null,
  organizationRevisionId: null, audience: null, createdAt: "2026-09-26T12:00:00Z", readAt: null
});
const first = update("aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa");
const second = update("cccccccc-cccc-4ccc-cccc-cccccccccccc");
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><SkillUpdatesPage /></QueryClientProvider>);
  return client;
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(listMySkillSubmissionUpdates).mockResolvedValue({ scope, updates: [first, second], unreadCount: 2, nextCursor: null });
  vi.mocked(readMySkillSubmissionUpdate).mockResolvedValue({ scope, id: first.id, readAt: "2026-09-26T13:00:00Z", unreadCount: 1 });
});
afterEach(cleanup);

it("marks only the opened update read and links to its exact submission", async () => {
  mount();
  expect(await screen.findAllByText("Unread")).toHaveLength(2);
  expect(readMySkillSubmissionUpdate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: /Skill a/ }));
  await waitFor(() => expect(readMySkillSubmissionUpdate).toHaveBeenCalledWith(first.id, scope));
  await waitFor(() => expect(screen.getAllByText("Unread")).toHaveLength(1));
  expect(screen.getByRole("link", { name: "Open submission" }).getAttribute("href"))
    .toBe(`/settings/capabilities?view=submissions&submission=${first.submissionId}`);
});

it("saves both rapid openings in order and keeps the final unread count", async () => {
  let finishFirst!: (value: { scope: typeof scope; id: string; readAt: string; unreadCount: number }) => void;
  vi.mocked(readMySkillSubmissionUpdate).mockImplementationOnce(() => new Promise((resolve) => { finishFirst = resolve; }))
    .mockResolvedValueOnce({ scope, id: second.id, readAt: "2026-09-26T13:01:00Z", unreadCount: 0 });
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: /Skill a/ }));
  fireEvent.click(screen.getByRole("button", { name: /Skill c/ }));
  await waitFor(() => expect(readMySkillSubmissionUpdate).toHaveBeenCalledTimes(1));
  finishFirst({ scope, id: first.id, readAt: "2026-09-26T13:00:00Z", unreadCount: 1 });
  await waitFor(() => expect(readMySkillSubmissionUpdate).toHaveBeenNthCalledWith(2, second.id, scope));
  await waitFor(() => expect(screen.queryByText("Unread")).toBeNull());
  expect(client.getQueryData<{ pages: Array<{ unreadCount: number }> }>(["settings", "skill-updates", scope.tenantId, scope.userId])?.pages[0].unreadCount).toBe(0);
});

it("hides cached updates after access is denied while reading", async () => {
  vi.mocked(readMySkillSubmissionUpdate).mockRejectedValue(new ApiError({
    status: 403, code: "forbidden", method: "POST", path: `/me/skill-submission-updates/${first.id}/read`, message: "Forbidden"
  }));
  mount();
  fireEvent.click(await screen.findByRole("button", { name: /Skill a/ }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("account or organization changed"));
  expect(screen.queryByText("Skill c")).toBeNull();
});

it("rejects a page from another account and keeps its events hidden", async () => {
  vi.mocked(listMySkillSubmissionUpdates).mockResolvedValueOnce({ scope, updates: [first], unreadCount: 2, nextCursor: second.id })
    .mockResolvedValueOnce({ scope: { ...scope, userId: "other" }, updates: [second], unreadCount: 1, nextCursor: null });
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("account or organization changed"));
  expect(screen.queryByText("Skill c")).toBeNull();
});

it("keeps every loaded row when a refetch finds a new update at the top", async () => {
  const third = update("dddddddd-dddd-4ddd-dddd-dddddddddddd");
  const newest = update("eeeeeeee-eeee-4eee-eeee-eeeeeeeeeeee");
  let rows = [first, second, third];
  // Two rows per page. The cursor is the ID of the last row on the page.
  vi.mocked(listMySkillSubmissionUpdates).mockImplementation(async (before?: string) => {
    const start = before ? rows.findIndex((row) => row.id === before) + 1 : 0;
    const page = rows.slice(start, start + 2);
    return { scope, updates: page, unreadCount: rows.length, nextCursor: start + 2 < rows.length ? page[page.length - 1].id : null };
  });
  const client = mount();
  fireEvent.click(await screen.findByRole("button", { name: "Load more" }));
  await screen.findByText("Skill d");
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  rows = [newest, ...rows];
  await client.refetchQueries({ queryKey: ["settings", "skill-updates", scope.tenantId, scope.userId] });
  await screen.findByText("Skill e");
  for (const name of ["Skill a", "Skill c", "Skill d"]) expect(screen.getByText(name)).toBeTruthy();
});
