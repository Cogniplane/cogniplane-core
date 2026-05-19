// Regression test for the two-phase bootstrap split.
//
// Before the split, `registerBuiltinIntegrations` had a first-wins guard:
// once any caller initialized the registry without probes/OAuth handlers,
// later `buildAppDependencies()` calls couldn't attach them and integrations
// would expose tools without verifying user OAuth connections, while OAuth
// callback routes silently no-op'd.
//
// The fix splits boot into descriptor registration (idempotent, static)
// and runtime wiring attach (re-runnable). This test pins the new contract.
import { test, expect } from "vitest";

import {
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor,
  listIntegrationOAuthCallbackPaths
} from "./integration-registry.js";
import {
  __resetBuiltinIntegrationsRegistrationForTesting,
  attachBuiltinIntegrationRuntime,
  registerBuiltinIntegrations
} from "./register-builtin-integrations.js";

function fakeProbe(label: string) {
  return {
    label,
    async hasConnection(): Promise<boolean> {
      return true;
    }
  };
}

function fakeOAuthHandler(label: string) {
  return {
    label,
    async completeAuthorization(): Promise<string> {
      return `/done?label=${label}`;
    }
  };
}

test("attachBuiltinIntegrationRuntime overwrites wiring after a no-arg registration", () => {
  __resetIntegrationRegistryForTesting();
  __resetBuiltinIntegrationsRegistrationForTesting();

  // First caller (think: a test file that calls `registerBuiltinIntegrations()`
  // at module load time). No probes, no OAuth handlers — descriptors land
  // with stub no-op wiring.
  registerBuiltinIntegrations();

  const githubBefore = getIntegrationDescriptor("github");
  expect(githubBefore).toBeTruthy();
  expect(githubBefore.connectionProbe).toBe(undefined);
  expect(githubBefore.oauthRoutes).toBeTruthy();

  // Second caller (think: `buildAppDependencies()` running after the test
  // module loaded). Real wiring must replace the stub.
  const probe = fakeProbe("github-probe");
  const oauth = fakeOAuthHandler("github-oauth");
  attachBuiltinIntegrationRuntime({
    probes: { github: probe },
    oauth: { github: oauth }
  });

  const githubAfter = getIntegrationDescriptor("github");
  expect(githubAfter).toBeTruthy();
  expect(githubAfter.connectionProbe).toBe(probe);

  // The OAuth route's `register` callback now closes over the live handler.
  // We can't easily assert that without a Fastify app, but the callback
  // paths should still be exposed for the public-path allowlist.
  const callbackPaths = listIntegrationOAuthCallbackPaths();
  expect(callbackPaths.includes("/auth/github/user/callback")).toBeTruthy();
  expect(callbackPaths.includes("/integrations/notion/callback")).toBeTruthy();
});

test("attachBuiltinIntegrationRuntime is idempotent and replaces stale wiring on re-attach", () => {
  __resetIntegrationRegistryForTesting();
  __resetBuiltinIntegrationsRegistrationForTesting();

  registerBuiltinIntegrations();

  const firstAppProbe = fakeProbe("first-app-notion");
  attachBuiltinIntegrationRuntime({
    probes: { notion: firstAppProbe },
    oauth: {}
  });
  expect(getIntegrationDescriptor("notion")?.connectionProbe).toBe(firstAppProbe);

  // A second `buildAppDependencies()` (e.g. another Fastify instance built
  // in the same process) must replace the first app's captured probe so
  // the second app doesn't keep poking the first app's connection service.
  const secondAppProbe = fakeProbe("second-app-notion");
  attachBuiltinIntegrationRuntime({
    probes: { notion: secondAppProbe },
    oauth: {}
  });
  expect(getIntegrationDescriptor("notion")?.connectionProbe).toBe(secondAppProbe);

  // Integrations the caller didn't pass a probe for get cleared. That's the
  // safe default: a stale probe pointing at a torn-down app would be worse
  // than no probe at all (and `IntegrationRegistryService.resolveSessionToolIds`
  // treats "no probe" as "skip the integration's tools" only when the
  // service-level override map is also empty, so the test below uses the
  // override-aware path indirectly via the descriptor).
  expect(getIntegrationDescriptor("github")?.connectionProbe).toBe(undefined);
});

test("registerBuiltinIntegrations is idempotent across repeated calls", () => {
  __resetIntegrationRegistryForTesting();
  __resetBuiltinIntegrationsRegistrationForTesting();

  registerBuiltinIntegrations();
  // A second call must not throw "Integration already registered".
  registerBuiltinIntegrations();

  expect(getIntegrationDescriptor("github")).toBeTruthy();
  expect(getIntegrationDescriptor("notion")).toBeTruthy();
  // Microsoft 365 ships from the SharePoint private overlay package and is
  // not registered by `registerBuiltinIntegrations`.
  expect(getIntegrationDescriptor("microsoft")).toBe(null);
});
