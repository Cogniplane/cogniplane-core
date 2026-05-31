/**
 * Test-side helper for stubbing the process-global `fetch`.
 *
 * Many service/route tests need to intercept outbound HTTP, capture the URL +
 * init each call received, and restore the original `fetch` afterwards. This
 * helper owns that save/restore dance plus the repeated URL-normalization
 * idiom (`string | URL | Request` → `string`) so individual tests don't
 * re-implement it.
 *
 * `fetch` is a process-global, so this is intentionally a test-only seam — no
 * production code receives an injectable `fetchImpl`.
 */

/**
 * The polymorphic first argument of the global `fetch`. Derived from `fetch`
 * itself (rather than the DOM `RequestInfo` lib type) so it resolves in the
 * backend's DOM-less TypeScript lib config.
 */
type FetchInput = Parameters<typeof globalThis.fetch>[0];

/** Normalize the polymorphic first argument of `fetch` to a plain URL string. */
export function normalizeFetchUrl(input: FetchInput): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export type FakeFetchCall = { url: string; init: RequestInit };

/**
 * Handler the test supplies to produce a `Response` for each intercepted call.
 * Receives the normalized URL string plus the original `(input, init)` so
 * tests can still read the request body/headers.
 */
export type FakeFetchHandler = (
  url: string,
  init: RequestInit | undefined,
  input: FetchInput
) => Response | Promise<Response>;

export type FakeFetch = {
  /** The installed stub (also assigned to `globalThis.fetch`). */
  readonly fetchImpl: typeof globalThis.fetch;
  /** Every intercepted call, in order. */
  readonly calls: FakeFetchCall[];
  /** Restore the previously-installed `globalThis.fetch`. */
  restore(): void;
};

/**
 * Install a stub `globalThis.fetch` driven by `handler`. Captures each call's
 * normalized URL + init into `.calls`. Call `.restore()` (typically in a
 * `finally`) to put the original `fetch` back.
 */
export function createFakeFetch(handler: FakeFetchHandler): FakeFetch {
  const calls: FakeFetchCall[] = [];
  const originalFetch = globalThis.fetch;

  const fetchImpl = (async (input: FetchInput, init?: RequestInit) => {
    const url = normalizeFetchUrl(input);
    calls.push({ url, init: init ?? {} });
    return handler(url, init, input);
  }) as typeof globalThis.fetch;

  globalThis.fetch = fetchImpl;

  return {
    fetchImpl,
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    }
  };
}

/**
 * Run `fn` with a stubbed `globalThis.fetch`, restoring the original even if
 * `fn` throws. `fn` receives the {@link FakeFetch} so it can assert on
 * `.calls`. Returns whatever `fn` returns.
 */
export async function withStubbedFetch<T>(
  handler: FakeFetchHandler,
  fn: (fake: FakeFetch) => Promise<T> | T
): Promise<T> {
  const fake = createFakeFetch(handler);
  try {
    return await fn(fake);
  } finally {
    fake.restore();
  }
}
