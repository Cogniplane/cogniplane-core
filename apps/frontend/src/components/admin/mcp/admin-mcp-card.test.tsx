// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import type { AdminMcpServer } from "@cogniplane/shared-types";

import { AdminMcpCard } from "./admin-mcp-card";

const auth = vi.hoisted(() => ({ user: { tenantId: "tenant-a", userId: "admin-a" } }));
vi.mock("@/lib/auth-context", () => ({ useAuth: () => auth }));

afterEach(() => { cleanup(); auth.user = { tenantId: "tenant-a", userId: "admin-a" }; });

const syntheticServer: AdminMcpServer = {
  serverId: "sample", ownerTenantId: "tenant-a", serverName: "Synthetic MCP", description: "Saved description",
  mode: "proxy", routePath: "/mcp/sample", upstreamUrl: "https://tools.example/mcp", upstreamAuthType: "bearer",
  upstreamAuthName: null, upstreamAuthConfigured: false, credentialScope: "personal", transportKind: "http",
  enabled: true, isAllowed: true, isPublished: true, version: 3, configHash: "a".repeat(64), createdBy: "admin-a",
  createdAt: "2026-11-04T12:00:00.000Z", updatedAt: "2026-11-04T12:00:00.000Z"
};

type CardProps = Parameters<typeof AdminMcpCard>[0];
function renderCard(overrides: Partial<CardProps> = {}) {
  const props: CardProps = {
    mcpServers: [syntheticServer], busyKey: null,
    onSubmit: vi.fn(async () => undefined), onSetInheritedAudience: vi.fn(async () => undefined),
    ...overrides
  };
  const view = render(<AdminMcpCard {...props} />);
  return { ...view, rerender: (next: Partial<CardProps>) => view.rerender(<AdminMcpCard {...props} {...next} />) };
}

it.each([true, false])("retains saved personal audience on a description-only save, published=%s", async (published) => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [{ ...syntheticServer, isPublished: published }], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
  expect(screen.queryByLabelText("Secret")).toBeNull();
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Description only" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ audience: published ? "members" : "test_users", upstreamAuthSecret: null }), "sample"));
});

it("distinguishes unavailable counts from returned zero and positive counts", () => {
  renderCard({ mcpServers: [syntheticServer, { ...syntheticServer, serverId: "counts", serverName: "Counts", invokedSessions30d: 0, materializedSessions30d: 17 }] });
  expect(screen.getByText("Usage unavailable")).toBeTruthy();
  expect(screen.getByText("Offer count unavailable")).toBeTruthy();
  expect(screen.getByText("Used in 0 sessions")).toBeTruthy();
  expect(screen.getByText("Offered in 17 sessions")).toBeTruthy();
});

it("keeps one pending editor, blocks duplicate submission and replacement, and retains failure values", async () => {
  let reject!: (error: Error) => void;
  const onSubmit = vi.fn(() => new Promise<void>((_resolve, fail) => { reject = fail; }));
  renderCard({ mcpServers: [syntheticServer], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep on failure" } });
  const form = screen.getByRole("form");
  fireEvent.submit(form); fireEvent.submit(form);
  expect(onSubmit).toHaveBeenCalledTimes(1);
  expect((screen.getByRole("button", { name: "Add connection" }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByLabelText("Description").matches(":disabled")).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("form")).toBe(form);
  reject(new Error("Synthetic conflict"));
  await waitFor(() => expect(screen.getByLabelText("Description").matches(":disabled")).toBe(false));
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep on failure");
  expect(screen.getByRole("alert").textContent).toContain("kept");
});

it("requires an explicit decision for dirty row, close, add and URL target changes", () => {
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  const props = { mcpServers: [syntheticServer, other], busyKey: null, onSubmit: async () => undefined, onSetInheritedAudience: async () => undefined };
  const page = renderCard({ ...props, targetServerId: "sample" });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep draft" } });
  for (const name of ["Manage Other MCP", "Manage Synthetic MCP", "Add connection", "Cancel"]) {
    fireEvent.click(screen.getByRole("button", { name }));
    expect(screen.getByRole("alertdialog").textContent).toContain("Discard");
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep draft");
  }
  page.rerender({ ...props, targetServerId: "other" });
  expect(screen.getByRole("alertdialog").textContent).toContain("open Other MCP");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Other MCP");
});

it("keeps a row-switch decision beside its trigger and keeps Cancel's decision in the editor", () => {
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  renderCard({ mcpServers: [syntheticServer, other], targetServerId: "sample" });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this draft" } });
  const otherManage = screen.getByRole("button", { name: "Manage Other MCP" });
  otherManage.focus(); fireEvent.click(otherManage);
  const question = screen.getByRole("alertdialog");
  expect(question.textContent).toContain("Keep editing Synthetic MCP, or discard its changes to open Other MCP.");
  expect(question.closest("form")).toBeNull();
  expect(within(question.parentElement!).getByRole("button", { name: "Manage Other MCP" })).toBe(otherManage);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog").closest("form")).toBe(screen.getByRole("form"));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep this draft");
});

it.each(["Cancel", "Add connection", "Manage Other MCP", "incoming target"])("names the saved connection when a blank draft name reaches %s", (action) => {
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  const props = { mcpServers: [syntheticServer, other], busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn(), targetServerId: "sample" };
  const view = renderCard({ ...props });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "   " } });
  expect(screen.getByRole("form", { name: "Manage Synthetic MCP" })).toBeTruthy();
  if (action === "incoming target") view.rerender({ ...props, targetServerId: "other" });
  else fireEvent.click(screen.getByRole("button", { name: action }));
  expect(screen.getByRole("alertdialog").textContent).toContain("Keep editing Synthetic MCP, or discard its changes");
  expect(screen.getByRole("alertdialog").textContent).not.toContain("the new connection");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("   ");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("keeps the new-connection name for an unnamed Add draft", () => {
  renderCard({ mcpServers: [syntheticServer] });
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "An unnamed draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog").textContent).toContain("Keep editing the new connection, or discard its changes");
});

it.each(["", "   "])("retains saved identity after its row disappears with Name=%j", (name) => {
  const props = { busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn(), targetServerId: "sample" };
  const view = renderCard({ ...props, mcpServers: [syntheticServer] });
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Missing-row draft" } });
  view.rerender({ ...props, mcpServers: [] });
  expect(screen.getByRole("form", { name: "Manage Synthetic MCP" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.getByRole("alertdialog").textContent).toContain("Keep editing Synthetic MCP, or discard its changes");
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe(name);
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Missing-row draft");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("moves focus into a clean Add editor when its opener becomes hidden", () => {
  renderCard({ mcpServers: [syntheticServer] });
  const add = screen.getByRole("button", { name: "Add connection" });
  add.focus();
  fireEvent.click(add);
  expect(document.activeElement).toBe(screen.getByLabelText("Name"));
});

it("opens the chosen incoming editor without browser focus scrolling", () => {
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  const props = { mcpServers: [syntheticServer, other], busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn() };
  const view = renderCard({ ...props, targetServerId: "sample" });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "A draft" } });
  view.rerender({ ...props, targetServerId: "other" });
  const focus = vi.spyOn(HTMLElement.prototype, "focus");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  const form = screen.getByRole("form", { name: "Manage Other MCP" });
  expect(document.activeElement).toBe(form);
  const index = focus.mock.contexts.lastIndexOf(form);
  expect(focus.mock.calls[index]).toEqual([{ preventScroll: true }]);
  focus.mockRestore();
});

it.each([false, true])("describes whether an organization secret exists without a clipped placeholder, configured=%s", (configured) => {
  renderCard({ mcpServers: [{ ...syntheticServer, credentialScope: "organization", upstreamAuthConfigured: configured }], targetServerId: "sample" });
  const secret = screen.getByLabelText("Secret");
  expect(document.getElementById(secret.getAttribute("aria-describedby")!)?.textContent).toBe(configured ? "Leave blank to keep the saved secret." : "Enter the upstream credential.");
});

it.each([
  { authType: "none" as const, configured: false, typed: "", secret: null },
  { authType: "bearer" as const, configured: true, typed: "", secret: undefined },
  { authType: "bearer" as const, configured: true, typed: "INERT-SAMPLE-NOT-A-CREDENTIAL", secret: "INERT-SAMPLE-NOT-A-CREDENTIAL" }
])("keeps organization audience and exact secret wire behavior for $authType / $typed", async ({ authType, configured, typed, secret }) => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [{ ...syntheticServer, credentialScope: "organization", upstreamAuthType: authType, upstreamAuthConfigured: configured }], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
  if (authType !== "none") {
    const field = screen.getByLabelText("Secret") as HTMLInputElement;
    expect(field.type).toBe("password");
    if (typed) fireEvent.change(field, { target: { value: typed } });
  }
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  const payload = JSON.parse(JSON.stringify(onSubmit.mock.calls[0]![0]));
  expect(payload.audience).toBe("members");
  if (secret === undefined) expect(Object.hasOwn(payload, "upstreamAuthSecret")).toBe(false);
  else expect(payload.upstreamAuthSecret).toBe(secret);
});

it("retains inherited availability after a rejected save and requires explicit retry", async () => {
  const inherited = { ...syntheticServer, ownerTenantId: "system", mode: "managed" as const, upstreamAuthType: "none" as const };
  const onSetInheritedAudience = vi.fn().mockRejectedValueOnce(new Error("Synthetic 409")).mockResolvedValueOnce(undefined);
  renderCard({ mcpServers: [inherited], onSetInheritedAudience });
  fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  expect(await screen.findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("kept"));
  expect(screen.getByRole("form")).toBeTruthy();
  expect(onSetInheritedAudience).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  expect(onSetInheritedAudience).toHaveBeenLastCalledWith("sample", "members");
});

it("clears old identity inputs immediately and ignores its late save result", async () => {
  let finish!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const props = { mcpServers: [syntheticServer], busyKey: null, onSubmit, onSetInheritedAudience: async () => undefined };
  const view = renderCard({ ...props });
  fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Old identity draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  auth.user = { tenantId: "tenant-b", userId: "admin-b" };
  view.rerender({ ...props });
  expect(screen.queryByRole("form")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("");
  finish();
  await waitFor(() => expect(screen.getByRole("form", { name: "Add connection" })).toBeTruthy());
});

it("retains the editor when a fresh list removes its row", () => {
  const props = { busyKey: null, onSubmit: async () => undefined, onSetInheritedAudience: async () => undefined };
  const view = renderCard({ ...props, mcpServers: [syntheticServer], targetServerId: "sample" });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Removed-row draft" } });
  view.rerender({ ...props, mcpServers: [], targetServerId: "sample" });
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Removed-row draft");
  expect(screen.getByText(/Your draft is kept/)).toBeTruthy();
  expect((screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement).disabled).toBe(true);
});

it.each([false, true])("keeps the draft cursor across row removal and restoration, outside focus=%s", (moveOutside) => {
  const props = { busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: async () => undefined, targetServerId: "sample" };
  const editor = (mcpServers: AdminMcpServer[]) => <><AdminMcpCard {...props} mcpServers={mcpServers} /><button>Outside editor</button></>;
  const view = render(editor([syntheticServer]));
  const description = screen.getByLabelText("Description") as HTMLTextAreaElement;
  fireEvent.change(description, { target: { value: "Retained cursor and draft" } });
  description.focus();
  description.setSelectionRange(3, 8, "backward");
  const outside = screen.getByRole("button", { name: "Outside editor" });
  if (moveOutside) outside.focus();

  for (const rows of [[], [syntheticServer]]) {
    view.rerender(editor(rows));
    const retained = screen.getByLabelText("Description") as HTMLTextAreaElement;
    expect(retained.value).toBe("Retained cursor and draft");
    expect(document.activeElement).toBe(moveOutside ? outside : retained);
    if (!moveOutside) {
      expect([retained.selectionStart, retained.selectionEnd, retained.selectionDirection]).toEqual([3, 8, "backward"]);
    }
  }
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("reloads a missing connection without losing its draft or issuing a save", async () => {
  let complete!: () => void;
  const onReload = vi.fn(() => new Promise<void>(resolve => { complete = resolve; }));
  const onSubmit = vi.fn(async () => undefined);
  const props = { busyKey: null, onSubmit, onReload, onSetInheritedAudience: async () => undefined, targetServerId: "sample" };
  const view = renderCard({ ...props, mcpServers: [syntheticServer] });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep while reloading" } });
  view.rerender({ ...props, mcpServers: [] });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  const reload = screen.getByRole("button", { name: "Reload connections" });
  reload.focus(); fireEvent.click(reload); fireEvent.click(reload);
  expect(onReload).toHaveBeenCalledTimes(1);
  expect(document.activeElement).toBe(reload);
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep while reloading");
  view.rerender({ ...props, mcpServers: [syntheticServer] });
  await act(async () => { complete(); });
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep while reloading");
  expect((screen.getByRole("button", { name: "Save connection" }) as HTMLButtonElement).disabled).toBe(false);
  expect(document.activeElement).toBe(screen.getByRole("status", { name: "" }));
  expect(onSubmit).not.toHaveBeenCalled();
});

it("keeps a missing draft and offers another read after reload fails", async () => {
  const onReload = vi.fn().mockRejectedValue(new Error("Sample list unavailable"));
  const props = { busyKey: null, onSubmit: vi.fn(), onReload, onSetInheritedAudience: async () => undefined };
  const view = renderCard({ ...props, mcpServers: [syntheticServer], targetServerId: "sample" });
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Retained failed read" } });
  view.rerender({ ...props, mcpServers: [], targetServerId: "sample" });
  const reload = screen.getByRole("button", { name: "Reload connections" });
  reload.focus(); fireEvent.click(reload);
  expect(await screen.findByText("Sample list unavailable")).toBeTruthy();
  expect(document.activeElement).toBe(reload);
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Retained failed read");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it.each([
  { opener: "Manage Synthetic MCP", dirty: false },
  { opener: "Manage Synthetic MCP", dirty: true },
  { opener: "Add connection", dirty: false }
])("returns focus to $opener after Cancel, dirty=$dirty", ({ opener, dirty }) => {
  renderCard();
  const trigger = screen.getByRole("button", { name: opener });
  trigger.focus(); fireEvent.click(trigger);
  if (dirty) fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Discard this" } });
  const cancel = screen.getByRole("button", { name: "Cancel" });
  cancel.focus(); fireEvent.click(cancel);
  if (dirty) fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(screen.queryByRole("form")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("opens the exact linked connection and leaves missing links safe", () => {
  const first = { serverId: "first", serverName: "First MCP", mode: "managed", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 } as AdminMcpServer;
  const second = { ...first, serverId: "second", serverName: "Second MCP", routePath: "/mcp/second" };
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  const props = { mcpServers: [first, second], busyKey: null, onSubmit, onSetInheritedAudience: async () => undefined };
  const page = renderCard({ ...props, targetServerId: "second" });
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Second MCP");
  expect(document.activeElement).toBe(screen.getByRole("form", { name: "Manage Second MCP" }));
  expect(onSubmit).not.toHaveBeenCalled();
  page.unmount();
  renderCard({ ...props, targetServerId: "missing" });
  expect(screen.getByRole("alert").textContent).toContain("no longer available");
  expect(screen.queryByRole("form", { name: /Manage/ })).toBeNull();
  expect(onSubmit).not.toHaveBeenCalled();
});

it("opens the linked editor after the initial list arrives", () => {
  const props = { busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn(), targetServerId: "sample" };
  const view = renderCard({ ...props, mcpServers: [], listReady: false });
  expect(screen.queryByRole("form")).toBeNull();
  view.rerender({ ...props, mcpServers: [syntheticServer], listReady: true });
  expect(screen.getByRole("form", { name: "Manage Synthetic MCP" })).toBe(document.activeElement);
  expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Synthetic MCP");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("does not take outside focus when the initial linked list arrives", () => {
  const props = { busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn(), targetServerId: "sample" };
  const content = (ready: boolean) => <><button>Outside editor</button><AdminMcpCard {...props} mcpServers={ready ? [syntheticServer] : []} listReady={ready} /></>;
  const view = render(content(false));
  const outside = screen.getByRole("button", { name: "Outside editor" });
  outside.focus();
  view.rerender(content(true));
  expect(screen.getByRole("form", { name: "Manage Synthetic MCP" })).toBeTruthy();
  expect(document.activeElement).toBe(outside);
});

it("keeps outside focus when a linked target waits for a save", async () => {
  let finish!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  const props = { mcpServers: [syntheticServer, other], busyKey: null, onSubmit, onSetInheritedAudience: vi.fn() };
  const content = (targetServerId: string) => <><button>Outside editor</button><AdminMcpCard {...props} targetServerId={targetServerId} /></>;
  const view = render(content("sample"));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Saved draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  view.rerender(content("other"));
  const outside = screen.getByRole("button", { name: "Outside editor" });
  outside.focus();
  await act(async () => { finish(); });
  expect(screen.getByRole("form", { name: "Manage Other MCP" })).toBeTruthy();
  expect(document.activeElement).toBe(outside);
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it("leaves a background dirty decision unfocused until the person chooses Discard", () => {
  const other = { ...syntheticServer, serverId: "other", serverName: "Other MCP" };
  const props = { mcpServers: [syntheticServer, other], busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn() };
  const content = (targetServerId: string) => <><button>Outside editor</button><AdminMcpCard {...props} targetServerId={targetServerId} /></>;
  const view = render(content("sample"));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Retain background draft" } });
  const outside = screen.getByRole("button", { name: "Outside editor" });
  outside.focus();
  view.rerender(content("other"));
  expect(screen.getByRole("alertdialog")).toBeTruthy();
  expect(document.activeElement).toBe(outside);
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Retain background draft");
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(document.activeElement).toBe(screen.getByRole("form", { name: "Manage Other MCP" }));
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("does not scroll a visible editor heading after Manage", () => {
  const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return { x: 20, y: 240, top: 240, bottom: 280, left: 20, right: 500, width: 480, height: 40, toJSON() {} };
  });
  try {
    renderCard({ mcpServers: [syntheticServer] });
    const manage = screen.getByRole("button", { name: "Manage Synthetic MCP" });
    manage.focus(); fireEvent.click(manage);
    expect(document.activeElement).toBe(screen.getByRole("form", { name: "Manage Synthetic MCP" }));
    expect(scroll).not.toHaveBeenCalled();
  } finally {
    bounds.mockRestore();
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it.each([false, true])("checks built-in Name visibility before revealing the editor, visible=%s", (visible) => {
  const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");
  const scroll = vi.fn();
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scroll });
  const bounds = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const top = this.tagName === "DD" ? (visible ? 400 : window.innerHeight + 40) : 340;
    return { x: 20, y: top, top, bottom: top + 30, left: 20, right: 370, width: 350, height: 30, toJSON() {} };
  });
  try {
    const server = { ...syntheticServer, ownerTenantId: "system", mode: "managed" as const };
    renderCard({ mcpServers: [server] });
    fireEvent.click(screen.getByRole("button", { name: "Manage Synthetic MCP" }));
    expect(document.activeElement).toBe(screen.getByRole("form", { name: "Manage Synthetic MCP" }));
    if (visible) expect(scroll).not.toHaveBeenCalled();
    else expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  } finally {
    bounds.mockRestore();
    if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", scrollDescriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  }
});

it.each([false, true])("reveals the editor start after Keep editing, saved=%s", (saved) => {
  const props = { mcpServers: [syntheticServer], busyKey: null, onSubmit: vi.fn(), onSetInheritedAudience: vi.fn() };
  renderCard({ ...props, targetServerId: saved ? "sample" : undefined });
  if (!saved) fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "Keep this draft" } });
  const form = screen.getByRole("form");
  const scroll = vi.fn();
  form.scrollIntoView = scroll;
  vi.spyOn(form, "getBoundingClientRect").mockReturnValue({ top: -700, bottom: 300 } as DOMRect);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect(document.activeElement).toBe(form);
  expect(scroll).toHaveBeenCalledWith({ block: "start", behavior: "instant" });
  expect((screen.getByLabelText("Description") as HTMLTextAreaElement).value).toBe("Keep this draft");
  expect(props.onSubmit).not.toHaveBeenCalled();
});

it("shows both warnings and still submits a local HTTP MCP upstream", async () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  const server = {
    serverId: "local",
    serverName: "Local MCP",
    description: null,
    mode: "proxy",
    routePath: "/mcp/local",
    upstreamUrl: "http://100.108.24.234:3108/mcp",
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: false,
    version: 1
  } as AdminMcpServer;

  renderCard({ mcpServers: [server], onSubmit });

  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect(screen.getByText(/HTTP sends requests without encryption/)).toBeTruthy();
  expect(screen.getByText(/local or shared network/)).toBeTruthy();
  const submit = screen.getByRole("button", { name: "Save connection" });
  expect((submit as HTMLButtonElement).disabled).toBe(false);

  fireEvent.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({ upstreamUrl: "http://100.108.24.234:3108/mcp" }),
    "local"
  ));
});

it("does not show an upstream URL for a managed server", () => {
  const server = {
    serverId: "managed",
    serverName: "Managed MCP",
    description: null,
    mode: "managed",
    routePath: "/mcp/managed",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: false,
    version: 1
  } as AdminMcpServer;

  renderCard({ mcpServers: [server] });

  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect(screen.queryByLabelText("URL")).toBeNull();
  expect(screen.queryByText(/local or shared network/)).toBeNull();
});

it("derives connection routing and saves an explicit off audience", async () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [], onSubmit });

  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Research database" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/mcp" } });
  const submit = screen.getAllByRole("button", { name: "Add connection" }).find(
    (button) => (button as HTMLButtonElement).type === "submit"
  );
  expect(submit).toBeTruthy();
  fireEvent.click(submit!);

  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(
    expect.objectContaining({
      serverId: "research-database",
      routePath: "/mcp/research-database",
      upstreamUrl: "https://example.com/mcp",
      audience: "off"
    }),
    null
  ));
});

it("changes an inherited connection's tenant availability without editing system fields", async () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  const onSetInheritedAudience = vi.fn(async () => undefined);
  const server = {
    serverId: "built-in",
    ownerTenantId: "system",
    serverName: "Built-in",
    description: "System tools",
    mode: "managed",
    routePath: "/mcp/built-in",
    upstreamUrl: null,
    upstreamAuthType: "none",
    upstreamAuthName: null,
    upstreamAuthConfigured: false,
    transportKind: "http",
    enabled: true,
    isAllowed: true,
    isPublished: true,
    version: 1,
    configHash: "test",
    createdBy: "system",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  } as AdminMcpServer;

  renderCard({ mcpServers: [server], onSubmit, onSetInheritedAudience });
  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect(screen.getByRole("heading", { name: "Built-in connection" })).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText("System tools")).toBeTruthy();
  expect(screen.getByText("route /mcp/built-in")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save availability" }));
  await waitFor(() => expect(onSetInheritedAudience).toHaveBeenCalledWith("built-in", "members"));
  expect(onSubmit).not.toHaveBeenCalled();
});

it("keeps organization accounts as the default for new proxy connections", async () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  expect((screen.getByRole("radio", { name: "Organization account" }) as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Shared tools" } });
  fireEvent.change(screen.getByLabelText("URL"), { target: { value: "https://example.com/mcp" } });
  const submit = screen.getAllByRole("button", { name: "Add connection" }).find((button) => (button as HTMLButtonElement).type === "submit")!;
  fireEvent.click(submit);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ credentialScope: "organization" }), null));
});

it("requires authentication for each member and never asks the admin for a shared secret", async () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  const server = {
    serverId: "research", serverName: "Research", description: null, mode: "proxy",
    routePath: "/mcp/research", upstreamUrl: "https://example.com/mcp",
    upstreamAuthType: "bearer", upstreamAuthName: null, upstreamAuthConfigured: false,
    credentialScope: "personal", transportKind: "http", enabled: true, isAllowed: true,
    isPublished: false, version: 1
  } as AdminMcpServer;
  renderCard({ mcpServers: [server], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: /^Manage / }));
  expect((screen.getByRole("radio", { name: "Each member connects" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByLabelText("Secret")).toBeNull();
  expect(screen.getByText(/Changing the URL or authentication method requires members to reconnect/)).toBeTruthy();
  expect(screen.getByText("authentication bearer")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    credentialScope: "personal", upstreamAuthType: "bearer", upstreamAuthSecret: null
  }), "research"));
});

it("rejects personal scope without authentication", () => {
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [], onSubmit });
  fireEvent.click(screen.getByRole("button", { name: "Add connection" }));
  fireEvent.click(screen.getByRole("radio", { name: "Each member connects" }));
  expect(screen.getByText(/Choose bearer token/)).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getAllByRole("button", { name: "Add connection" }).find((button) => (button as HTMLButtonElement).type === "submit") as HTMLButtonElement).disabled).toBe(true);
  expect(onSubmit).not.toHaveBeenCalled();
});

it("keeps the saved connection open so its test stays in reach", async () => {
  const server = { serverId: "first", serverName: "First MCP", mode: "managed", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: true, version: 2, configHash: "h" } as AdminMcpServer;
  const onSubmit = vi.fn<Parameters<typeof AdminMcpCard>[0]["onSubmit"]>(async () => undefined);
  renderCard({ mcpServers: [server], onSubmit });
  expect(screen.getByText(/Available to members\. Not tested since the last save\./)).toBeTruthy();
  const manage = screen.getByRole("button", { name: "Manage First MCP" });
  fireEvent.click(manage);
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalled());
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  expect(manage.getAttribute("aria-expanded")).toBe("true");
  expect(screen.getByRole("button", { name: "Test saved version 2" }).closest("[hidden]")).toBeNull();
  expect(screen.getByRole("button", { name: "Edit settings" })).toBeTruthy();
});

it.each([false, true])("returns owned form focus after save when controls become available, outside=%s", async (outside) => {
  let finish!: () => void;
  const onSubmit = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const content = (busyKey: string | null) => <><AdminMcpCard mcpServers={[syntheticServer]} busyKey={busyKey} onSubmit={onSubmit} onSetInheritedAudience={async () => undefined} /><button>Outside editor</button></>;
  const view = render(content(null));
  const manage = screen.getByRole("button", { name: "Manage Synthetic MCP" });
  fireEvent.click(manage);
  fireEvent.click(screen.getByRole("button", { name: "Save connection" }));
  view.rerender(content("mcp"));
  (outside ? screen.getByRole("button", { name: "Outside editor" }) : screen.getByRole("form")).focus();
  await act(async () => { finish(); });
  expect(screen.queryByRole("form")).toBeNull();
  view.rerender(content(null));
  expect(document.activeElement).toBe(outside ? screen.getByRole("button", { name: "Outside editor" }) : manage);
});

it("gives each connection's open state to the extra content of its row", () => {
  const first = { serverId: "first", serverName: "First MCP", mode: "proxy", routePath: "/mcp/first", upstreamAuthType: "none", transportKind: "http", enabled: true, isAllowed: true, isPublished: false, version: 1 } as AdminMcpServer;
  const second = { ...first, serverId: "second", serverName: "Second MCP", routePath: "/mcp/second" };
  const renderServerExtras = vi.fn((server: AdminMcpServer, open: boolean) => <p>{server.serverId} {open ? "open" : "closed"}</p>);
  renderCard({ mcpServers: [first, second], renderServerExtras });
  expect(screen.getByText("first closed")).toBeTruthy();
  expect(screen.getByText("second closed")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Manage Second MCP" }));
  expect(screen.getByText("second open")).toBeTruthy();
  expect(screen.getByText("first closed")).toBeTruthy();
});
