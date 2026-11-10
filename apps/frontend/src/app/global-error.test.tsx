// @vitest-environment jsdom
//
// The global error page replaces the root layout, so it renders its own
// document with no app provider.

import { act, fireEvent, screen } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import { NEW_SESSION_HREF } from "../lib/new-session-link";
import GlobalError from "./global-error";

const error = new Error("secret tool output");
let root: Root | null = null;

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  window.localStorage.clear();
});

it("renders a whole document with the notice and no error text on the server", () => {
  const html = renderToString(<GlobalError error={error} retry={() => undefined} />);

  expect(html).toContain("<html lang=\"en\">");
  expect(html).toContain("<body>");
  expect(html).toContain("This page stopped working");
  expect(html).toContain(`href="${NEW_SESSION_HREF.replace("&", "&amp;")}"`);
  expect(html).not.toContain("secret tool output");
});

it("applies the saved theme in the browser and retries on request", async () => {
  window.localStorage.setItem("theme", "dark");
  // theme-init.js set this before React took the document. React removes it.
  document.documentElement.setAttribute("data-theme", "dark");
  const retry = vi.fn();

  root = createRoot(document);
  await act(async () => root!.render(<GlobalError error={error} retry={retry} />));

  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(document.title).toBe("Cogniplane");
  expect(document.body.textContent).not.toContain("secret tool output");
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(retry).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("link", { name: "New session" }).getAttribute("href")).toBe(NEW_SESSION_HREF);
});

it("stays light when storage is blocked", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
  root = createRoot(document);
  await act(async () => root!.render(<GlobalError error={error} retry={() => undefined} />));
  expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
  expect(screen.getByRole("heading", { name: "This page stopped working" })).toBeTruthy();
  vi.restoreAllMocks();
});
