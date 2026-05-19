import { test, expect } from "vitest";

import { NextRequest } from "next/server";

// DEV_MODE is captured at module load. Make sure prod-mode tests see
// NEXT_PUBLIC_DEV_USER_ID unset BEFORE the dynamic import below.
delete process.env.NEXT_PUBLIC_DEV_USER_ID;

const { default: middleware } = await import("./middleware.js");

function makeRequest(pathname: string, cookies: Record<string, string> = {}): NextRequest {
  const req = new NextRequest(new URL(`http://localhost${pathname}`));
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

test("public paths bypass auth (login)", () => {
  const res = middleware(makeRequest("/login"));
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBe(null);
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
});

test("protected path with no session cookie redirects to /login", () => {
  const res = middleware(makeRequest("/admin"));
  expect(res.status).toBe(307);
  const location = res.headers.get("location");
  expect(location).toBeTruthy();
  expect(new URL(location!).pathname).toBe("/login");
});

test("protected path with session-hint cookie passes through", () => {
  const res = middleware(makeRequest("/admin", { cogniplane_session_hint: "1" }));
  expect(res.status).toBe(200);
});

test("session-hint cookie with wrong value still redirects", () => {
  const res = middleware(makeRequest("/admin", { cogniplane_session_hint: "0" }));
  expect(res.status).toBe(307);
});
