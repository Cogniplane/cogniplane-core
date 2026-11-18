import type pg from "pg";

/**
 * A pool whose first COMMIT goes through `onCommit` instead. Simulates a commit
 * whose outcome the client does not learn.
 */
export function poolWithFirstCommit(
  pool: pg.Pool,
  onCommit: (client: pg.PoolClient) => Promise<void>,
  options: { holdRelease?: () => Promise<unknown>; afterQuery?: RegExp } = {}
): pg.Pool {
  let faulted = false;
  return new Proxy(pool, {
    get(target, property) {
      if (property === "connect") {
        return async () => {
          const client = await target.connect();
          let intercepted = false;
          let eligible = !options.afterQuery;
          return new Proxy(client, {
            get(inner, key) {
              if (key === "query") {
                return (text: unknown, ...rest: unknown[]) => {
                  if (typeof text === "string" && options.afterQuery?.test(text)) eligible = true;
                  if (text === "COMMIT" && eligible && !faulted) {
                    faulted = true;
                    intercepted = true;
                    return onCommit(inner);
                  }
                  // A held transaction finishes on its own: drop the caller's ROLLBACK.
                  if (text === "ROLLBACK" && intercepted && options.holdRelease) return Promise.resolve();
                  return (inner.query as (...args: unknown[]) => unknown).call(inner, text, ...rest);
                };
              }
              if (key === "release") {
                return (error?: Error) => {
                  if (intercepted && options.holdRelease) {
                    void options.holdRelease().finally(() => inner.release());
                    return;
                  }
                  inner.release(error);
                };
              }
              const value = Reflect.get(inner, key);
              return typeof value === "function" ? value.bind(inner) : value;
            }
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
