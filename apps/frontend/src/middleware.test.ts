import { describe, it, test, expect } from "vitest";

import { NextRequest } from "next/server";

// DEV_MODE is captured at module load. Make sure prod-mode tests see
// NEXT_PUBLIC_DEV_USER_ID unset BEFORE the dynamic import below.
delete process.env.NEXT_PUBLIC_DEV_USER_ID;

const { default: middleware, config } = await import("./middleware.js");

test("the sandbox gets a framing policy without restricting app scripts", () => {
  expect(config.matcher[0]).not.toContain("mcp-app-sandbox");
  process.env.MCP_APP_PARENT_ORIGIN = "https://chat.example.test";
  try {
    const res = middleware(makeRequest("/mcp-app-sandbox.html"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toBe("frame-ancestors https://chat.example.test; object-src 'none'");
    expect(res.headers.get("content-security-policy")).not.toContain("script-src");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    process.env.MCP_APP_PARENT_ORIGIN = "bad host";
    expect(middleware(makeRequest("/mcp-app-sandbox.html")).headers.get("content-security-policy"))
      .toBe("frame-ancestors 'none'; object-src 'none'");
  } finally {
    delete process.env.MCP_APP_PARENT_ORIGIN;
  }
});

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL(`http://localhost${pathname}`));
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

function expectSecurityHeaders(res: Response) {
  const csp = res.headers.get("content-security-policy");
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toMatch(/'nonce-[A-Za-z0-9]+'/);
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
}

test("public paths bypass auth (login)", () => {
  const res = middleware(makeRequest("/login"));
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBe(null);
  expectSecurityHeaders(res);
  const nonce = res.headers.get("x-middleware-request-x-nonce");
  expect(nonce).toMatch(/^[A-Za-z0-9]+$/);
  expect(res.headers.get("x-middleware-request-content-security-policy")).toContain(
    `'nonce-${nonce}'`
  );
});

test("public paths bypass auth (auth/callback)", () => {
  const res = middleware(makeRequest("/auth/callback?code=abc&state=xyz"));
  expect(res.status).toBe(200);
});

test("/api paths bypass middleware (handled by route handlers)", () => {
  const res = middleware(makeRequest("/api/health"));
  expect(res.status).toBe(200);
});

test("static files (with extension) bypass", () => {
  const res = middleware(makeRequest("/favicon.ico"));
  expect(res.status).toBe(200);
  expectSecurityHeaders(res);
});

test("protected path with no session cookie redirects to /login", () => {
  const res = middleware(makeRequest("/admin"));
  expect(res.status).toBe(307);
  const location = res.headers.get("location");
  expect(location).toBeTruthy();
  expect(new URL(location!).pathname).toBe("/login");
  expectSecurityHeaders(res);
});

test("protected path with session-hint cookie passes through", () => {
  const res = middleware(makeRequest("/admin", { cogniplane_session_hint: "1" }));
  expect(res.status).toBe(200);
  expectSecurityHeaders(res);
});

test("session-hint cookie with wrong value still redirects", () => {
  const res = middleware(makeRequest("/admin", { cogniplane_session_hint: "0" }));
  expect(res.status).toBe(307);
});

// The hint cookie is JavaScript-writable, so anyone can forge it. It may skip
// the /login redirect for a page shell. It proves nothing else, and AuthGuard
// and the backend decide who sees data.
describe("a forged session hint cookie", () => {
  const FORGED_HEADERS = {
    "x-user-role": "admin",
    "x-role": "owner",
    "x-tenant-id": "other-tenant",
    "x-user-id": "someone-else",
    "x-dev-user-id": "dev-user",
    authorization: "Bearer forged"
  };

  function makeForgedRequest(pathname: string, cookies: Record<string, string>, headers: Record<string, string> = {}) {
    const req = new NextRequest(new URL(`http://localhost${pathname}`), { headers });
    for (const [name, value] of Object.entries(cookies)) req.cookies.set(name, value);
    return req;
  }

  /** The request headers that the middleware passes on, by name. */
  const forwardedHeaderNames = (res: Response) =>
    (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean).sort();

  it("only skips the redirect: the response is the same page pass-through with no identity added", () => {
    const hinted = middleware(makeForgedRequest("/admin", { cogniplane_session_hint: "1" }));
    expect(hinted.status).toBe(200);
    expect(hinted.headers.get("location")).toBeNull();
    // Nothing is set for the browser, and no identity or role is passed to the page.
    expect(hinted.headers.get("set-cookie")).toBeNull();
    const names = [...hinted.headers.keys()].map((name) => name.replace("x-middleware-request-", ""));
    expect(names.filter((name) => /(^|-)(auth|user|role|tenant|session)/.test(name))).toEqual([]);
    expect(forwardedHeaderNames(hinted)).toEqual(["content-security-policy", "cookie", "x-nonce"]);
  });

  it.each([
    ["an admin path", "/admin"],
    ["an admin section", "/admin/users"],
    ["a session page", "/sessions/s-1"],
    ["the home page", "/"]
  ])("gets the same pass-through for %s: no path-based role or tenant check", (_name, pathname) => {
    const res = middleware(makeForgedRequest(pathname, { cogniplane_session_hint: "1" }));
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    expectSecurityHeaders(res);
  });

  it("is not changed by forged role, tenant, or bearer headers", () => {
    const plain = middleware(makeForgedRequest("/admin", { cogniplane_session_hint: "1" }));
    const forged = middleware(makeForgedRequest("/admin", { cogniplane_session_hint: "1" }, FORGED_HEADERS));
    expect(forged.status).toBe(plain.status);
    expect(forged.headers.get("location")).toBeNull();
    // The middleware forwards what the client sent, and adds only the CSP and the nonce.
    expect(forwardedHeaderNames(forged).filter((name) => !(name in FORGED_HEADERS))).toEqual(["content-security-policy", "cookie", "x-nonce"]);
    expect(forged.headers.get("set-cookie")).toBeNull();
  });

  it("is still redirected to /login when the headers claim an admin and there is no hint cookie", () => {
    const res = middleware(makeForgedRequest("/admin", {}, FORGED_HEADERS));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("is still redirected to /login when other cookies claim a session or a role", () => {
    const res = middleware(makeForgedRequest("/admin", {
      cogniplane_refresh: "forged", cogniplane_role: "admin", role: "owner", session: "1", "cogniplane_session_hint_": "1"
    }));
    expect(res.status).toBe(307);
  });

  it.each(["true", "yes", "2", "", " 1", "1 ", "01", "admin", "1;role=admin"])("does not skip the redirect for the value %j", (value) => {
    const res = middleware(makeForgedRequest("/admin", { cogniplane_session_hint: value }));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
  });

  it("does not change what a public or static path serves", () => {
    for (const pathname of ["/login", "/auth/callback", "/favicon.ico", "/api/health"]) {
      const without = middleware(makeForgedRequest(pathname, {}));
      const forged = middleware(makeForgedRequest(pathname, { cogniplane_session_hint: "1" }));
      expect(forged.status).toBe(without.status);
      expect(forged.headers.get("location")).toBe(without.headers.get("location"));
    }
  });
});
