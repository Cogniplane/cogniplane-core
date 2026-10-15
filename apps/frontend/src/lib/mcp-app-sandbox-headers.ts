/** The origin that may frame the sandbox proxy, or null when the setting is
 *  missing or unsafe. The framing policy and the proxy page both use it, so
 *  they always agree on who the parent is. */
export function mcpAppParentOrigin(rawParentOrigin: string | undefined): string | null {
  if (!rawParentOrigin) return null;
  try {
    const origin = new URL(rawParentOrigin);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
    if (!origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash &&
        (origin.protocol === "https:" || (local && origin.protocol === "http:"))) {
      return origin.origin;
    }
  } catch { /* Invalid configuration denies framing. */ }
  return null;
}

export function sandboxSecurityHeaders(rawParentOrigin: string | undefined): Headers {
  const headers = new Headers();
  const parentSource = mcpAppParentOrigin(rawParentOrigin) ?? "'none'";
  headers.set("content-security-policy", `frame-ancestors ${parentSource}; object-src 'none'`);
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  headers.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  return headers;
}
