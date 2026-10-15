// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPersonalCapabilities } from "@/lib/personal-capabilities-api";
import { getPersonalSkills } from "@/lib/personal-skills-api";

const auth = vi.hoisted(() => ({ user: { tenantId: "tenant-a", userId: "person-a" } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));
vi.mock("@/lib/personal-capabilities-api", () => ({ getPersonalCapabilities: vi.fn(), updatePersonalCapabilities: vi.fn() }));
vi.mock("@/lib/personal-skills-api", () => ({ getPersonalSkills: vi.fn() }));
const nav = vi.hoisted(() => ({ search: "" }));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(nav.search) }));

import PersonalCapabilitiesPage from "./page";

const catalog = { selection: null, version: 1, canEdit: true,
  skills: [{ id: "pdf", name: "PDF", description: "Read documents" }], connectors: [] };
beforeEach(() => {
  auth.user = { tenantId: "tenant-a", userId: "person-a" };
  nav.search = "";
  vi.resetAllMocks();
  vi.mocked(getPersonalCapabilities).mockImplementation(async () => ({ ...catalog, scope: { ...auth.user } }));
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
