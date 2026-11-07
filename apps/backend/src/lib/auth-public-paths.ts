// Auth middleware uses a small allowlist of public paths (login, OAuth
// callbacks, refresh, logout). The match must be exact. A prefix match would
// let a URL such as `/auth/login.attack` skip authentication.
export function isPublicAuthPath(url: string, publicPaths: ReadonlySet<string>): boolean {
  const queryStart = url.indexOf("?");
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  return publicPaths.has(pathname);
}

// GET /downloads/:token authenticates with the single-use token itself. A
// browser navigation or an <img> request cannot send the Bearer header, so the
// auth hook must let it through in every mode. The route reads identity from
// the token row, never from `request.auth`.
export function isPublicDownloadRequest(method: string, url: string): boolean {
  return method === "GET" && /^\/downloads\/[^/?]+(\?|$)/.test(url);
}
