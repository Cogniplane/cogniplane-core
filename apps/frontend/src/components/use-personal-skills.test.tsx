// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PersonalSkill } from "@cogniplane/shared-types";
import { getPersonalSkills } from "@/lib/personal-skills-api";
import { usePersonalSkills, type FocusProbe } from "./use-personal-skills";

vi.mock("@/lib/personal-skills-api", () => ({
  actOnPersonalSkill: vi.fn(), createPersonalSkill: vi.fn(), deletePersonalSkill: vi.fn(),
  getPersonalSkillHistory: vi.fn(), getPersonalSkills: vi.fn(), updatePersonalSkill: vi.fn()
}));
const scope = { tenantId: "tenant-a", userId: "person-a" };
const focusProbe: FocusProbe = { capture: () => null, owns: () => true, ownsRecovery: () => true };
type ListResult = { scope: typeof scope; skills: PersonalSkill[] };
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};
const markdownFile = (text: () => Promise<string>) => ({ name: "SKILL.md", size: 10, text }) as unknown as File;
const render = () => renderHook(() => usePersonalSkills({ expectedScope: scope, requestedSubmissionId: null, focusProbe }));
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

it("drops a pending file read when the scope locks", async () => {
  const list = deferred<ListResult>();
  const file = deferred<string>();
  vi.mocked(getPersonalSkills).mockReturnValueOnce(list.promise);
  const { result } = render();
  act(() => result.current.dispatch({ type: "openCreate" }));
  let started = false;
  act(() => { started = result.current.readFile(markdownFile(() => file.promise)); });
  expect(started).toBe(true);
  expect(result.current.readingFile).toBe(true);
  await act(async () => list.resolve({ scope: { ...scope, userId: "person-b" }, skills: [] }));
  expect(result.current.state).toEqual({ status: "locked", reason: "scope_changed", focus: { target: "heading" } });
  expect(result.current.readingFile).toBe(false);
  await act(async () => file.resolve("late private text"));
  expect(JSON.stringify(result.current.state)).not.toContain("late private text");
  expect(result.current.readFile(markdownFile(vi.fn()))).toBe(false);
});

it("starts one list read for two reloads in the same turn", async () => {
  const reload = deferred<ListResult>();
  vi.mocked(getPersonalSkills).mockResolvedValueOnce({ scope, skills: [] }).mockReturnValueOnce(reload.promise);
  const { result } = render();
  await act(async () => {});
  act(() => { result.current.reloadList(); result.current.reloadList(); result.current.reloadLatest(); });
  expect(getPersonalSkills).toHaveBeenCalledTimes(2);
  await act(async () => reload.resolve({ scope, skills: [] }));
  expect(result.current.state).toMatchObject({ status: "active", list: { loading: false, error: null } });
});
