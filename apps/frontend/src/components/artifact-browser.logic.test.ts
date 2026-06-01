import { test, expect } from "vitest";

import {
  EMPTY_ARTIFACT_FILTER_STATE,
  artifactFilterStateToParams,
  artifactFilterStateToSearchString,
  artifactSearchHasAnyFilter,
  parseArtifactFilterState,
  toggleInArray
} from "./artifact-browser.logic";

test("empty state serializes to an empty query string (clean URL)", () => {
  expect(artifactFilterStateToSearchString(EMPTY_ARTIFACT_FILTER_STATE)).toBe("");
});

test("default sort is omitted from the URL but non-default is serialized", () => {
  expect(artifactFilterStateToSearchString({ ...EMPTY_ARTIFACT_FILTER_STATE, sort: "created_desc" })).toBe("");
  const qs = artifactFilterStateToSearchString({ ...EMPTY_ARTIFACT_FILTER_STATE, sort: "name_asc" });
  expect(qs).toBe("sort=name_asc");
});

test("state → search string → state round-trips filters", () => {
  const state = {
    q: "report",
    type: ["upload", "generated"],
    status: ["ready"],
    mimeClass: ["pdf", "image"],
    sort: "size_desc" as const
  };
  const qs = artifactFilterStateToSearchString(state);
  const parsed = parseArtifactFilterState(new URLSearchParams(qs));
  expect(parsed).toEqual(state);
});

test("parse drops bogus enum values from a hand-edited URL", () => {
  const parsed = parseArtifactFilterState(
    new URLSearchParams("type=upload&type=hacker&status=bogus&mimeClass=pdf&mimeClass=zip&sort=nope")
  );
  expect(parsed.type).toEqual(["upload"]);
  expect(parsed.status).toEqual([]);
  expect(parsed.mimeClass).toEqual(["pdf"]);
  expect(parsed.sort).toBe("created_desc"); // invalid sort falls back to default
});

test("artifactFilterStateToParams omits empties and trims q", () => {
  expect(artifactFilterStateToParams(EMPTY_ARTIFACT_FILTER_STATE)).toEqual({ sort: "created_desc" });
  expect(
    artifactFilterStateToParams({
      q: "  spec  ",
      type: ["upload"],
      status: [],
      mimeClass: [],
      sort: "name_asc"
    })
  ).toEqual({ sort: "name_asc", q: "spec", type: ["upload"] });
});

test("artifactSearchHasAnyFilter detects presence of any filter key", () => {
  expect(artifactSearchHasAnyFilter(new URLSearchParams(""))).toBe(false);
  expect(artifactSearchHasAnyFilter(new URLSearchParams("sort=name_asc"))).toBe(true);
  expect(artifactSearchHasAnyFilter(new URLSearchParams("type=upload"))).toBe(true);
});

test("toggleInArray adds then removes", () => {
  expect(toggleInArray([], "a")).toEqual(["a"]);
  expect(toggleInArray(["a", "b"], "a")).toEqual(["b"]);
});
