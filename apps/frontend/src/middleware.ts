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

const PUBLIC_PATHS = ["/login", "/auth/callback"];
const SESSION_HINT_COOKIE = "cogniplane_session_hint";
const DEV_MODE = Boolean(process.env.NEXT_PUBLIC_DEV_USER_ID);

export default function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/_next") || pathname.startsWith("/api") || pathname.includes(".")) {
    return NextResponse.next();
  }

  if (DEV_MODE) {
    return NextResponse.next();
  }

  // UX hint only — JS-writable, not trusted. AuthGuard does the real check.
  if (request.cookies.get(SESSION_HINT_COOKIE)?.value === "1") {
    return NextResponse.next();
  }

  const loginUrl = new URL("/login", request.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
};
