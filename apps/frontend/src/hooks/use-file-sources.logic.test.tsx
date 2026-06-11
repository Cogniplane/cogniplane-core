import { describe, expect, test } from "vitest";

import type { FileSourceDefinition } from "../components/file-source-picker";
import { selectEnabledFileSources, type FileSourceFactory } from "./use-file-sources";

function makeEntry(
  integrationId: string,
  overrides: Partial<FileSourceDefinition> = {}
): { factory: FileSourceFactory; entry: FileSourceDefinition } {
  return {
    factory: {
      integrationId,
      useEntry: () => {
        throw new Error("not called in logic tests");
      }
    },
    entry: {
      id: integrationId,
      label: integrationId,
      description: "",
      connection: { kind: "connected", label: "Connected" },
      renderBody: () => null,
      ...overrides
    }
  };
}

describe("selectEnabledFileSources", () => {
  test("keeps only entries whose integration is enabled", () => {
    const sharepoint = makeEntry("sharepoint");
    const notion = makeEntry("notion");

    const sources = selectEnabledFileSources([sharepoint, notion], ["notion"]);

    expect(sources).toEqual([notion.entry]);
  });

  test("empty availability hides every source", () => {
    expect(selectEnabledFileSources([makeEntry("sharepoint")], [])).toEqual([]);
  });

  test("returns the exact entry objects passed in this render (no caching layer)", () => {
    // useFileSources used to memoize the result on an id:connection-kind key,
    // so re-renders kept serving entry objects whose renderBody closures
    // captured stale search state and a stale selected session. The selection
    // must hand back the fresh objects from the current render, every render.
    const firstRender = makeEntry("sharepoint");
    const secondRender = makeEntry("sharepoint", {
      renderBody: () => "fresh closure"
    });

    const first = selectEnabledFileSources([firstRender], ["sharepoint"]);
    const second = selectEnabledFileSources([secondRender], ["sharepoint"]);

    expect(first[0]).toBe(firstRender.entry);
    expect(second[0]).toBe(secondRender.entry);
    expect(second[0]?.renderBody({ selectedSessionId: null })).toBe("fresh closure");
  });
});
