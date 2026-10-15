// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { ConsoleNavigation } from "./console-navigation";
import { ADMIN_NAVIGATION_ITEMS } from "../app/admin/admin-sections";

afterEach(cleanup);
it("groups destinations and marks the current page", () => {
  render(<ConsoleNavigation sectionLabel="Admin" ariaLabel="Admin sections" activeSectionId="models" navigationItems={ADMIN_NAVIGATION_ITEMS} basePath="/admin" />);
  expect(screen.getByText("Setup")).toBeTruthy();
  expect(screen.getByText("Governance")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Models" }).getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("link", { name: "Connections" }).getAttribute("href")).toBe("/admin/connections");
  expect(screen.getByRole("link", { name: "Back to app" }).getAttribute("href")).toBe("/");
});
it("opens the mobile drawer and dismisses it with Escape", async () => {
  render(<ConsoleNavigation sectionLabel="Admin" ariaLabel="Admin sections" activeSectionId="models" navigationItems={ADMIN_NAVIGATION_ITEMS} basePath="/admin" />);
  fireEvent.click(screen.getByRole("button", { name: "Admin: Models" }));
  const dialog = await screen.findByRole("dialog");
  expect(within(dialog).getByRole("link", { name: "Policies" })).toBeTruthy();
  fireEvent.keyDown(dialog, { key: "Escape" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});
