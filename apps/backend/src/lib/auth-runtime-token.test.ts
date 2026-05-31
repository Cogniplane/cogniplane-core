import { test, expect, describe, vi } from "vitest";

import type { FastifyRequest } from "fastify";

import { createSilentLogger } from "../test-helpers/silent-logger.js";
import { createTestConfig } from "../test-helpers/test-config.js";
import {
  generateRuntimeToken,
  runtimeTokenExpiry,
  verifyRuntimeToken,
  type RuntimeTokenMintClaims
} from "../services/auth/runtime-token.js";
import { tryAuthenticateRuntimeToken } from "./auth-runtime-token.js";

// All tokens are minted under this config's DATA_ENCRYPTION_SECRET (>=32 chars,
// supplied by loadTestConfig). The same secret is used by the production
// verifyRuntimeToken inside tryAuthenticateRuntimeToken, so a token minted here
// verifies there.
const config = createTestConfig();
const SECRET = config.DATA_ENCRYPTION_SECRET;

const CLAIMS: RuntimeTokenMintClaims = {
  sid: "session-1",
  tid: "tenant-A",
  uid: "user-1",
  rid: "runtime-1"
};

/** Mint a real, currently-valid runtime token (1h in the future). */
function validToken(claims: RuntimeTokenMintClaims = CLAIMS): string {
  const token = generateRuntimeToken(
    { ...claims, exp: runtimeTokenExpiry(60 * 60 * 1000) },
    SECRET
  );
  // Sanity: confirm the token verifies under the same secret the production
  // path uses, so a verification failure in a test below is meaningful.
  expect(verifyRuntimeToken(token, SECRET).kind).toBe("valid");
  return token;
}

type FakeHeaders = {
  authorization?: string;
  "x-api-key"?: string | string[];
};

type FakeRequest = FastifyRequest & {
  auth?: FastifyRequest["auth"];
};

/**
 * Build a minimal FastifyRequest stand-in. `auth` is intentionally left
 * undefined so we can assert the function only populates it on success.
 * `log` is the silent logger so we can spy on `.warn`.
 */
function fakeRequest(opts: {
  url: string;
  method?: string;
  headers?: FakeHeaders;
}): FakeRequest {
  return {
    url: opts.url,
    method: opts.method ?? "POST",
    headers: opts.headers ?? {},
    log: createSilentLogger(),
    auth: undefined
  } as unknown as FakeRequest;
}

describe("tryAuthenticateRuntimeToken — path gating", () => {
  test("non-runtime path returns false and leaves request.auth untouched even with a valid token", () => {
    const request = fakeRequest({
      url: "/messages",
      headers: { authorization: `Bearer ${validToken()}` }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });

  test("runtime path with no credentials returns false", () => {
    const request = fakeRequest({ url: "/mcp/server-1" });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });
});

describe("tryAuthenticateRuntimeToken — success populates request.auth", () => {
  test.each([
    ["/mcp/server-1"],
    ["/llm/anthropic/v1/messages"],
    ["/llm/openai/v1/responses"]
  ])("Bearer rt_ token authenticates on %s", (url) => {
    const request = fakeRequest({
      url,
      headers: { authorization: `Bearer ${validToken()}` }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    // Contract: claims map onto request.auth, never elevated.
    expect(request.auth).toEqual({
      userId: CLAIMS.uid,
      tenantId: CLAIMS.tid,
      isAdmin: false,
      role: "member"
    });
  });

  test("auth claims reflect the minted token's tid/uid, not a fixed value", () => {
    const request = fakeRequest({
      url: "/mcp/server-1",
      headers: {
        authorization: `Bearer ${validToken({
          sid: "s2",
          tid: "tenant-Z",
          uid: "user-99",
          rid: "r2"
        })}`
      }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    expect(request.auth?.tenantId).toBe("tenant-Z");
    expect(request.auth?.userId).toBe("user-99");
    expect(request.auth?.isAdmin).toBe(false);
    expect(request.auth?.role).toBe("member");
  });
});

describe("tryAuthenticateRuntimeToken — credential precedence", () => {
  test("Bearer rt_ header wins even when x-api-key and ?token= are also present", () => {
    const headerToken = validToken({ sid: "s", tid: "tenant-HEADER", uid: "u", rid: "r" });
    const otherToken = validToken({ sid: "s", tid: "tenant-OTHER", uid: "u", rid: "r" });
    const request = fakeRequest({
      url: `/llm/anthropic/v1/messages?token=${otherToken}`,
      headers: {
        authorization: `Bearer ${headerToken}`,
        "x-api-key": otherToken
      }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    // The header token's tenant must be the one that lands in auth.
    expect(request.auth?.tenantId).toBe("tenant-HEADER");
  });

  test("x-api-key rt_ is accepted for /llm/anthropic/", () => {
    const request = fakeRequest({
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": validToken() }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    expect(request.auth?.tenantId).toBe(CLAIMS.tid);
  });

  test("x-api-key as a string[] (multi-valued header) uses the first value for /llm/anthropic/", () => {
    const request = fakeRequest({
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": [validToken(), "rt_decoy"] }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    expect(request.auth?.userId).toBe(CLAIMS.uid);
  });

  test("x-api-key rt_ is IGNORED for /llm/openai/ (only Authorization/query honored there)", () => {
    const request = fakeRequest({
      url: "/llm/openai/v1/responses",
      headers: { "x-api-key": validToken() }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });

  test("x-api-key rt_ is IGNORED for /mcp/ (only Authorization/query honored there)", () => {
    const request = fakeRequest({
      url: "/mcp/server-1",
      headers: { "x-api-key": validToken() }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });

  test("?token=rt_ fallback authenticates /mcp/ when no header is present", () => {
    const request = fakeRequest({
      url: `/mcp/server-1?token=${validToken()}`
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    expect(request.auth?.tenantId).toBe(CLAIMS.tid);
  });

  test("?token=rt_ fallback authenticates /llm/openai/", () => {
    const request = fakeRequest({
      url: `/llm/openai/v1/responses?token=${validToken()}`
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(true);
    expect(request.auth?.tenantId).toBe(CLAIMS.tid);
  });
});

describe("tryAuthenticateRuntimeToken — non-rt_ values are ignored", () => {
  test("Bearer JWT (non-rt_) is ignored and falls through to ?token=", () => {
    const request = fakeRequest({
      url: "/mcp/server-1",
      headers: { authorization: "Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig" }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });

  test("x-api-key with an OpenAI-style sk- key is ignored on /llm/anthropic/", () => {
    const request = fakeRequest({
      url: "/llm/anthropic/v1/messages",
      // Non-rt_ placeholder: only the missing "rt_" prefix matters here. Kept
      // low-entropy so secret scanners don't flag this fake fixture.
      headers: { "x-api-key": "sk-not-a-real-key" }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });

  test("?token= with a non-rt_ value is ignored", () => {
    const request = fakeRequest({
      url: "/mcp/server-1?token=not-a-runtime-token"
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });
});

describe("tryAuthenticateRuntimeToken — rejected tokens", () => {
  test("expired token returns false, logs a warn, and leaves request.auth untouched", () => {
    // Mint a token whose exp is already in the past.
    const expired = generateRuntimeToken(
      { ...CLAIMS, exp: runtimeTokenExpiry(-60 * 1000) },
      SECRET
    );
    expect(verifyRuntimeToken(expired, SECRET).kind).toBe("expired");

    const request = fakeRequest({
      url: "/mcp/server-1",
      headers: { authorization: `Bearer ${expired}` }
    });
    const warnSpy = vi.spyOn(request.log, "warn");

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("tampered token (valid prefix, bad signature) returns false and does not warn-as-expired", () => {
    const token = validToken();
    // Flip a bit in the DECODED signature bytes (not a base64url char): the
    // trailing base64url char only carries 2-4 significant bits, so flipping it
    // can decode to the same byte sequence and leave the signature valid. The
    // dotIndex split mirrors verifyRuntimeToken (signature = after the last dot).
    const dot = token.lastIndexOf(".");
    const sigBytes = Buffer.from(token.slice(dot + 1), "base64url");
    sigBytes[0] ^= 0xff; // guaranteed-different signature
    const tampered = `${token.slice(0, dot + 1)}${sigBytes.toString("base64url")}`;
    expect(verifyRuntimeToken(tampered, SECRET).kind).toBe("invalid");

    const request = fakeRequest({
      url: "/mcp/server-1",
      headers: { authorization: `Bearer ${tampered}` }
    });
    const warnSpy = vi.spyOn(request.log, "warn");

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
    // Invalid path also logs a warn, but it is a distinct code path from expiry.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  test("token signed under a different secret is rejected as invalid", () => {
    const foreign = generateRuntimeToken(
      { ...CLAIMS, exp: runtimeTokenExpiry(60 * 60 * 1000) },
      "a-completely-different-secret-at-least-32-chars!!"
    );

    const request = fakeRequest({
      url: "/llm/anthropic/v1/messages",
      headers: { "x-api-key": foreign }
    });

    expect(tryAuthenticateRuntimeToken(request, config)).toBe(false);
    expect(request.auth).toBeUndefined();
  });
});
