// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { FormEvent } from "react";
import type { SkillImportResponse } from "@cogniplane/shared-types";
import { useSkillImports } from "./use-skill-imports";

const imported = {} as SkillImportResponse;
const draft = { skillId: " brief ", skillName: " Brief ", description: " Description ", instructions: "  # Keep\n" };
const github = { githubUrl: "https://github.com/fictional/skills", ref: "", subdirectory: "" };
const submit = (form = document.createElement("form")) => ({ preventDefault: vi.fn(), currentTarget: form }) as unknown as FormEvent<HTMLFormElement>;
function gate() { let resolve!: (value: SkillImportResponse) => void; let reject!: (error: Error) => void; const promise = new Promise<SkillImportResponse>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  const handlers = { onImportInline: vi.fn(async () => imported), onImportGithub: vi.fn(async () => imported), onImportZip: vi.fn(async () => imported), onImported: vi.fn(), onSaveManifestUrl: vi.fn(async () => {}) };
  const hook = renderHook(({ manifestUrl }: { manifestUrl: string | null | undefined }) => useSkillImports({ ...handlers, manifestUrl }), { initialProps: { manifestUrl: "https://example.com/old.json" as string | null | undefined } });
  return { ...hook, handlers };
}
afterEach(cleanup);

it("sends the exact normalized inline snapshot, blocks a duplicate, and preserves later edits and tab choice", async () => {
  const { result, handlers } = setup(); const hold = gate(); handlers.onImportInline.mockReturnValue(hold.promise);
  act(() => { result.current.panel.toggle(); result.current.inline.setDraft(draft); });
  let sent!: Promise<void>;
  act(() => { sent = result.current.inline.submit(submit()); void result.current.inline.submit(submit()); });
  act(() => { result.current.inline.setDraft({ ...draft, instructions: "Later text" }); result.current.panel.setTab("github"); });
  await act(async () => { hold.resolve(imported); await sent; });
  expect(handlers.onImportInline).toHaveBeenCalledOnce();
  expect(handlers.onImportInline).toHaveBeenCalledWith({ skillId: "brief", skillName: "Brief", description: "Description", instructions: "  # Keep\n" });
  expect(result.current.inline.draft.instructions).toBe("Later text");
  expect(result.current.panel).toMatchObject({ open: true, tab: "github" });
  expect(handlers.onImported).toHaveBeenCalledWith(imported);
});

it("keeps GitHub edits on a delayed failure, and clears only the unchanged draft on retry success", async () => {
  const { result, handlers } = setup(); const hold = gate(); handlers.onImportGithub.mockReturnValueOnce(hold.promise);
  act(() => result.current.github.setDraft(() => github));
  let sent!: Promise<void>; act(() => { sent = result.current.github.submit(submit()); });
  act(() => result.current.github.setDraft(current => ({ ...current, ref: "later" })));
  await act(async () => { hold.reject(new Error("Fictional failure")); await sent; });
  expect(result.current.github.draft.ref).toBe("later");
  expect(result.current.errors.github).toBe("Fictional failure");
  expect(handlers.onImportGithub).toHaveBeenNthCalledWith(1, { githubUrl: github.githubUrl, ref: undefined, subdirectory: undefined });
  await act(async () => { await result.current.github.submit(submit()); });
  expect(result.current.github.draft.githubUrl).toBe("");
  expect(handlers.onImportGithub).toHaveBeenNthCalledWith(2, { githubUrl: github.githubUrl, ref: "later", subdirectory: undefined });
});

it("does not reset a replacement ZIP, even when it has the same filename", async () => {
  const { result, handlers } = setup(); const hold = gate(); handlers.onImportZip.mockReturnValue(hold.promise);
  const form = document.createElement("form"); const input = document.createElement("input"); input.type = "file"; input.name = "skill-zip-file"; form.append(input);
  const first = new File(["first"], "draft.zip"); const replacement = new File(["replacement"], "draft.zip");
  Object.defineProperty(input, "files", { value: [first], configurable: true });
  act(() => result.current.zip.setZipFileName(first.name));
  let sent!: Promise<void> | undefined; act(() => { sent = result.current.zip.submit(submit(form)); });
  Object.defineProperty(input, "files", { value: [replacement], configurable: true });
  act(() => { result.current.zip.setZipFileName(replacement.name); result.current.panel.toggle(); });
  await act(async () => { hold.resolve(imported); await sent; });
  expect(handlers.onImportZip).toHaveBeenCalledWith(first);
  expect(input.files?.[0]).toBe(replacement);
  expect(result.current.zip.zipFileName).toBe("draft.zip");
  expect(result.current.panel.open).toBe(true);
});

it("follows saved manifest changes only while pristine, preserving text across save and clear", async () => {
  const { result, rerender, handlers } = setup();
  rerender({ manifestUrl: undefined });
  expect(result.current.marketplace.manifestUrlDraft).toBe("");
  rerender({ manifestUrl: "https://example.com/first.json" });
  expect(result.current.marketplace.manifestUrlDraft).toBe("https://example.com/first.json");
  act(() => result.current.marketplace.setManifestUrlDraft("https://example.com/draft.json"));
  rerender({ manifestUrl: "https://example.com/external.json" });
  expect(result.current.marketplace.changedSavedUrl).toBe(true);
  expect(result.current.marketplace.manifestUrlDraft).toBe("https://example.com/draft.json");
  let finish!: () => void; handlers.onSaveManifestUrl.mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  let saving!: Promise<void> | undefined; act(() => { saving = result.current.marketplace.saveManifestUrl(submit()); });
  act(() => result.current.marketplace.setManifestUrlDraft("https://example.com/later.json"));
  await act(async () => { finish(); await saving; });
  rerender({ manifestUrl: "https://example.com/draft.json" });
  expect(result.current.marketplace.manifestUrlDraft).toBe("https://example.com/later.json");
  await act(async () => { await result.current.marketplace.clearManifestUrl(); });
  rerender({ manifestUrl: null });
  expect(result.current.marketplace.manifestUrlDraft).toBe("https://example.com/later.json");
  expect(result.current.marketplace.changedSavedUrl).toBe(false);
  expect(handlers.onSaveManifestUrl).toHaveBeenLastCalledWith(null);
});

it("preserves all drafts when the import panel closes and refuses a second operation in the same tick", async () => {
  const { result, handlers } = setup(); const hold = gate(); handlers.onImportInline.mockReturnValue(hold.promise);
  act(() => { result.current.panel.toggle(); result.current.inline.setDraft(draft); result.current.github.setDraft(() => github); });
  let sent!: Promise<void>;
  act(() => { sent = result.current.inline.submit(submit()); void result.current.github.submit(submit()); result.current.panel.toggle(); });
  expect(handlers.onImportGithub).not.toHaveBeenCalled();
  await act(async () => { hold.resolve(imported); await sent; });
  expect(result.current.panel.open).toBe(false);
  expect(result.current.github.draft).toEqual(github);
});
