// Per-worker setup file. Closes the pools the worker itself created.
//
// globalSetup cannot do this: it runs in a separate context, so its pools are
// not the ones the tests imported. A teardown there would close the wrong
// pools and leave the real ones open, which hangs Vitest on exit.

import { afterAll } from "vitest";

import { closePools } from "./database.js";

afterAll(async () => {
  await closePools();
});
