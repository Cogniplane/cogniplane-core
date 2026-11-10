// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useLayoutEffect } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { RenderBoundary } from "./render-boundary";

const SECRET = "secret model output";
// React renders a failed tree once more before it shows the boundary, so
// the tests switch the failure on and off instead of counting attempts.
const content = { failing: false };

function Content({ failIn }: { failIn: "render" | "effect" | "layout effect" | "none" }) {
  const fail = () => {
    if (content.failing) throw new Error(SECRET);
  };
  if (failIn === "render") fail();
  useEffect(() => { if (failIn === "effect") fail(); });
  useLayoutEffect(() => { if (failIn === "layout effect") fail(); });
  return <p>Content shown</p>;
}

function view(failIn: "render" | "effect" | "layout effect" | "none", key = "content-1") {
  return (
    <>
      <button type="button">Close</button>
      <RenderBoundary key={key} title="This view could not be shown" description="Try again, or ask for it again.">
        <Content failIn={failIn} />
      </RenderBoundary>
    </>
  );
}

beforeEach(() => {
  // React reports each caught error with console.error.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  content.failing = false;
});

it.each(["render", "effect", "layout effect"] as const)("catches an error thrown in %s and keeps the content around it", (failIn) => {
  content.failing = true;
  render(view(failIn));

  const notice = screen.getByRole("alert");
  expect(notice.textContent).toContain("This view could not be shown");
  expect(notice.textContent).toContain("Try again, or ask for it again.");
  expect(document.body.textContent).not.toContain(SECRET);
  expect(screen.queryByText("Content shown")).toBeNull();
  expect(screen.getByRole("button", { name: "Close" })).toBeTruthy();
});

it("renders the content again on Try again, and only then", () => {
  content.failing = true;
  render(view("render"));
  expect(screen.getByRole("alert")).toBeTruthy();

  // The cause went away. Nothing renders the content until the user asks.
  content.failing = false;
  expect(screen.getByRole("alert")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(screen.getByText("Content shown")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("starts other content with no error", () => {
  content.failing = true;
  const { rerender } = render(view("render", "content-1"));
  expect(screen.getByRole("alert")).toBeTruthy();

  rerender(view("none", "content-2"));
  expect(screen.getByText("Content shown")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("does not catch an error thrown in an event handler", () => {
  // React reports a handler error to the window, after rendering. The
  // boundary does not see it, and the content stays.
  const reported: unknown[] = [];
  const onError = (event: ErrorEvent) => {
    reported.push(event.error);
    event.preventDefault();
  };
  window.addEventListener("error", onError);
  render(
    <RenderBoundary title="This view could not be shown" description="Try again.">
      <button type="button" onClick={() => { throw new Error("handler failed"); }}>Run</button>
    </RenderBoundary>
  );

  let thrown: unknown = null;
  try {
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
  } catch (error) {
    thrown = error;
  }
  window.removeEventListener("error", onError);

  expect([thrown, ...reported].some((error) => error instanceof Error && error.message === "handler failed")).toBe(true);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
});
