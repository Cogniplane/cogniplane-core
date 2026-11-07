import { expect, test, vi } from "vitest";

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

// Redis keys keep their persisted form, so a new release can still consume a
// state that an earlier release issued. An overlay id gets the same form.
test.each(["github", "notion", "example_overlay-2"])("Redis key for %s keeps its persisted form", async (provider) => {
  const set = vi.fn(async () => "OK" as const);
  const getdel = vi.fn(async () => "issued");
  const store = new IntegrationOAuthStateStore({ set, getdel } as never);

  await store.issue(provider, "jti-1", 600);
  await expect(store.consume(provider, "jti-1")).resolves.toBe(true);

  expect(set).toHaveBeenCalledWith(`integration_oauth_state:${provider}:jti-1`, "issued", "EX", 600);
  expect(getdel).toHaveBeenCalledWith(`integration_oauth_state:${provider}:jti-1`);
});

test.each(["", "GitHub", "1github", "git:hub", "git hub", "git;hub", "git=hub", "../x", "a".repeat(65)])(
  "OAuth state rejects the provider id %j before it touches Redis",
  async (provider) => {
    const set = vi.fn();
    const getdel = vi.fn();
    const store = new IntegrationOAuthStateStore({ set, getdel } as never);

    await expect(store.issue(provider, "jti-1", 600)).rejects.toThrow("Invalid OAuth provider id");
    await expect(store.consume(provider, "jti-1")).rejects.toThrow("Invalid OAuth provider id");
    expect(set).not.toHaveBeenCalled();
    expect(getdel).not.toHaveBeenCalled();
  }
);
