import { type AppConfig, isLoginTypeEnabled } from "../config.js";
import type { TenantAuthState } from "../services/tenant-member-store.js";

export type AuthAdmissionError = "not_a_member" | "login_type_not_allowed" | "session_revoked";

export type AuthAdmission =
  | { ok: true; state: TenantAuthState }
  | { ok: false; error: AuthAdmissionError };

/**
 * Decides whether a token for this membership may act. Shared by the request
 * middleware and `/auth/refresh`, so a session that one refuses the other
 * cannot renew. See docs/architecture/auth.md:
 *
 * - The tenant's login type must be enabled in this installation.
 * - The user's login path must be the tenant's login type. The type is fixed
 *   at tenant creation, so this fails only after a data error; it stops a
 *   token from one login path acting in a tenant of the other.
 * - A local account must be active, and the token must carry the account's
 *   current security version. Every security change (password change, reset,
 *   disable, sign out everywhere) increments it, which ends older sessions.
 *   A local token without `sv` is refused.
 * - A session that started at or before the tenant's latest removal of the
 *   user is refused, for both login types (services/tenant-member-removal.ts).
 *   The membership can exist again only through a later change, and the
 *   sessions from before the removal must not come back with it. A token
 *   without `auth_time` is refused when such a removal exists.
 */
export function checkAuthAdmission(
  config: Pick<AppConfig, "AUTH_LOGIN_TYPES">,
  state: TenantAuthState | null,
  token: { sv?: number; authTime?: number }
): AuthAdmission {
  if (!state) return { ok: false, error: "not_a_member" };
  if (!isLoginTypeEnabled(config, state.loginType) || state.authSource !== state.loginType) {
    return { ok: false, error: "login_type_not_allowed" };
  }
  if (state.removedAt !== undefined && (token.authTime === undefined || token.authTime <= state.removedAt)) {
    return { ok: false, error: "session_revoked" };
  }
  if (state.authSource === "local") {
    if (state.localStatus !== "active" || token.sv === undefined || token.sv !== state.securityVersion) {
      return { ok: false, error: "session_revoked" };
    }
  }
  return { ok: true, state };
}
