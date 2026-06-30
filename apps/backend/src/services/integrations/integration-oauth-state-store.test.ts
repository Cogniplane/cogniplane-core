import { expect, test } from "vitest";

import { IntegrationOAuthStateStore } from "./integration-oauth-state-store.js";

test("OAuth state can be consumed exactly once", async () => {
  const store = new IntegrationOAuthStateStore();
  await store.issue("github", "j1", 600);

  await expect(store.consume("github", "j1")).resolves.toBe(true);
  await expect(store.consume("github", "j1")).resolves.toBe(false);
});

test("OAuth state is provider-scoped", async () => {
  const store = new IntegrationOAuthStateStore();
  await store.issue("github", "shared", 600);

  await expect(store.consume("notion", "shared")).resolves.toBe(false);
  await expect(store.consume("github", "shared")).resolves.toBe(true);
});

test("expired local OAuth state is rejected and removed", async () => {
  const store = new IntegrationOAuthStateStore();
  await store.issue("notion", "expired", 0);
  await expect(store.consume("notion", "expired")).resolves.toBe(false);
});
