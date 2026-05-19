import type { WorkOS } from "@workos-inc/node";
import { vi, type Mock } from "vitest";

export type FakeWorkOSHandlers = {
  getAuthorizationUrl: Mock;
  authenticateWithCode: Mock;
  listOrganizationMemberships: Mock;
  getOrganization: Mock;
};

/**
 * Stub for the four WorkOS SDK methods the auth route calls. Returns the
 * mock surface separately so tests can `.mockResolvedValueOnce` per call
 * without digging through the cast `WorkOS` type.
 */
export function createFakeWorkOS(): { workos: WorkOS; mocks: FakeWorkOSHandlers } {
  const mocks: FakeWorkOSHandlers = {
    getAuthorizationUrl: vi.fn(),
    authenticateWithCode: vi.fn(),
    listOrganizationMemberships: vi.fn(),
    getOrganization: vi.fn()
  };

  const workos = {
    userManagement: {
      getAuthorizationUrl: mocks.getAuthorizationUrl,
      authenticateWithCode: mocks.authenticateWithCode,
      listOrganizationMemberships: mocks.listOrganizationMemberships
    },
    organizations: {
      getOrganization: mocks.getOrganization
    }
  } as unknown as WorkOS;

  return { workos, mocks };
}
