// @vitest-environment jsdom
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, test } from "vitest";
import { queryKeys } from "../lib/query-keys";

import type { FileSourceDefinition } from "../components/file-source-picker";
import { registerFileSource, selectEnabledFileSources, useFileSources, type FileSourceFactory } from "./use-file-sources";

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
});

registerFileSource({
  integrationId: "closure-fixture",
  useEntry: ({ selectedSessionId }) => ({
    id: "closure-fixture",
    label: "Fixture",
    description: "",
    connection: { kind: "connected", label: "Connected" },
    renderBody: () => selectedSessionId
  })
});

afterEach(cleanup);

test("useFileSources refreshes factory closures when the selected session changes", () => {
  const client = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  client.setQueryData(queryKeys.settings.integrationsAvailability(), [{ id: "closure-fixture" }]);
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender, unmount } = renderHook(({ session }) => useFileSources({
    selectedSessionId: session,
    onError: () => {},
    onRefreshArtifacts: async () => {},
    onImportedArtifact: () => {}
  }), { wrapper, initialProps: { session: "first-session" } });

  expect(result.current.sources[0]?.renderBody({ selectedSessionId: null })).toBe("first-session");
  rerender({ session: "second-session" });
  expect(result.current.sources[0]?.renderBody({ selectedSessionId: null })).toBe("second-session");
  unmount();
  client.clear();
});
