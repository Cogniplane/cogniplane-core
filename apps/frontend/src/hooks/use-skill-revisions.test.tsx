// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillRevision } from "@cogniplane/shared-types";
import { useSkillRevisions } from "./use-skill-revisions";

afterEach(cleanup);
function pending() {
  let resolve!: (value: SkillRevision[]) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<SkillRevision[]>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const row = (id: number) => ({ skillRevisionId: id } as SkillRevision);

it("selects B before its read completes and late A never selects A again", async () => {
  const a = pending(), b = pending();
  const { result } = renderHook(() => useSkillRevisions({ onListRevisions: id => id === "a" ? a.promise : b.promise }));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.toggle("a"); });
  expect(result.current.expandedSkillId).toBe("a");
  expect(result.current.loading.a).toBe(true);
  act(() => { second = result.current.open("b"); });
  expect(result.current.expandedSkillId).toBe("b");
  await act(async () => { b.resolve([row(2)]); await second; });
  await act(async () => { a.resolve([row(1)]); await first; });
  expect(result.current.expandedSkillId).toBe("b");
  expect(result.current.revisionMap.b).toEqual([row(2)]);
});

it("a closed pending history stays closed when its response arrives", async () => {
  const a = pending();
  const { result } = renderHook(() => useSkillRevisions({ onListRevisions: () => a.promise }));
  let first!: Promise<void>;
  act(() => { first = result.current.toggle("a"); });
  await act(() => result.current.toggle("a"));
  await act(async () => { a.resolve([row(1)]); await first; });
  expect(result.current.expandedSkillId).toBeNull();
});

it.each([
  { order: "old first", outcome: "success" },
  { order: "old first", outcome: "failure" },
  { order: "latest first", outcome: "success" },
  { order: "latest first", outcome: "failure" }
])("ignores old $outcome with $order and keeps the latest data, error and pending state", async ({ order, outcome }) => {
  const old = pending(), latest = pending();
  const read = vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
  const { result } = renderHook(() => useSkillRevisions({ onListRevisions: read }));
  let first!: Promise<void>, second!: Promise<void>;
  act(() => { first = result.current.open("a"); });
  act(() => { second = result.current.open("a"); });
  const finishOld = async () => {
    await act(async () => {
      if (outcome === "success") old.resolve([row(1)]);
      else old.reject(new Error("Old failure"));
      await first;
    });
  };
  const finishLatest = async () => { await act(async () => { latest.resolve([row(2)]); await second; }); };
  if (order === "old first") {
    await finishOld();
    expect(result.current.loading.a).toBe(true);
    expect(result.current.loadError.a).toBeUndefined();
    await finishLatest();
  } else {
    await finishLatest();
    await finishOld();
  }
  expect(result.current.expandedSkillId).toBe("a");
  expect(result.current.loading.a).toBe(false);
  expect(result.current.loadError.a).toBeUndefined();
  expect(result.current.revisionMap.a).toEqual([row(2)]);
});
