// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Session } from "@cogniplane/shared-types";

import { SessionSidebar } from "./session-sidebar";

vi.mock("next/image", () => ({ default: (props: Record<string, unknown>) => <span role="img" aria-label={String(props.alt)} /> }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => children }));
vi.mock("../lib/auth-context", () => ({ useAuth: () => ({ user: { displayName: "Ada", email: "ada@example.com" } }) }));
vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
afterEach(cleanup);

const session: Session = {
  sessionId: "session-1",
  userId: "user-1",
  sessionName: "Research notes",
  status: "active",
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: new Date().toISOString()
};

it("routes select, pin, rename, and delete actions through their owners", () => {
  const onSelect = vi.fn();
  const onTogglePin = vi.fn();
  const onStartRename = vi.fn();
  const onRequestDelete = vi.fn();
  const rename = { busyId: null, sessionId: null, renameDraft: "", onStartRename, onCancelRename: vi.fn(), onConfirmRename: vi.fn(), onRenameDraftChange: vi.fn() };
  const deletion = { busyId: null, pendingId: null, onRequest: onRequestDelete, onConfirmDelete: vi.fn(), onCancelDelete: vi.fn() };
  const view = render(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={rename}
      deletion={deletion}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: /Research notes/ }));
  fireEvent.click(screen.getByRole("button", { name: "Pin session" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename session" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete session" }));
  expect(onSelect).toHaveBeenCalledWith("session-1");
  expect(onTogglePin).toHaveBeenCalledWith("session-1");
  expect(onStartRename).toHaveBeenCalledWith(session);
  expect(onRequestDelete).toHaveBeenCalledWith("session-1");

  view.rerender(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={rename}
      deletion={{ ...deletion, pendingId: "session-1" }}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.click(screen.getByRole("button", { name: "Delete" }));
  expect(deletion.onConfirmDelete).toHaveBeenCalledOnce();

  view.rerender(
    <SessionSidebar
      list={{ sessions: [session], selectedId: null, isLoading: false, streamingIds: new Set(), attentionIds: new Set(), errorId: null, onSelect, onCreate: vi.fn() }}
      rename={{ ...rename, sessionId: "session-1", renameDraft: "New title" }}
      deletion={deletion}
      pinning={{ busyId: null, ids: new Set(), onToggle: onTogglePin }}
    />
  );
  fireEvent.submit(screen.getByDisplayValue("New title").closest("form")!);
  expect(rename.onConfirmRename).toHaveBeenCalledWith("session-1");
});
