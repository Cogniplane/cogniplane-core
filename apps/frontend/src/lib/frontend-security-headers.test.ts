import { describe, expect, it } from "vitest";

import {
  applyFrontendSecurityHeaders,
  buildFrontendContentSecurityPolicy
} from "./frontend-security-headers";

describe("buildFrontendContentSecurityPolicy", () => {
  it("allows the configured sandbox origin for frames", () => {
    const previous = process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
    process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = "https://apps.example.test/path";
    try {
      const csp = buildFrontendContentSecurityPolicy({ nonce: "n", apiUrl: "https://api.example.test", development: false });
      expect(csp).toContain("frame-src 'self' https://apps.example.test");
      expect(csp).not.toContain("/path");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
      else process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = previous;
    }
  });

  it("keeps pages available when the sandbox origin is malformed", () => {
    const previous = process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
    process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = "sandbox.example.test";
    try {
      expect(buildFrontendContentSecurityPolicy({ nonce: "n", apiUrl: "https://api.example.test", development: false }))
        .toContain("frame-src 'self';");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
      else process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = previous;
    }
  });

  it("does not allow the app origin as its own sandbox", () => {
    const previous = process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
    process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = "https://app.example.test";
    try {
      const csp = buildFrontendContentSecurityPolicy({ nonce: "n", apiUrl: "https://api.example.test",
        appOrigin: "https://app.example.test", development: false });
      expect(csp).toContain("frame-src 'self';");
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
      else process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN = previous;
    }
  });

  it("uses a nonce and restricts framing and active content", () => {
    const csp = buildFrontendContentSecurityPolicy({
      nonce: "nonce123",
      apiUrl: "https://api.example.test/v1",
      development: false
    });

    expect(csp).toContain("script-src 'self' 'nonce-nonce123'");
    const scriptDirective = csp.split("; ").find((directive) => directive.startsWith("script-src"));
    expect(scriptDirective).not.toContain("'unsafe-inline'");
    expect(scriptDirective).not.toContain("'unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("upgrade-insecure-requests");
  });

  it("allowlists only the configured API origin for connections and images", () => {
    const csp = buildFrontendContentSecurityPolicy({
      nonce: "n",
      apiUrl: "https://api.example.test/some/path",
      development: false
    });

    expect(csp).toContain("connect-src 'self' https://api.example.test");
    expect(csp).toContain("img-src 'self' data: blob: https://api.example.test");
    expect(csp).not.toContain("/some/path");
  });

  it("allows local development tooling without weakening production", () => {
    const csp = buildFrontendContentSecurityPolicy({
      nonce: "dev",
      apiUrl: "http://localhost:3001",
      development: true
    });

    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toContain("script-src 'self' 'nonce-dev' 'unsafe-eval' http://localhost:8400");
    expect(csp).toContain(
      "connect-src 'self' http://localhost:3001 http://localhost:8400 ws: wss:"
    );
    expect(csp).toContain("ws: wss:");
    expect(csp).not.toContain("upgrade-insecure-requests");
  });

  it("never includes the Impeccable live origin in production", () => {
    const csp = buildFrontendContentSecurityPolicy({
      nonce: "prod",
      apiUrl: "https://api.example.test",
      development: false
    });

    expect(csp).not.toContain("http://localhost:8400");
  });
});

it("applies the complete frontend security header set", () => {
  const headers = new Headers();
  applyFrontendSecurityHeaders(headers, "default-src 'self'");

  expect(headers.get("content-security-policy")).toBe("default-src 'self'");
  expect(headers.get("x-content-type-options")).toBe("nosniff");
  expect(headers.get("strict-transport-security")).toContain("max-age=63072000");
  expect(headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
});
