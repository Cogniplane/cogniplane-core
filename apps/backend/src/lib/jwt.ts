import { SignJWT, jwtVerify, errors as joseErrors } from "jose";

import type { AppConfig } from "../config.js";

export type AccessTokenPayload = {
  sub: string;
  tid: string;
  role: string;
  email?: string;
};

export type RefreshTokenPayload = {
  sub: string;
  tid: string;
  jti: string;
  /** Family/lineage id used to detect refresh-token reuse. */
  fid: string;
};

function getSecretKey(config: AppConfig): Uint8Array {
  return new TextEncoder().encode(config.JWT_SECRET);
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
    .sign(getSecretKey(config));
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
    .sign(getSecretKey(config));
}

function assertAccessTokenPayload(p: unknown): AccessTokenPayload {
  if (typeof p !== "object" || p === null || !("sub" in p) || !("tid" in p) || !("role" in p)) {
    throw new Error("Invalid access token payload: missing required fields");
  }
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
  return p as RefreshTokenPayload;
}

export async function verifyAccessToken(
  config: AppConfig,
  token: string
): Promise<AccessTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(config), {
    issuer: "cogniplane",
    audience: "cogniplane",
    algorithms: ["HS256"]
  });
  return assertAccessTokenPayload(payload);
}

export async function verifyRefreshToken(
  config: AppConfig,
  token: string
): Promise<RefreshTokenPayload> {
  const { payload } = await jwtVerify(token, getSecretKey(config), {
    issuer: "cogniplane",
    audience: "cogniplane-refresh",
    algorithms: ["HS256"]
  });
  return assertRefreshTokenPayload(payload);
}

export function isTokenExpiredError(err: unknown): boolean {
  return err instanceof joseErrors.JWTExpired;
}
