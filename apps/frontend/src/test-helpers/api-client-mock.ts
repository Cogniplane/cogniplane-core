import { vi } from "vitest";

import { parseResponse } from "../lib/validate-response";

import type { ZodType } from "@cogniplane/shared-types";

/**
 * A mock of `lib/api-client` for the tests of the API modules. A test sets the
 * wire body with `wireRequest` (or `wireRequestOptionalOn404`). The mocked
 * request functions check that body with the caller's schema, as the real
 * client does, so a test can also give a body that the schema refuses.
 *
 * Use: `vi.mock("./api-client", async () => (await import("../test-helpers/api-client-mock")).apiClientMock());`
 */
export const wireRequest = vi.fn<(path: string, init?: RequestInit) => unknown>();
export const wireRequestOptionalOn404 = vi.fn<(path: string, init?: RequestInit) => unknown>();

type Wire = typeof wireRequest;

// A call with no `init` records the path only, so a test can assert the exact arguments.
const send = (wire: Wire, path: string, init?: RequestInit) => (init === undefined ? wire(path) : wire(path, init));
const context = (path: string, init?: RequestInit) => `${init?.method ?? "GET"} ${path.split("?")[0]}`;

export function apiClientMock(extra: Record<string, unknown> = {}) {
  return {
    requestJson: async <T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T> =>
      parseResponse(schema, await send(wireRequest, path, init), context(path, init)),
    requestEmpty: async (path: string, init?: RequestInit): Promise<void> => {
      await send(wireRequest, path, init);
    },
    requestJsonOptionalOn404: async <T>(path: string, schema: ZodType<T>, init?: RequestInit): Promise<T | undefined> => {
      const body = await send(wireRequestOptionalOn404, path, init);
      return body === undefined ? undefined : parseResponse(schema, body, context(path, init));
    },
    ...extra
  };
}
