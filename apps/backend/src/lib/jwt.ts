import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

import type { AppConfig } from "../config.js";

/**
 * How the user proved who they are at sign-in: `workos` for a WorkOS login.
 * Local login adds `pwd`, `otp`, `rec`, and `pkey` (docs/architecture/auth.md).
 */
export type AuthMethod = "workos" | "pwd" | "otp" | "rec" | "pkey";

/**
 * Sign-in facts that every token of one session carries. Refresh copies them
 * from the old token and never advances `auth_time`, so a refreshed session
 * cannot look like a fresh sign-in. Tokens issued before these claims existed
 * have neither.
 */
export type SessionAuthClaims = {
  amr?: AuthMethod[];
  /** Sign-in time, epoch seconds. */
  auth_time?: number;
  /**
   * Local accounts: the account's security_version at sign-in. A session
   * stays valid only while it equals the stored value.
   */
  sv?: number;
};

export type AccessTokenPayload = SessionAuthClaims & {
  sub: string;
  tid: string;
  role: string;
  email?: string;
  /** Refresh family of the session that issued this token. */
  fid?: string;
};

export type RefreshTokenPayload = SessionAuthClaims & {
  sub: string;
  tid: string;
  jti: string;
  /** Family/lineage id used to detect refresh-token reuse. */
  fid: string;
};

const AUTH_METHODS: ReadonlySet<string> = new Set<AuthMethod>(["workos", "pwd", "otp", "rec", "pkey"]);

// A signed token can only hold what this backend wrote, but a token from an
// older or newer version could still hold a shape this one does not know.
// Reject it rather than read a wrong method list as a weaker or stronger proof.
function assertSessionAuthClaims(p: Record<string, unknown>): void {
  if (p.amr !== undefined) {
    if (!Array.isArray(p.amr) || !p.amr.every((method) => typeof method === "string" && AUTH_METHODS.has(method))) {
      throw new Error("Invalid token payload: amr");
    }
  }
  if (p.auth_time !== undefined && (typeof p.auth_time !== "number" || !Number.isInteger(p.auth_time))) {
    throw new Error("Invalid token payload: auth_time");
  }
  if (p.sv !== undefined && (typeof p.sv !== "number" || !Number.isInteger(p.sv) || p.sv < 0)) {
    throw new Error("Invalid token payload: sv");
  }
  if (p.fid !== undefined && (typeof p.fid !== "string" || p.fid.length === 0)) {
    throw new Error("Invalid token payload: fid");
  }
}

type JwtKeyConfig = Pick<
  AppConfig,
  "JWT_SECRET" | "JWT_KEY_ID" | "JWT_VERIFICATION_KEYS"
>;

export function getJwtSigningKey(config: JwtKeyConfig): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
}

export function resolveJwtVerificationKey(
  config: JwtKeyConfig,
  kid: unknown,
  options: { allowMissingKid?: boolean } = {}
): Uint8Array {
  if (kid === undefined && options.allowMissingKid) {
    return getJwtSigningKey(config);
  }
  if (typeof kid !== "string" || !kid) {
    throw new Error("JWT protected header is missing kid.");
  }
  if (kid === config.JWT_KEY_ID) {
    return getJwtSigningKey(config);
  }
  const previousSecret = config.JWT_VERIFICATION_KEYS[kid];
  if (!previousSecret) {
    throw new Error(`Unknown JWT kid: ${kid}`);
  }
  return new TextEncoder().encode(previousSecret);
}

const ACCESS_TOKEN_TTL = "15m";
const REFRESH_TOKEN_TTL = "7d";

export async function signAccessToken(
  config: AppConfig,
  payload: AccessTokenPayload
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", kid: config.JWT_KEY_ID })
    .setIssuedAt()
    .setExpirationTime(ACCESS_TOKEN_TTL)
    .setIssuer("cogniplane")
    .setAudience("cogniplane")
    .sign(getJwtSigningKey(config));
}

export async function signRefreshToken(
  config: AppConfig,
  payload: RefreshTokenPayload
): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256", kid: config.JWT_KEY_ID })
    .setIssuedAt()
    .setExpirationTime(REFRESH_TOKEN_TTL)
    .setIssuer("cogniplane")
    .setAudience("cogniplane-refresh")
    .sign(getJwtSigningKey(config));
}

function assertAccessTokenPayload(p: unknown): AccessTokenPayload {
  if (typeof p !== "object" || p === null || !("sub" in p) || !("tid" in p) || !("role" in p)) {
    throw new Error("Invalid access token payload: missing required fields");
  }
  assertSessionAuthClaims(p as Record<string, unknown>);
  return p as AccessTokenPayload;
}

function assertRefreshTokenPayload(p: unknown): RefreshTokenPayload {
  if (
    typeof p !== "object" ||
    p === null ||
    !("sub" in p) ||
    !("tid" in p) ||
    !("jti" in p) ||
    !("fid" in p)
  ) {
    throw new Error("Invalid refresh token payload: missing required fields");
  }
  assertSessionAuthClaims(p as Record<string, unknown>);
  return p as RefreshTokenPayload;
}

export async function verifyAccessToken(
  config: AppConfig,
  token: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(
    token,
    (protectedHeader) => resolveJwtVerificationKey(config, protectedHeader.kid),
    {
      issuer: "cogniplane",
      audience: "cogniplane",
      algorithms: ["HS256"]
    }
  );
  return assertAccessTokenPayload(payload);
}

export async function verifyRefreshToken(
  config: AppConfig,
  token: string
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(
    token,
    (protectedHeader) => resolveJwtVerificationKey(config, protectedHeader.kid),
    {
      issuer: "cogniplane",
      audience: "cogniplane-refresh",
      algorithms: ["HS256"]
    }
  );
  return assertRefreshTokenPayload(payload);
}

export function isTokenExpiredError(err: unknown): boolean {
  return err instanceof joseErrors.JWTExpired;
}
