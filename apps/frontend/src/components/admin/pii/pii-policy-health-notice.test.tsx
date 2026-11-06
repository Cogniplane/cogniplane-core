// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { PiiPolicyHealthNotice } from "./pii-policy-health-notice";

afterEach(cleanup);

it("does not infer policy health when no health was read", () => {
  const view = render(<PiiPolicyHealthNotice health={undefined} action="Review settings." />);
  expect(view.container.textContent).toBe("");
  view.rerender(<PiiPolicyHealthNotice health={{ state: "ok", reasons: [], fields: [] }} action="Review settings." />);
  expect(view.container.textContent).toBe("");
});

it.each([["error", "alert"], ["warning", "status"]] as const)("reports %s health, known reasons and safe field paths from newer servers", (state, role) => {
  render(<PiiPolicyHealthNotice health={{ state, reasons: ["provider_invalid", "newer_server_reason"], fields: ["provider.model", "scopes.fictionalImports"] }} action={<a href="#settings">Review settings.</a>} />);
  expect(screen.getByRole(role).textContent).toContain("Block and Transform cannot run.");
  expect(screen.getByRole(role).textContent).toContain("Fields: provider.model, scopes.fictionalImports.");
  expect(screen.getByRole(role).textContent).not.toContain("undefined");
  expect(screen.getByRole("link", { name: "Review settings." }).getAttribute("href")).toBe("#settings");
});
