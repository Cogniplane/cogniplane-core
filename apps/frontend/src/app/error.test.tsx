// @vitest-environment jsdom
//
// The route error page renders with no app provider: no auth, query or toast
// state is needed to show it or to leave it.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { NEW_SESSION_HREF } from "../lib/new-session-link";
import RouteError from "./error";

afterEach(cleanup);

it("shows a fixed notice, a retry and a New session link, and never the error text", () => {
  const retry = vi.fn();
  const error = Object.assign(new Error("relation \"sessions\" failed: secret tool output"), { digest: "4031955297" });
  render(<RouteError error={error} retry={retry} />);

  const notice = screen.getByRole("alert");
  expect(screen.getByRole("heading", { level: 1, name: "This page stopped working" })).toBeTruthy();
  expect(notice.textContent).not.toContain("secret tool output");
  expect(notice.textContent).not.toContain("relation");
  // The server log reference has no error text in it.
  expect(notice.textContent).toContain("Reference: 4031955297");

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
  // A full page load of the workspace that restores no session.
  expect(screen.getByRole("link", { name: "New session" }).getAttribute("href")).toBe(NEW_SESSION_HREF);
});

it.each([
  ["a thrown string", "secret string"],
  ["an object with an empty digest", { digest: "", message: "secret object" }],
  ["null", null]
])("shows no reference for %s", (_label, thrown) => {
  render(<RouteError error={thrown} retry={vi.fn()} />);
  const notice = screen.getByRole("alert");
  expect(notice.textContent).not.toContain("Reference");
  expect(notice.textContent).not.toContain("secret");
});
