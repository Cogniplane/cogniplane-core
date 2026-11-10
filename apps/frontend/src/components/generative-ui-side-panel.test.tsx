// @vitest-environment jsdom
//
// The side panel when the generated view throws while it renders. The real
// panel with the real CopilotKit runtime runs in copilot-chat-host.panel tests;
// here the SDK surface is a stand-in that throws for one surface id.

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const surface = vi.hoisted(() => ({ current: "", failing: new Set<string>() }));

vi.mock("@copilotkit/react-core/v2/generative-ui", async (importOriginal) => ({
  ...await importOriginal<typeof import("@copilotkit/react-core/v2/generative-ui")>(),
  useGenerativeUIRuntime: () => ({ manager: { registerTarget: () => () => undefined } }),
  GenerativeUISurface: () => {
    if (surface.failing.has(surface.current)) throw new Error("secret view data");
    return <p>{`Rendered ${surface.current}`}</p>;
  }
}));

import { GenerativeUiSidePanel, type SidePanelState } from "./generative-ui-side-panel";

function stateFor(surfaceId: string): SidePanelState {
  const view = { surfaceId, reply: 1, title: `View ${surfaceId}`, status: "ready" as const };
  return { hasView: true, streaming: false, incomplete: false, failed: false, renderable: true, views: [view], selected: view, browsing: false };
}

function panel(surfaceId: string, onClose: () => void, narrow = false) {
  surface.current = surfaceId;
  return (
    <GenerativeUiSidePanel panelId="panel" open narrow={narrow} state={stateFor(surfaceId)} replyNumbers
      focusRequest={0} toggleRef={createRef()} onClose={onClose} onSelect={vi.fn()} onShowLatest={vi.fn()} />
  );
}

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  surface.failing.clear();
});

it("shows a local notice when the view fails, and keeps the header and Close usable", () => {
  surface.failing.add("broken");
  const onClose = vi.fn();
  const view = render(panel("broken", onClose));

  const aside = document.getElementById("panel")!;
  expect(within(aside).getByRole("heading", { name: "Side panel" })).toBeTruthy();
  expect(within(aside).getByRole("heading", { name: "View broken" })).toBeTruthy();
  expect(within(aside).getByRole("alert").textContent).toContain("This view could not be shown");
  expect(aside.textContent).not.toContain("secret view data");

  fireEvent.click(within(aside).getByRole("button", { name: "Close side panel" }));
  expect(onClose).toHaveBeenCalledTimes(1);

  // A different view renders: the failure belongs to the view, not the panel.
  view.rerender(panel("healthy", onClose));
  expect(within(aside).getByText("Rendered healthy")).toBeTruthy();
  expect(within(aside).queryByRole("alert")).toBeNull();
});

it("keeps Escape working in the modal panel on a narrow screen", () => {
  surface.failing.add("broken");
  const onClose = vi.fn();
  render(panel("broken", onClose, true));

  const dialog = screen.getByRole("dialog", { name: "Side panel" });
  expect(within(dialog).getByRole("alert")).toBeTruthy();
  fireEvent.keyDown(within(dialog).getByRole("button", { name: "Try again" }), { key: "Escape" });
  expect(onClose).toHaveBeenCalledTimes(1);
});
