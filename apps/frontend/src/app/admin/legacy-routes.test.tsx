// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { redirect } from "next/navigation";

import AdminIntegrationsPage from "./integrations/page";
import AdminOrganizationPage from "./organization/page";
import AdminPiiPage from "./pii/page";

let query = "";
vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); }),
  useSearchParams: () => new URLSearchParams(query)
}));
vi.mock("../../components/admin/integrations/admin-integrations-list", () => ({ AdminIntegrationsList: () => <p>Integration list</p> }));

afterEach(() => { cleanup(); vi.mocked(redirect).mockClear(); });

it("sends old Privacy activity links to the Activity tab and keeps their query", async () => {
  await expect(AdminPiiPage({ searchParams: Promise.resolve({ from: "overview", tab: "old", user: ["a", "b"] }) })).rejects.toThrow("NEXT_REDIRECT");
  const target = new URL(vi.mocked(redirect).mock.calls[0][0], "https://app.test");
  expect(target.pathname).toBe("/admin/privacy");
  expect(target.searchParams.get("tab")).toBe("activity");
  expect(target.searchParams.get("from")).toBe("overview");
  expect(target.searchParams.getAll("user")).toEqual(["a", "b"]);
});

it("sends old Privacy activity links without a query to the Activity tab", async () => {
  await expect(AdminPiiPage({ searchParams: Promise.resolve({}) })).rejects.toThrow("NEXT_REDIRECT");
  expect(redirect).toHaveBeenCalledWith("/admin/privacy?tab=activity");
});

it("sends the old Organization page to Overview", () => {
  expect(() => AdminOrganizationPage()).toThrow("NEXT_REDIRECT");
  expect(redirect).toHaveBeenCalledWith("/admin/overview");
});

it("keeps the GitHub App callback message on the old integrations URL", () => {
  query = "githubInstall=error&reason=installation_cancelled";
  render(<AdminIntegrationsPage />);
  expect(screen.getByText("GitHub App installation failed: installation cancelled.")).toBeTruthy();
  expect(screen.getByText("Integration list")).toBeTruthy();
});
