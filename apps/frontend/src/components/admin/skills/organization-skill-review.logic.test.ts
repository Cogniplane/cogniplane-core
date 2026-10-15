import { expect, it } from "vitest";

import { diffLines } from "./organization-skill-review.logic";

const render = (oldText: string, newText: string) =>
  diffLines(oldText, newText).map(({ kind, text }) => `${{ same: " ", remove: "-", add: "+" }[kind]}${text}`);

it("keeps unchanged lines and shows a replaced line as a removal before its addition", () => {
  expect(render("a\nb\nc", "a\nB\nc")).toEqual([" a", "-b", "+B", " c"]);
});

it("shows inserted and deleted lines around the common lines", () => {
  expect(render("a\nc", "a\nb\nc")).toEqual([" a", "+b", " c"]);
  expect(render("a\nb\nc", "a\nc")).toEqual([" a", "-b", " c"]);
  expect(render("a\nb", "a\nb\nc\nd")).toEqual([" a", " b", "+c", "+d"]);
  expect(render("x\na", "a")).toEqual(["-x", " a"]);
});

it("keeps the longest common run when lines move", () => {
  // b and c stay; the moved a is removed at the top and added at the end.
  expect(render("a\nb\nc", "b\nc\na")).toEqual(["-a", " b", " c", "+a"]);
});

it("falls back to remove-all and add-all above 160,000 line pairs", () => {
  const old = Array.from({ length: 401 }, (_, i) => `line ${i}`).join("\n");
  const lines = diffLines(old, old);

  // 401 x 401 = 160,801 pairs, so even identical text is not compared.
  expect(lines).toHaveLength(802);
  const oldLines = old.split("\n");
  expect(lines).toEqual([
    ...oldLines.map((text) => ({ kind: "remove", text })),
    ...oldLines.map((text) => ({ kind: "add", text }))
  ]);
  // 400 x 400 = 160,000 is at the limit, so the lines are still compared.
  const atLimit = oldLines.slice(1);
  expect(diffLines(atLimit.join("\n"), atLimit.join("\n"))).toEqual(atLimit.map((text) => ({ kind: "same", text })));
});
