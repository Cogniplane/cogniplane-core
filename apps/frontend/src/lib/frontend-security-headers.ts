export type FrontendSecurityPolicyInput = {
  nonce: string;
  apiUrl: string;
  development: boolean;
};

export function buildFrontendContentSecurityPolicy(input: FrontendSecurityPolicyInput): string {
  const apiOrigin = new URL(input.apiUrl).origin;
  const scriptSources = ["'self'", `'nonce-${input.nonce}'`];
  const developmentConnectSources = input.development
    ? " http://localhost:8400 ws: wss:"
    : "";
  if (input.development) scriptSources.push("'unsafe-eval'", "http://localhost:8400");

  return [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${apiOrigin}`,
    "font-src 'self' data:",
    `connect-src 'self' ${apiOrigin}${developmentConnectSources}`,
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(!input.development ? ["upgrade-insecure-requests"] : [])
  ].join("; ");
}

export const FRONTEND_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
  "permissions-policy": "camera=(), microphone=(), geolocation=()"
} as const;

export function applyFrontendSecurityHeaders(headers: Headers, csp: string): void {
  headers.set("content-security-policy", csp);
  for (const [name, value] of Object.entries(FRONTEND_SECURITY_HEADERS)) {
    headers.set(name, value);
  }
}
