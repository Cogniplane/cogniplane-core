import type { Pool, PoolClient } from "pg";

export type QueryResultRow = Record<string, unknown>;

export type QueryResult<Row extends QueryResultRow = QueryResultRow> = {
  rows: Row[];
  rowCount: number;
};

type QueryHandler = (text: string, values: unknown[]) => QueryResult | Promise<QueryResult>;

type Match = {
  pattern: RegExp | string;
  handler: QueryHandler;
};

/**
 * Routing-based fake `pg.Pool` for route tests. Tests register handlers keyed
 * on a substring or RegExp match of the SQL text; the first matching handler
 * wins. `BEGIN`/`COMMIT`/`ROLLBACK` and `SELECT set_config(...)` are
 * recognized automatically so `withTransaction` / `withTenantScope` work
 * without per-test setup. Unmatched queries throw with the SQL inlined so
 * the failure points at the missing handler instead of the call site.
 */
export class FakePool {
  private readonly matchers: Match[] = [];
  readonly queries: { text: string; values: unknown[] }[] = [];

  onQuery(pattern: RegExp | string, handler: QueryHandler): this {
    this.matchers.push({ pattern, handler });
    return this;
  }

  /** Cast helper so a `FakePool` can be passed where a `Pool` is expected. */
  asPool(): Pool {
    return this as unknown as Pool;
  }

  async query(text: string, values: unknown[] = []): Promise<QueryResult> {
    this.queries.push({ text, values });
    return this.dispatch(text, values);
  }

  async connect(): Promise<PoolClient> {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const pool = this;
    const client = {
      async query(text: string, values: unknown[] = []) {
        pool.queries.push({ text, values });
        return pool.dispatch(text, values);
      },
      release() {
        // no-op
      }
    };
    return client as unknown as PoolClient;
  }

  async end(): Promise<void> {
    // no-op
  }

  private dispatch(text: string, values: unknown[]): QueryResult {
    // Built-in transaction control + tenant-scope no-ops.
    const trimmed = text.trim();
    if (
      trimmed === "BEGIN" ||
      trimmed === "COMMIT" ||
      trimmed === "ROLLBACK" ||
      trimmed.startsWith("SELECT set_config(")
    ) {
      return { rows: [], rowCount: 0 };
    }

    for (const matcher of this.matchers) {
      const matches =
        typeof matcher.pattern === "string"
          ? text.includes(matcher.pattern)
          : matcher.pattern.test(text);
      if (matches) {
        const result = matcher.handler(text, values);
        if (result instanceof Promise) {
          throw new Error(
            "FakePool handlers must be synchronous; wrap async work outside dispatch."
          );
        }
        return result;
      }
    }

    throw new Error(`FakePool: no handler for query: ${text}`);
  }
}
