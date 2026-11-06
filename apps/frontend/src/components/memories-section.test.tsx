// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MemoriesResponse, Memory } from "@cogniplane/shared-types";

import { memoriesKey } from "@/hooks/use-memories";
import { ApiError } from "@/lib/api-client";
import { deleteMemory, listMemories, updateMemory } from "@/lib/memories-api";
import { formatMediumDateTime } from "@/lib/time-format";
import { MemoriesSection } from "./memories-section";

vi.mock("@/lib/memories-api", () => ({ listMemories: vi.fn(), updateMemory: vi.fn(), deleteMemory: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const scope = { tenantId: "tenant-a", userId: "member-1" };

function memory(overrides: Partial<Memory> = {}): Memory {
  return {
    id: "m1", name: "units", content: "User prefers metric units.", metadata: {}, version: 2,
    provenance: "agent_approved", approvedAt: "2026-07-02T10:00:00.000Z",
    createdAt: "2026-07-01T10:00:00.000Z", updatedAt: "2026-07-02T10:00:00.000Z",
    ...overrides
  };
}
const units = memory();
const standup = memory({ id: "m2", name: "standup-time", content: "Standup is at 9:30.", version: 1,
  provenance: "user_authored", updatedAt: "2026-06-01T10:00:00.000Z" });
const legacy = memory({ id: "m3", name: "old-note", content: "Saved long ago.", version: 1,
  provenance: "unverified", approvedAt: null });

function apiError(status: number, code: string) {
  return new ApiError({ status, code, method: "PUT", path: "/me/memories/m1", message: code });
}

let client: QueryClient;
function mount(overrides: { scope?: typeof scope } = {}) {
  return render(
    <QueryClientProvider client={client}><MemoriesSection scope={overrides.scope ?? scope} /></QueryClientProvider>
  );
}
const card = (name: string) => screen.getByText(name, { selector: "code" }).closest("li")!;
const editor = () => screen.getByRole("textbox", { name: "Text of memory units" }) as HTMLTextAreaElement;
const REAPPLY = "Reapply my text to the latest version";
function startEditing(text?: string) {
  fireEvent.click(screen.getByRole("button", { name: "Edit memory units" }));
  if (text !== undefined) fireEvent.change(editor(), { target: { value: text } });
}
// The agent saved newer text in another chat, so the list now holds version 3.
const newer = memory({ content: "The agent updated this in another chat.", version: 3, updatedAt: "2026-07-05T10:00:00.000Z" });
const withNewer = { scope, memories: [newer, standup, legacy], total: 3 };
const conflict = () => apiError(409, "memory_conflict");
/**
 * The page reads the list again while the editor is open. The test waits until the card shows
 * the new update time, because only then has the card received version 3. A click before that
 * would run against the old render and the test would prove nothing.
 */
async function refreshListWhileEditing() {
  vi.mocked(listMemories).mockResolvedValue(withNewer);
  await act(async () => { await client.refetchQueries({ queryKey: memoriesKey(scope) }); });
  expect(client.getQueryData<MemoriesResponse>(memoriesKey(scope))!.memories[0]!.version).toBe(3);
  await screen.findByText(`Updated ${formatMediumDateTime(newer.updatedAt, "recently")}`);
}

beforeEach(() => {
  vi.resetAllMocks();
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(listMemories).mockResolvedValue({ scope, memories: [units, standup, legacy], total: 3 });
  vi.mocked(updateMemory).mockResolvedValue({ scope, memory: { ...units, content: "Edited.", version: 3, provenance: "user_authored" } });
  vi.mocked(deleteMemory).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); client.clear(); vi.restoreAllMocks(); });

it("lists each memory with its full text and where it came from, and flags the unverified one", async () => {
  mount();

  expect(await screen.findByText("User prefers metric units.")).toBeTruthy();
  expect(within(card("units")).getByText("Approved by you")).toBeTruthy();
  expect(within(card("units")).getByText(/The agent proposed this text and you approved it on/)).toBeTruthy();
  expect(within(card("standup-time")).getByText("Written by you")).toBeTruthy();
  const flagged = card("old-note");
  expect(within(flagged).getByText("Not verified")).toBeTruthy();
  expect(within(flagged).getByText(/Saved before approvals were recorded/)).toBeTruthy();
  expect(screen.getByText(/nothing is saved until you approve the exact text in the chat/)).toBeTruthy();
});

it("shows characters that do not display, so a hidden instruction cannot sit in a memory unseen", async () => {
  vi.mocked(listMemories).mockResolvedValue({
    scope, total: 1, memories: [memory({ content: "Use metric\u200b units\u{e0049}" })]
  });
  mount();

  expect(await screen.findByText("Use metric⟦U+200B⟧ units⟦U+E0049⟧")).toBeTruthy();
  expect(screen.getByText(/contains characters that do not display/)).toBeTruthy();
});

it("shows the extra data that the agent attached", async () => {
  vi.mocked(listMemories).mockResolvedValue({ scope, total: 1, memories: [memory({ metadata: { source: "chat" } })] });
  mount();

  expect(await screen.findByText('{"source":"chat"}')).toBeTruthy();
});

it("says so when the list holds fewer memories than the user has", async () => {
  vi.mocked(listMemories).mockResolvedValue({ scope, memories: [units], total: 250 });
  mount();

  expect(await screen.findByText("Showing your 1 most recently updated memories of 250.")).toBeTruthy();
});

it("explains how memories arrive when there are none", async () => {
  vi.mocked(listMemories).mockResolvedValue({ scope, memories: [], total: 0 });
  mount();

  expect(await screen.findByText(/No saved memories yet/)).toBeTruthy();
});

it("lets the user retry after a load failure", async () => {
  vi.mocked(listMemories).mockRejectedValueOnce(new Error("offline"));
  mount();

  expect((await screen.findByRole("alert")).textContent).toContain("Could not load your memories.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByText("User prefers metric units.")).toBeTruthy();
});

it("keeps Retry's focus request when the frame runs before the recovered rows render", async () => {
  vi.mocked(listMemories).mockRejectedValueOnce(new Error("offline"));
  mount();
  const retry = await screen.findByRole("button", { name: "Retry" });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
  retry.focus();
  fireEvent.click(retry);

  const edit = await screen.findByRole("button", { name: "Edit memory units" });
  await waitFor(() => expect(document.activeElement).toBe(edit));
});

it("saves an edit with the account and the version that the page loaded, and shows the result", async () => {
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Edit memory units" }));
  const editor = screen.getByRole("textbox", { name: "Text of memory units" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("User prefers metric units.");
  // Nothing changed yet, so there is nothing to save.
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(editor, { target: { value: "Edited." } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updateMemory).toHaveBeenCalledWith("m1", { scope, content: "Edited.", version: 2 }));
  expect(await screen.findByText("Edited.")).toBeTruthy();
  expect(within(card("units")).getByText("Written by you")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(toast.success).toHaveBeenCalledWith('Memory "units" was updated.');
});

it("does not save an empty text, and offers cancel", async () => {
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Edit memory units" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Text of memory units" }), { target: { value: "   " } });
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

  expect(screen.queryByRole("textbox")).toBeNull();
  expect(updateMemory).not.toHaveBeenCalled();
});

it("sends the version that the editor started from, even when the list was refreshed to a newer one", async () => {
  vi.mocked(updateMemory).mockRejectedValue(conflict());
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My edit of the old text.");

  // The agent changed the memory in another chat, and the page read the list again while the editor was open.
  await refreshListWhileEditing();
  expect(editor().value).toBe("My edit of the old text.");

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  // Version 3 would have replaced the newer text with no conflict, and the user would never have seen it.
  // Version 2 is the text that the edit was based on, so the server refuses the save.
  await waitFor(() => expect(updateMemory).toHaveBeenCalledWith("m1", { scope, content: "My edit of the old text.", version: 2 }));
});

it("does not offer to save text that is unchanged from where the editor started, even after the list was refreshed", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing();

  await refreshListWhileEditing();

  expect(editor().value).toBe("User prefers metric units.");
  expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
});

it("keeps the editor and the user's text on a conflict, shows the latest saved text beside it, and offers reapply or discard", async () => {
  vi.mocked(updateMemory).mockRejectedValueOnce(conflict());
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My careful edit.");
  vi.mocked(listMemories).mockResolvedValue(withNewer); // the list that the conflict makes the page read again

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect((await screen.findByRole("alert")).textContent).toContain("changed after you opened it");
  // The text that the user typed is still in the editor.
  expect(editor().value).toBe("My careful edit.");
  // The latest saved text is shown beside it.
  expect((await screen.findByLabelText("Latest saved text")).textContent).toBe("The agent updated this in another chat.");
  // Save gives way to the two choices.
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByRole("button", { name: REAPPLY })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Discard my edit" })).toBeTruthy();
  expect(updateMemory).toHaveBeenCalledTimes(1);
});

it("reapplies the user's text to the latest version, and the next save sends that version", async () => {
  vi.mocked(updateMemory)
    .mockRejectedValueOnce(conflict())
    .mockResolvedValueOnce({ scope, memory: { ...newer, content: "My careful edit.", version: 4, provenance: "user_authored" } });
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My careful edit.");
  vi.mocked(listMemories).mockResolvedValue(withNewer);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByLabelText("Latest saved text");
  await waitFor(() => expect((screen.getByRole("button", { name: REAPPLY }) as HTMLButtonElement).disabled).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: REAPPLY }));

  // The conflict is cleared, the user's text is still there, and Save is back.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByLabelText("Latest saved text")).toBeNull();
  expect(editor().value).toBe("My careful edit.");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => expect(updateMemory).toHaveBeenCalledTimes(2));
  expect(vi.mocked(updateMemory).mock.calls.map(([, input]) => input.version)).toEqual([2, 3]);
  expect(vi.mocked(updateMemory).mock.calls[1]![1]).toEqual({ scope, content: "My careful edit.", version: 3 });
  expect(await screen.findByText("My careful edit.")).toBeTruthy();
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("discards the user's text on request and shows the latest saved text", async () => {
  vi.mocked(updateMemory).mockRejectedValueOnce(conflict());
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My careful edit.");
  vi.mocked(listMemories).mockResolvedValue(withNewer);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByLabelText("Latest saved text");

  fireEvent.click(screen.getByRole("button", { name: "Discard my edit" }));

  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(within(card("units")).getByText("The agent updated this in another chat.")).toBeTruthy();
  expect(screen.queryByText("My careful edit.")).toBeNull();
  expect(updateMemory).toHaveBeenCalledTimes(1);
});

it("says when the latest saved text could not be loaded, keeps the user's text, and lets them reload it", async () => {
  vi.mocked(updateMemory).mockRejectedValueOnce(conflict());
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My careful edit.");
  vi.mocked(listMemories).mockRejectedValueOnce(new Error("offline")); // the read after the conflict fails

  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect(await screen.findByText(/latest saved text could not be loaded/)).toBeTruthy();
  expect(editor().value).toBe("My careful edit.");
  expect((screen.getByRole("button", { name: REAPPLY }) as HTMLButtonElement).disabled).toBe(true);

  vi.mocked(listMemories).mockResolvedValue(withNewer);
  fireEvent.click(screen.getByRole("button", { name: "Reload it" }));

  expect((await screen.findByLabelText("Latest saved text")).textContent).toBe("The agent updated this in another chat.");
  await waitFor(() => expect((screen.getByRole("button", { name: REAPPLY }) as HTMLButtonElement).disabled).toBe(false));
  expect(editor().value).toBe("My careful edit.");
});

it("handles a second conflict after a reapply the same way, against the newest version", async () => {
  vi.mocked(updateMemory).mockRejectedValue(conflict());
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My careful edit.");
  vi.mocked(listMemories).mockResolvedValue(withNewer);
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByLabelText("Latest saved text");
  await waitFor(() => expect((screen.getByRole("button", { name: REAPPLY }) as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: REAPPLY }));

  // Before the user saves again, the agent changes the memory once more.
  vi.mocked(listMemories).mockResolvedValue({ scope, total: 3,
    memories: [memory({ content: "Changed again by the agent.", version: 4 }), standup, legacy] });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  expect((await screen.findByLabelText("Latest saved text")).textContent).toBe("Changed again by the agent.");
  expect(vi.mocked(updateMemory).mock.calls.map(([, input]) => input.version)).toEqual([2, 3]);
  expect(editor().value).toBe("My careful edit.");
});

it("asks before it deletes, sends the account, and removes the memory from the list", async () => {
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  const dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading").textContent).toContain("Delete memory");
  expect(within(dialog).getByRole("heading").textContent).toContain("units");
  expect(deleteMemory).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole("button", { name: "Delete memory" }));

  await waitFor(() => expect(deleteMemory).toHaveBeenCalledWith("m1", scope));
  await waitFor(() => expect(screen.queryByText("User prefers metric units.")).toBeNull());
  expect(screen.getByText("Standup is at 9:30.")).toBeTruthy();
  expect(toast.success).toHaveBeenCalledWith('Memory "units" was deleted.');
});

it("deletes nothing when the user cancels", async () => {
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Cancel" }));

  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(deleteMemory).not.toHaveBeenCalled();
  expect(screen.getByText("User prefers metric units.")).toBeTruthy();
});

it("shows a failed delete inside the dialog and keeps the memory", async () => {
  vi.mocked(deleteMemory).mockRejectedValue(new Error("Server unavailable"));
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete memory" }));

  const dialog = await screen.findByRole("alertdialog");
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Server unavailable");
  // The dialog stays open for another try, and the memory stays.
  expect((within(dialog).getByRole("button", { name: "Delete memory" }) as HTMLButtonElement).disabled).toBe(false);
  expect(deleteMemory).toHaveBeenCalledTimes(1);
});

it("hides every memory when the server answers for another account", async () => {
  vi.mocked(listMemories).mockResolvedValue({ scope: { ...scope, userId: "someone-else" }, memories: [units], total: 1 });
  mount();

  expect((await screen.findByRole("alert")).textContent).toContain("account or organization changed");
  expect(screen.queryByText("User prefers metric units.")).toBeNull();
});

it("locks the page when a write is refused because the account changed", async () => {
  vi.mocked(deleteMemory).mockRejectedValue(apiError(409, "memory_scope_changed"));
  mount();
  await screen.findByText("User prefers metric units.");

  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete memory" }));

  await waitFor(() => expect(screen.queryByText("User prefers metric units.")).toBeNull());
  expect(screen.getAllByRole("alert").some((alert) => alert.textContent?.includes("account or organization changed"))).toBe(true);
});

it("keeps a dirty draft on refused cancel, then discards it only on confirmation", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("Keep this draft.");
  expect(document.activeElement).toBe(editor());
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  let dialog = await screen.findByRole("alertdialog");
  expect(within(dialog).getByRole("heading").textContent).toContain("units");
  expect(within(dialog).getByText(/saved memory will stay unchanged/)).toBeTruthy();
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(editor().value).toBe("Keep this draft.");
  await waitFor(() => expect(document.activeElement).toBe(editor()));
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard edit" }));
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit memory units" })));
  expect(updateMemory).not.toHaveBeenCalled();
});

it("uses the same discard rule when switching memories and opens the chosen editor after confirmation", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("Keep this draft.");
  fireEvent.click(screen.getByRole("button", { name: "Edit memory standup-time" }));
  let dialog = await screen.findByRole("alertdialog");
  expect(dialog.textContent).toContain('Then the editor will open "standup-time".');
  fireEvent.click(within(dialog).getByRole("button", { name: "Keep editing" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(editor().value).toBe("Keep this draft.");
  fireEvent.click(screen.getByRole("button", { name: "Edit memory standup-time" }));
  dialog = await screen.findByRole("alertdialog");
  fireEvent.click(within(dialog).getByRole("button", { name: "Discard edit" }));
  const next = await screen.findByRole("textbox", { name: "Text of memory standup-time" });
  expect((next as HTMLTextAreaElement).value).toBe(standup.content);
  await waitFor(() => expect(document.activeElement).toBe(next));
  expect(updateMemory).not.toHaveBeenCalled();
});

it("exits an unchanged editor directly even after a background refresh changes the saved text", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing();
  act(() => { client.setQueryData(memoriesKey(scope), withNewer); });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(screen.queryByRole("alertdialog")).toBeNull();
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.getByText(newer.content)).toBeTruthy();
});

it("reports a failed refresh with last-known data and keeps the editor through retry", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("My retained draft.");
  vi.mocked(listMemories).mockRejectedValueOnce(new Error("offline"));
  await act(async () => { await client.invalidateQueries({ queryKey: memoriesKey(scope) }); });
  expect(await screen.findByText(/Showing the last loaded list/)).toBeTruthy();
  expect(screen.getByText(standup.content)).toBeTruthy();
  expect(editor().value).toBe("My retained draft.");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.queryByText(/Showing the last loaded list/)).toBeNull());
  expect(editor().value).toBe("My retained draft.");
});

it("locks and clears a dirty editor and discard decision on a scope failure during refresh", async () => {
  mount();
  await screen.findByText("User prefers metric units.");
  startEditing("Private draft.");
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  await screen.findByRole("alertdialog");
  vi.mocked(listMemories).mockResolvedValueOnce({ scope: { ...scope, userId: "someone-else" }, memories: [units], total: 1 });
  await act(async () => { await client.invalidateQueries({ queryKey: memoriesKey(scope) }); });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(screen.queryByRole("textbox")).toBeNull();
  expect(screen.queryByText(units.content)).toBeNull();
  expect(client.getQueryData(memoriesKey(scope))).toBeUndefined();
  expect(screen.getByRole("alert").textContent).toContain("account or organization changed");
});

it("prevents duplicate pending saves and returns focus to Edit after success", async () => {
  let resolve!: (value: { scope: typeof scope; memory: Memory }) => void;
  vi.mocked(updateMemory).mockImplementation(() => new Promise(done => { resolve = done; }));
  mount();
  await screen.findByText(units.content);
  startEditing("My saved text.");
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.click(save);
  fireEvent.click(save);
  await waitFor(() => expect(updateMemory).toHaveBeenCalledTimes(1));
  expect((screen.getByRole("button", { name: "Saving…" }) as HTMLButtonElement).disabled).toBe(true);
  // Run focus before React replaces the editor with the saved row's controls.
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
  await act(async () => { resolve({ scope, memory: memory({ content: "My saved text.", version: 3 }) }); });
  await waitFor(() => expect(screen.queryByRole("textbox")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Edit memory units" })));
});

it("prevents duplicate pending deletes and returns focus to the next memory", async () => {
  let resolve!: () => void;
  vi.mocked(deleteMemory).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
  mount();
  await screen.findByText(units.content);
  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  const dialog = await screen.findByRole("alertdialog");
  const remove = within(dialog).getByRole("button", { name: "Delete memory" });
  fireEvent.click(remove);
  fireEvent.click(remove);
  await waitFor(() => expect(deleteMemory).toHaveBeenCalledTimes(1));
  expect((within(dialog).getByRole("button", { name: "Deleting…" }) as HTMLButtonElement).disabled).toBe(true);
  expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { resolve(); });
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete memory standup-time" })));
});

it("moves focus to the section heading when the last memory is removed", async () => {
  vi.mocked(listMemories).mockResolvedValue({ scope, memories: [units], total: 1 });
  mount();
  await screen.findByText(units.content);
  fireEvent.click(screen.getByRole("button", { name: "Delete memory units" }));
  fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Delete memory" }));
  await screen.findByText(/No saved memories yet/);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "What the agent remembers about you" })));
});

it("returns focus to the retained editor after a failed latest read is retried", async () => {
  vi.mocked(updateMemory).mockRejectedValueOnce(conflict());
  mount();
  await screen.findByText(units.content);
  startEditing("My retained draft.");
  vi.mocked(listMemories).mockRejectedValueOnce(new Error("offline"));
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/latest saved text could not be loaded/);
  await waitFor(() => expect(document.activeElement).toBe(editor()));
  vi.mocked(listMemories).mockResolvedValue(withNewer);
  const reload = screen.getByRole("button", { name: "Reload it" });
  reload.focus();
  fireEvent.click(reload);
  await screen.findByLabelText("Latest saved text");
  await waitFor(() => expect(document.activeElement).toBe(editor()));
  expect(editor().value).toBe("My retained draft.");
});

it("warns on page unload only while the draft differs from its original base", async () => {
  mount();
  await screen.findByText(units.content);
  startEditing();
  const clean = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(clean);
  expect(clean.defaultPrevented).toBe(false);
  fireEvent.change(editor(), { target: { value: "Unsaved text." } });
  const dirty = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(dirty);
  expect(dirty.defaultPrevented).toBe(true);
  fireEvent.change(editor(), { target: { value: units.content } });
  const reverted = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(reverted);
  expect(reverted.defaultPrevented).toBe(false);
});
