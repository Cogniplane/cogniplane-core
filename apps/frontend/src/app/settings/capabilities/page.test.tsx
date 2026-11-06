// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPersonalCapabilities } from "@/lib/personal-capabilities-api";
import { listMySkillSubmissions, submitPersonalSkill } from "@/lib/organization-skill-submissions-api";
import { getPersonalSkills } from "@/lib/personal-skills-api";

const auth = vi.hoisted(() => ({ user: { tenantId: "tenant-a", userId: "person-a" } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/lib/personal-capabilities-api", () => ({ getPersonalCapabilities: vi.fn(), updatePersonalCapabilities: vi.fn() }));
vi.mock("@/lib/organization-skill-submissions-api", () => ({ listMySkillSubmissions: vi.fn(), submitPersonalSkill: vi.fn() }));
vi.mock("@/lib/personal-skills-api", () => ({ getPersonalSkills: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search), useRouter: () => ({ replace: vi.fn() }) }));

import PersonalCapabilitiesPage from "./page";

const catalog = { selection: null, version: 1, canEdit: true,
  skills: [{ id: "pdf", name: "PDF", description: "Read documents" }], connectors: [] };
beforeEach(() => {
  auth.user = { tenantId: "tenant-a", userId: "person-a" };
  nav.search = "";
  vi.resetAllMocks();
  vi.mocked(getPersonalCapabilities).mockImplementation(async () => ({ ...catalog, scope: { ...auth.user } }));
  vi.mocked(listMySkillSubmissions).mockImplementation(async () => ({ scope: { ...auth.user }, submissions: [] }));
  vi.mocked(getPersonalSkills).mockImplementation(async () => ({ scope: { ...auth.user }, skills: [] }));
});
afterEach(cleanup);

it("drops the previous draft when the organization or user changes", async () => {
  const view = render(<PersonalCapabilitiesPage />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  expect(screen.getByText("No skills selected.")).toBeTruthy();

  auth.user = { tenantId: "tenant-b", userId: "person-a" };
  view.rerender(<PersonalCapabilitiesPage />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  expect(screen.queryByText("No skills selected.")).toBeNull();
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
  expect(getPersonalCapabilities).toHaveBeenCalledTimes(2);

  fireEvent.click(screen.getByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  auth.user = { tenantId: "tenant-b", userId: "person-b" };
  view.rerender(<PersonalCapabilitiesPage />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  await waitFor(() => expect(getPersonalCapabilities).toHaveBeenCalledTimes(3));
  expect(screen.queryByText("No skills selected.")).toBeNull();
});

it("keeps unsaved chat defaults when a tab switch is declined", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  render(<PersonalCapabilitiesPage />);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  fireEvent.click(await screen.findByRole("button", { name: "Customize" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove PDF from your defaults" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Private skills" }), { button: 0, ctrlKey: false });
  expect(confirm).toHaveBeenCalledWith("Discard your unsaved chat defaults?");
  expect(screen.getByText("No skills selected.")).toBeTruthy();
  confirm.mockRestore();
});

it("opens Chat defaults from the link an admin copies from the person page", async () => {
  nav.search = "tab=defaults";
  render(<PersonalCapabilitiesPage />);
  expect(screen.getByRole("tab", { name: "Chat defaults" }).getAttribute("aria-selected")).toBe("true");
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
});

it("keeps a submission note and named section after a declined tab change, then permits a later discard", async () => {
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  const content = { name: "meeting-notes", description: "Prepare notes", instructions: "Saved instructions" };
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope: auth.user, skills: [{ id: "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", version: 1, enabled: false, latest: { revision: 1, content, validationMessages: [], createdAt: "2026-09-21T12:00:00Z" }, active: null, updatedAt: "2026-09-21T12:00:00Z" }] });
  render(<PersonalCapabilitiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "My submissions" }));
  expect(screen.getAllByRole("region", { name: "My submissions" })).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "New submission" }));
  fireEvent.change(screen.getByLabelText("Note to reviewers"), { target: { value: "Keep across tabs" } });
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  expect(confirm).toHaveBeenCalledWith("Discard your unsaved skill changes or unsent submission?");
  expect(screen.getByLabelText("Note to reviewers")).toHaveProperty("value", "Keep across tabs");
  confirm.mockReturnValue(true);
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
  expect(submitPersonalSkill).not.toHaveBeenCalled();
  confirm.mockRestore();
});

it("blocks tab dismissal while a submission is pending and restores the choice after failure", async () => {
  let fail!: (cause: Error) => void;
  vi.mocked(submitPersonalSkill).mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
  const content = { name: "meeting-notes", description: "Prepare notes", instructions: "Saved instructions" };
  vi.mocked(getPersonalSkills).mockResolvedValue({ scope: auth.user, skills: [{ id: "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa", version: 1, enabled: false, latest: { revision: 1, content, validationMessages: [], createdAt: "2026-09-21T12:00:00Z" }, active: null, updatedAt: "2026-09-21T12:00:00Z" }] });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
  render(<PersonalCapabilitiesPage />);
  fireEvent.click(await screen.findByRole("button", { name: "My submissions" }));
  fireEvent.click(screen.getByRole("button", { name: "New submission" }));
  fireEvent.change(screen.getByLabelText("Private skill"), { target: { value: "personal-skill-aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa" } });
  fireEvent.change(screen.getByLabelText("Note to reviewers"), { target: { value: "Keep while pending" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Submit for review" })).toHaveProperty("disabled", false));
  fireEvent.click(screen.getByRole("button", { name: "Submit for review" }));
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  expect(confirm).not.toHaveBeenCalled();
  expect(screen.getByLabelText("Note to reviewers")).toHaveProperty("value", "Keep while pending");
  fail(new Error("Fictional save failed"));
  await screen.findByText("Fictional save failed");
  fireEvent.mouseDown(screen.getByRole("tab", { name: "Chat defaults" }), { button: 0, ctrlKey: false });
  expect(confirm).toHaveBeenCalledOnce();
  expect(await screen.findByText("Using inherited defaults")).toBeTruthy();
  confirm.mockRestore();
});
