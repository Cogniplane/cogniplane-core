// Auth middleware uses a small allowlist of public paths (login, OAuth
// callbacks, refresh, logout). Earlier this matched with `String.startsWith`
// against the raw `request.url`, which let attackers smuggle URLs that begin
// with an allowlisted prefix (e.g. `/auth/login.attack`,
// `/auth/github/install/callbackXYZ`) past authentication. Strip the query
// string and require an exact match against the set.
export function isPublicAuthPath(url: string, publicPaths: ReadonlySet<string>): boolean {
  const queryStart = url.indexOf("?");
  const pathname = queryStart === -1 ? url : url.slice(0, queryStart);
  return publicPaths.has(pathname);
}
