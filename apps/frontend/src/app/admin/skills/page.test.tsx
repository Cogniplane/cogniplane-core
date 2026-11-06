// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { queryKeys } from "../../../lib/query-keys";
import Page from "./page";
import type { AcceptedSkillDraft } from "../../../components/admin/skills/accepted-skill-draft";
const handoff: AcceptedSkillDraft = { scope: { tenantId: "tenant-a", userId: "admin-a" }, submissionId: "accepted", submissionVersion: 2, attempt: 1, acceptedRevisionId: 7, skillId: "exact-target", organizationVersion: 0, activeRevisionId: null, draftRevisionId: 7, content: { name: "Accepted name", description: "Purpose", instructions: "Exact accepted text" } };

let query = "view=review&submission=aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(query) }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }) }));
vi.mock("@/lib/organization-skill-submissions-api", () => ({ listAdminSkillSubmissions: async () => ({ scope: { tenantId: "tenant-a", userId: "admin-a" }, submissions: [] }) }));
const library = vi.hoisted(() => ({ skills: [] as { skillId: string }[], skillsLoaded: true }));
vi.mock("../../../hooks/use-admin-skills-data", () => ({ useAdminSkillsData: () => ({ skills: library.skills, skillsLoaded: library.skillsLoaded, marketplace: [], manifestUrl: "", busyKey: null, error: null }) }));
vi.mock("../../../components/admin/skills/admin-skill-card", () => ({ AdminSkillCard: ({ targetSkillId, acceptedDraft }: { targetSkillId: string | null; acceptedDraft?: AcceptedSkillDraft }) => <><output>{acceptedDraft ? JSON.stringify(acceptedDraft) : "No accepted draft"}</output><p>Skill library {targetSkillId ? `target ${targetSkillId}` : "without target"}</p><textarea aria-label="Import draft specimen" defaultValue="" /></> }));
vi.mock("../../../components/admin/skills/organization-skill-review", () => ({ OrganizationSkillReview: ({ requestedSubmissionId, onQueueChanged, onOpenLibrary }: { requestedSubmissionId: string | null; onQueueChanged: () => void; onOpenLibrary: (draft: AcceptedSkillDraft) => void }) => <><p>Submission {requestedSubmissionId}</p><button onClick={onQueueChanged}>Decision completed</button><button onClick={() => onOpenLibrary(handoff)}>Edit draft in library</button></> }));

afterEach(cleanup);

it("updates the exact review target when the URL changes on the mounted page", () => {
  const client = new QueryClient();
  const page = render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.getByText("Submission aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa")).toBeTruthy();
  query = "view=review&submission=bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
  page.rerender(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.getByText("Submission bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb")).toBeTruthy();
  query = "view=review";
  page.rerender(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.getByText("Submission")).toBeTruthy();
  client.clear();
});

it("refreshes a cached overview queue after a review decision before its stale time", async () => {
  query = "view=review";
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: 30_000 } } });
  const key = queryKeys.admin.skillSubmissions("tenant-a", "admin-a");
  const otherKey = queryKeys.admin.skillSubmissions("tenant-b", "admin-b");
  const pending = [{ id: "pending" }];
  const refreshed = [{ id: "accepted" }];
  const loadOverview = vi.fn(async () => refreshed);
  client.setQueryData(key, pending);
  client.setQueryData(otherKey, pending);
  expect(await client.fetchQuery({ queryKey: key, queryFn: loadOverview })).toEqual(pending);
  expect(loadOverview).not.toHaveBeenCalled();
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  fireEvent.click(screen.getByRole("button", { name: "Decision completed" }));
  await waitFor(() => expect(client.getQueryState(key)?.isInvalidated).toBe(true));
  expect(client.getQueryState(otherKey)?.isInvalidated).toBe(false);
  expect(await client.fetchQuery({ queryKey: key, queryFn: loadOverview })).toEqual(refreshed);
  expect(loadOverview).toHaveBeenCalledOnce();
  client.clear();
});

it("passes a skill target to the library and says when that skill is missing only after the list loads", () => {
  const client = new QueryClient();
  query = "skill=briefing";
  library.skills = [{ skillId: "briefing" }];
  const page = render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.getByText("Skill library target briefing")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();

  query = "skill=%3Cb%3Egone%3C%2Fb%3E";
  library.skillsLoaded = false;
  library.skills = [];
  page.rerender(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.queryByRole("alert")).toBeNull();

  library.skillsLoaded = true;
  page.rerender(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("The skill <b>gone</b> is not in the library.");
  expect(alert.querySelector("b")).toBeNull();
  expect(screen.getByRole("link", { name: "Show all skills" }).getAttribute("href")).toBe("/admin/skills");
  client.clear();
});

it("preserves a library draft when the administrator switches to Review and back", () => {
  query = "view=library";
  const client = new QueryClient();
  render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  const draft = screen.getByLabelText("Import draft specimen") as HTMLTextAreaElement;
  fireEvent.change(draft, { target: { value: "Keep this unsaved import" } });
  fireEvent.click(screen.getByRole("button", { name: "Review" }));
  expect(draft.isConnected).toBe(true);
  expect(draft.closest("[hidden]")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Library" }));
  expect(screen.getByLabelText("Import draft specimen")).toBe(draft);
  expect(draft.value).toBe("Keep this unsaved import");
  client.clear();
});


it("carries the whole accepted receipt without unmounting drafts and clears it on a different URL", () => {
  query = "view=review";
  const client = new QueryClient();
  const page = render(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  const draft = screen.getByLabelText("Import draft specimen") as HTMLTextAreaElement;
  draft.value = "Kept import";
  fireEvent.click(screen.getByRole("button", { name: "Edit draft in library" }));
  expect(JSON.parse(screen.getByRole("status").textContent!)).toEqual(handoff);
  expect(screen.getByRole("button", { name: "Library" }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByLabelText("Import draft specimen")).toBe(draft);
  expect(draft.value).toBe("Kept import");
  query = "view=review&submission=another";
  page.rerender(<QueryClientProvider client={client}><Page /></QueryClientProvider>);
  expect(screen.getByText("No accepted draft")).toBeTruthy();
  client.clear();
});
