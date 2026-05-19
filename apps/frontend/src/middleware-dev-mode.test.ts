import { test, expect } from "vitest";

import { NextRequest } from "next/server";

// DEV_MODE is captured at module load. This file exercises the dev-mode branch
// by setting NEXT_PUBLIC_DEV_USER_ID before the dynamic import. The prod-mode
// branch lives in middleware.test.ts (a separate test process).
process.env.NEXT_PUBLIC_DEV_USER_ID = "dev-user";

const { default: middleware } = await import("./middleware.js");

test("dev mode bypasses auth on otherwise-protected paths", () => {
  const req = new NextRequest(new URL("http://localhost/admin"));
  const res = middleware(req);
  expect(res.status).toBe(200);
  expect(res.headers.get("location")).toBe(null);
});
