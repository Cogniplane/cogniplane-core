// UX-only redirect to /login, NOT an authentication boundary.
//
// The real auth checks are:
//   1. Backend (Fastify) validates the WorkOS JWT on every API call.
//   2. `auth-guard.tsx` calls `/auth/me` and redirects unauthenticated
//      clients before rendering protected content.
//
// This middleware exists so a returning user with a live session doesn't
// see a /login flash on initial paint while AuthProvider boots. The
// `cogniplane_session_hint` cookie it inspects is set in client JavaScript
// (auth-context.tsx) and is therefore trivially spoofable — any page can
// `document.cookie = "cogniplane_session_hint=1"` and bypass the redirect.
// That is fine: bypassing this redirect drops the caller into AuthGuard,
// which calls /auth/me with the actual access token (held in memory, not
// in this cookie) and redirects back to /login if the session is invalid.
//
// Do NOT add authorization checks here. Any logic that needs to be trusted
// must be on the backend (which sees the httpOnly refresh cookie + JWT) or
// inside AuthGuard (which has the in-memory access token).
import { NextResponse, type NextRequest } from "next/server";

import {
  applyFrontendSecurityHeaders,
  buildFrontendContentSecurityPolicy
} from "./lib/frontend-security-headers";

const PUBLIC_PATHS = ["/login", "/auth/callback"];
const SESSION_HINT_COOKIE = "cogniplane_session_hint";
const DEV_MODE = Boolean(process.env.NEXT_PUBLIC_DEV_USER_ID);
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";
const IS_DEVELOPMENT = process.env.NODE_ENV !== "production";

function createSecurityContext(request: NextRequest) {
  const nonce = crypto.randomUUID().replaceAll("-", "");
  const csp = buildFrontendContentSecurityPolicy({
    nonce,
    apiUrl: API_URL,
    development: IS_DEVELOPMENT
  });
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("content-security-policy", csp);
  requestHeaders.set("x-nonce", nonce);

  return { csp, requestHeaders };
}

function secureResponse(response: NextResponse, csp: string): NextResponse {
  applyFrontendSecurityHeaders(response.headers, csp);
  return response;
}

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const { csp, requestHeaders } = createSecurityContext(request);
  const next = () =>
    secureResponse(
      NextResponse.next({
        request: { headers: requestHeaders }
      }),
      csp
    );

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return next();
  }

  if (pathname.startsWith("/_next") || pathname.startsWith("/api") || pathname.includes(".")) {
    return next();
  }

  if (DEV_MODE) {
    return next();
  }

  // UX hint only — JS-writable, not trusted. AuthGuard does the real check.
  if (request.cookies.get(SESSION_HINT_COOKIE)?.value === "1") {
    return next();
  }

  const loginUrl = new URL("/login", request.url);
  return secureResponse(NextResponse.redirect(loginUrl), csp);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
