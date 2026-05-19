import { test, expect } from "vitest";

import { SignJWT, decodeProtectedHeader } from "jose";

import { createTestConfig } from "../test-helpers/test-config.js";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
} from "./jwt.js";

const config = createTestConfig();
const secretKey = new TextEncoder().encode(config.JWT_SECRET);

test("verifyAccessToken accepts an HS256 token signed with the configured secret", async () => {
  const token = await signAccessToken(config, {
    sub: "user-1",
    tid: "tenant-1",
    role: "owner"
  });
  const payload = await verifyAccessToken(config, token);
  expect(payload.sub).toBe("user-1");
  expect(payload.tid).toBe("tenant-1");
  expect(payload.role).toBe("owner");
});

test("verifyAccessToken rejects a token signed with HS512 (alg pinning)", async () => {
  // Same secret, different alg. Without `algorithms: ["HS256"]`, jose would
  // happily accept this. The pin must reject it.
  const forged = await new SignJWT({ sub: "user-1", tid: "tenant-1", role: "owner" })
    .setProtectedHeader({ alg: "HS512" })
    .setIssuedAt()
    .setExpirationTime("15m")
    .setIssuer("cogniplane")
    .setAudience("cogniplane")
    .sign(secretKey);

  await expect(() => verifyAccessToken(config, forged)).rejects.toThrow(/alg|JWSSignatureVerificationFailed|JWSInvalid/);
});

test("verifyRefreshToken rejects a token signed with HS384 (alg pinning)", async () => {
  const forged = await new SignJWT({
    sub: "user-1",
    tid: "tenant-1",
    jti: "j1",
    fid: "f1"
  })
    .setProtectedHeader({ alg: "HS384" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .setIssuer("cogniplane")
    .setAudience("cogniplane-refresh")
    .sign(secretKey);

  await expect(() => verifyRefreshToken(config, forged)).rejects.toThrow(/alg|JWSSignatureVerificationFailed|JWSInvalid/);
});

test("verifyRefreshToken accepts an HS256 token with the required claims", async () => {
  const token = await signRefreshToken(config, {
    sub: "user-1",
    tid: "tenant-1",
    jti: "j1",
    fid: "f1"
  });
  const payload = await verifyRefreshToken(config, token);
  expect(payload.jti).toBe("j1");
  expect(payload.fid).toBe("f1");
});

test("issued access tokens carry the configured kid in the protected header", async () => {
  const token = await signAccessToken(config, {
    sub: "user-1",
    tid: "tenant-1",
    role: "owner"
  });
  const header = decodeProtectedHeader(token);
  expect(header.alg).toBe("HS256");
  expect(header.kid).toBe(config.JWT_KEY_ID);
});

test("issued refresh tokens carry the configured kid in the protected header", async () => {
  const token = await signRefreshToken(config, {
    sub: "user-1",
    tid: "tenant-1",
    jti: "j1",
    fid: "f1"
  });
  const header = decodeProtectedHeader(token);
  expect(header.alg).toBe("HS256");
  expect(header.kid).toBe(config.JWT_KEY_ID);
});
