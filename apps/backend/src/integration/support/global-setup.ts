// Vitest globalSetup for the integration project.
//
// This guard is load-bearing, not defensive. `describe.skipIf` in the test
// files skips tests AFTER discovery; it does not stop globalSetup from
// running. Without the early return here, `pnpm test:all` on a machine with no
// Postgres would try to CREATE DATABASE and fail the whole workspace run.

import {
  adminDatabaseUrl,
  createRunDatabase,
  dropOrphanedRunDatabases,
  dropRunDatabase
} from "./database.js";

export default async function setup(): Promise<() => Promise<void>> {
  if (!adminDatabaseUrl()) {
    // No database configured. Tests skip themselves; nothing to tear down.
    return async () => {};
  }

  // A crashed or cancelled previous run bypasses teardown entirely, so sweep
  // its leftovers first. CI never needs this (the service container is
  // discarded), but a local server would otherwise accumulate them.
  await dropOrphanedRunDatabases();

  const created = await createRunDatabase();
  if (!created) return async () => {};

  // globalSetup runs in its own context, so the workers cannot read a variable
  // set here. An env var is the supported handoff.
  process.env.INTEGRATION_RUN_DATABASE = created.database;
  process.env.INTEGRATION_RUN_ROLE = created.role;

  return async () => {
    await dropRunDatabase(created.database, created.role);
  };
}
