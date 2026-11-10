// A dropped idle connection must not stop the backend.
//
// `db.test.ts` emits the pool `error` event by hand, the way pg-pool does. In
// this file PostgreSQL drops the connection. The test runs
// `pg_terminate_backend` on an idle app connection, and a server restart or
// failover does the same. pg-pool removes the client and emits `error` on the
// pool. With no listener, the event throws and Vitest reports an unhandled
// error. In production, server.ts stops the process.

import { describe, expect, test } from "vitest";

import type { AppConfig } from "../config.js";
import { createDatabase, type PoolErrorLogger } from "../lib/db.js";

import { adminDatabaseUrl, runAppUserUrl, superuserPool } from "./support/database.js";

describe.skipIf(!adminDatabaseUrl())("idle pool connection error", () => {
  test("the app pool logs a terminated idle connection and serves the next query", async () => {
    const logged: Array<{ meta: object; msg: string }> = [];
    let markLogged = () => {};
    const errorLogged = new Promise<void>((resolve) => {
      markLogged = resolve;
    });
    const logger: PoolErrorLogger = {
      error(meta, msg) {
        logged.push({ meta, msg });
        markLogged();
      }
    };
    const pool = createDatabase({ DATABASE_URL: runAppUserUrl() } as AppConfig, logger);
    try {
      // One query leaves one idle client in the pool.
      const before = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      const pid = before.rows[0].pid;
      expect(pool.idleCount).toBe(1);

      const terminated = await superuserPool().query<{ ok: boolean }>(
        "SELECT pg_terminate_backend($1) AS ok",
        [pid]
      );
      expect(terminated.rows[0].ok).toBe(true);
      await errorLogged;

      expect(logged).toEqual([{
        msg: "idle database connection failed",
        meta: {
          pool: "cogniplane-backend",
          code: "57P01",
          err: "terminating connection due to administrator command"
        }
      }]);
      expect(pool.idleCount).toBe(0);

      // The pool opens a new connection for the next checkout.
      const after = await pool.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
      expect(after.rows[0].pid).not.toBe(pid);
    } finally {
      await pool.end();
    }
  });
});
