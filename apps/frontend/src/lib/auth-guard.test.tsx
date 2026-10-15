// @vitest-environment jsdom
//
// The real AuthProvider and AuthGuard, with only the network stubbed. The
// session hint cookie is a hint for the middleware. Neither the provider nor
// the guard may read it as proof of a session or a role.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The provider reads this at load. Dev-headers mode would invent an owner.
vi.hoisted(() => { delete process.env.NEXT_PUBLIC_DEV_USER_ID; });
const router = vi.hoisted(() => ({ replace: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

import { setAccessToken } from "./api-client";
import { AuthProvider, type AuthUser } from "./auth-context";
import { AuthGuard } from "./auth-guard";

const HINT = "cogniplane_session_hint";
const ADMIN_ONLY: Array<AuthUser["role"]> = ["admin", "owner"];

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const person = (role: AuthUser["role"]) => ({
  userId: "u-1", email: "person@example.test", displayName: "Person", tenantId: "t-1", role
});

type Reply = () => Response | Promise<Response>;
type Call = { path: string; authorization: string | null };

/** Stubs the two auth endpoints and records each request. */
function stubAuthApi(replies: { refresh: Reply; me?: Reply }): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, authorization: new Headers(init?.headers).get("authorization") });
    if (path === "/auth/refresh") return replies.refresh();
    if (path === "/auth/me" && replies.me) return replies.me();
    return json(404, { error: "unexpected_call", path });
  }));
  return calls;
}

function mount(requiredRoles?: Array<AuthUser["role"]>) {
  return render(
    <AuthProvider>
      <AuthGuard requiredRoles={requiredRoles}>
        <section data-testid="protected">Private admin data</section>
      </AuthGuard>
    </AuthProvider>
  );
}

const forgeHint = () => { document.cookie = `${HINT}=1; Path=/`; };
const protectedContent = () => screen.queryByTestId("protected");

beforeEach(() => {
  setAccessToken(null);
  router.replace.mockClear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  for (const name of [HINT, "role", "cogniplane_role", "user_role"]) document.cookie = `${name}=; Path=/; Max-Age=0`;
  localStorage.clear();
});

describe("AuthGuard with a forged session hint cookie", () => {
  it("withholds the content and sends the visitor to /login when the server knows no session", async () => {
    forgeHint();
    const calls = stubAuthApi({ refresh: () => json(401, { error: "invalid_refresh_token" }) });
    mount();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(protectedContent()).toBeNull();
    expect(screen.queryByText("Loading...")).toBeNull();
    // No session, so no token: the guard never asked /auth/me, and nothing sent a bearer token.
    expect(calls.map((call) => call.path)).toEqual(["/auth/refresh"]);
    expect(calls.every((call) => call.authorization === null)).toBe(true);
  });

  it("shows only the loading state while the session check is pending", async () => {
    forgeHint();
    let answer!: () => void;
    const pending = new Promise<Response>((resolve) => { answer = () => resolve(json(401, { error: "invalid_refresh_token" })); });
    stubAuthApi({ refresh: () => pending });
    mount();

    expect(await screen.findByText("Loading...")).toBeTruthy();
    expect(protectedContent()).toBeNull();
    expect(router.replace).not.toHaveBeenCalled();
    answer();
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(protectedContent()).toBeNull();
  });

  it("withholds the content when /auth/me refuses the token", async () => {
    forgeHint();
    stubAuthApi({
      refresh: () => json(200, { accessToken: "stolen-or-expired" }),
      me: () => json(401, { error: "invalid_token" })
    });
    mount();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(protectedContent()).toBeNull();
  });

  it("withholds the content when the session check fails on the network", async () => {
    forgeHint();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    mount();

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(protectedContent()).toBeNull();
  });

  it.each(["member", "admin"] as const)("withholds admin content from a signed-out visitor who forged %s role values", async (role) => {
    forgeHint();
    document.cookie = `role=${role}; Path=/`;
    document.cookie = `cogniplane_role=${role}; Path=/`;
    localStorage.setItem("role", role);
    stubAuthApi({ refresh: () => json(401, { error: "invalid_refresh_token" }) });
    mount(ADMIN_ONLY);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"));
    expect(protectedContent()).toBeNull();
  });

  it("takes the role from /auth/me: a member is turned away from an admin area", async () => {
    forgeHint();
    document.cookie = "role=admin; Path=/";
    document.cookie = "cogniplane_role=owner; Path=/";
    localStorage.setItem("role", "admin");
    stubAuthApi({ refresh: () => json(200, { accessToken: "member-token" }), me: () => json(200, person("member")) });
    mount(ADMIN_ONLY);

    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/"));
    expect(router.replace).not.toHaveBeenCalledWith("/login");
    expect(protectedContent()).toBeNull();
  });
});

describe("AuthGuard with a real session", () => {
  it.each([
    ["admin", true],
    ["owner", true],
    ["admin", false]
  ] as const)("shows admin content to the %s role (hint cookie present: %s)", async (role, hint) => {
    if (hint) forgeHint();
    stubAuthApi({ refresh: () => json(200, { accessToken: "token" }), me: () => json(200, person(role)) });
    mount(ADMIN_ONLY);

    expect((await screen.findByTestId("protected")).textContent).toBe("Private admin data");
    expect(router.replace).not.toHaveBeenCalled();
  });

  it("shows content that needs no role to a member", async () => {
    stubAuthApi({ refresh: () => json(200, { accessToken: "token" }), me: () => json(200, person("member")) });
    mount();

    expect(await screen.findByTestId("protected")).toBeTruthy();
    expect(router.replace).not.toHaveBeenCalled();
  });
});
