import type { AfterSecurityChange, ChangedAccounts } from "../services/auth/security-change.js";

/** For tests that do not check what a security change stops. */
export const IGNORE_SECURITY_CHANGE: AfterSecurityChange = async () => {};

/** Records each after-commit call of a security change. */
export function recordSecurityChanges(): { after: AfterSecurityChange; calls: ChangedAccounts[] } {
  const calls: ChangedAccounts[] = [];
  return {
    calls,
    after: async (changed) => {
      calls.push({
        tenantId: changed.tenantId,
        userIds: [...changed.userIds].sort(),
        releasedSandboxes: [...changed.releasedSandboxes].sort((a, b) => a.sandboxId.localeCompare(b.sandboxId))
      });
    }
  };
}

/**
 * Every place in the backend source that changes a security version, by its
 * method (`Class.method`) or route (`VERB /path`). security-change-sites.test.ts
 * checks this list against the source, and
 * security-change-sites.integration.test.ts runs each site against Postgres.
 */
export const SECURITY_CHANGE_SITES = [
  "LocalAccountService.redeemLink",
  "LocalAccountService.changeOwnPassword",
  "LocalAccountService.revokeSessions",
  "LocalAccountService.recoverOwner",
  "LocalAccountService.resetMemberPassword",
  "LocalAccountService.disableMember",
  "LocalAccountService.enableMember",
  "LocalMfaService.confirmTotpEnrollment",
  "LocalMfaService.removeOwnTotp",
  "LocalMfaService.resetMemberFactors",
  "LocalMfaService.setPolicy",
  "LocalPasskeyService.register",
  "LocalPasskeyService.remove",
  "PUT /tenant/members/:userId/role",
  "DELETE /tenant/members/:userId"
] as const;

export type SecurityChangeSite = (typeof SECURITY_CHANGE_SITES)[number];
