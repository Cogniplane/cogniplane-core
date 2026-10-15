import { expect, test } from "vitest";

import {
  InvalidGithubRepositoryListError,
  isRepositoryAllowed,
  normalizeAllowedRepositories,
  repositoryKey
} from "./github-repository-allowlist.js";

test("normalizeAllowedRepositories lower-cases, trims, de-duplicates and sorts", () => {
  expect(normalizeAllowedRepositories(["Acme/Web", " acme/web ", "acme/API", "octo/Hello.World_1"])).toEqual([
    "acme/api",
    "acme/web",
    "octo/hello.world_1"
  ]);
  expect(normalizeAllowedRepositories([])).toEqual([]);
});

test.each([
  "app",
  "/app",
  "acme/",
  "acme/app/extra",
  "acme/..",
  "../app",
  "acme/app?x=1",
  "acme/app#frag",
  "acme\\app",
  "acme/app\nx",
  "acme/ap p",
  "acme/аpp",
  `${"a".repeat(40)}/app`,
  `acme/${"a".repeat(101)}`,
  ""
])("normalizeAllowedRepositories rejects %j", (value) => {
  expect(() => normalizeAllowedRepositories([value])).toThrow(InvalidGithubRepositoryListError);
});

test("normalizeAllowedRepositories limits the list to 200 repositories after de-duplication", () => {
  const same = Array.from({ length: 500 }, () => "acme/app");
  expect(normalizeAllowedRepositories(same)).toEqual(["acme/app"]);
  const many = Array.from({ length: 201 }, (_, i) => `acme/repo-${i}`);
  expect(() => normalizeAllowedRepositories(many)).toThrow(/at most 200/);
  expect(normalizeAllowedRepositories(many.slice(0, 200))).toHaveLength(200);
});

test("isRepositoryAllowed compares case-insensitively and needs the whole name", () => {
  const allowed = ["acme/app"];
  expect(isRepositoryAllowed(allowed, { owner: "ACME", name: "App" })).toBe(true);
  expect(isRepositoryAllowed(allowed, { owner: "acme", name: "app2" })).toBe(false);
  expect(isRepositoryAllowed(allowed, { owner: "acme2", name: "app" })).toBe(false);
  expect(isRepositoryAllowed(allowed, { owner: "acme", name: "ap" })).toBe(false);
  expect(isRepositoryAllowed([], { owner: "acme", name: "app" })).toBe(false);
  // A stored value in mixed case, for example from a manual database edit, still matches.
  expect(isRepositoryAllowed(["Acme/App"], { owner: "acme", name: "app" })).toBe(true);
  expect(repositoryKey({ owner: "Acme", name: "App" })).toBe("acme/app");
});
