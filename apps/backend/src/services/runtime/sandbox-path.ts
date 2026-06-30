import path from "node:path";

/**
 * Resolve `filePath` against a posix sandbox workspace and reject anything that
 * escapes the root — prevents path-traversal into host paths shared by the
 * sandbox. Shared by the Codex and Claude runtime adapters so there is one
 * security-critical traversal guard, not two.
 *
 * POSIX semantics regardless of the backend's OS (sandbox paths are always
 * Linux). `path.posix.resolve` treats an absolute `filePath` as a reset, so
 * both absolute-in-workspace and relative inputs resolve correctly before the
 * guard rejects escapes.
 */
export function resolveInsideSandbox(workspacePath: string, filePath: string): string {
  // `root` carries a single trailing slash for the startsWith prefix check;
  // `rootNoTrailing` matches the form `resolved` takes (path.posix.resolve
  // always strips trailing slashes, while path.posix.normalize keeps them).
  // Comparing `resolved` against the raw workspacePath would spuriously reject
  // a benign "." when workspacePath itself ends in "/".
  const root = path.posix.normalize(workspacePath + "/");
  const rootNoTrailing = root.length > 1 && root.endsWith("/") ? root.slice(0, -1) : root;
  const resolved = path.posix.resolve(workspacePath, filePath);
  if (!resolved.startsWith(root) && resolved !== rootNoTrailing) {
    throw new Error("filePath must be inside the session workspace.");
  }
  return resolved;
}
