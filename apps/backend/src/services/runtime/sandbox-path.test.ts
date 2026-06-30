import { describe, expect, test } from "vitest";

import { resolveInsideSandbox } from "./sandbox-path.js";

// Merged behavior spec for the shared sandbox path resolver. Previously the
// Codex and Claude adapters each had their own copy of this guard with their
// own test subset; this union pins the contract both must satisfy.

describe("resolveInsideSandbox", () => {
  test("resolves relative paths joined to the workspace root", () => {
    expect(resolveInsideSandbox("/home/user/workspace", "out.txt")).toBe(
      "/home/user/workspace/out.txt"
    );
  });

  test("normalizes . and .. segments while staying inside root", () => {
    expect(resolveInsideSandbox("/home/user/ws", "./a/b/../c.txt")).toBe("/home/user/ws/a/c.txt");
    expect(resolveInsideSandbox("/home/user/workspace/sess-1", "a/b/../c/d.md")).toBe(
      "/home/user/workspace/sess-1/a/c/d.md"
    );
  });

  test("keeps absolute paths that are already inside root", () => {
    expect(resolveInsideSandbox("/home/user/ws", "/home/user/ws/inner/file.md")).toBe(
      "/home/user/ws/inner/file.md"
    );
  });

  test("rejects relative traversal that escapes root", () => {
    expect(() => resolveInsideSandbox("/home/user/ws", "../etc/passwd")).toThrow(
      /must be inside the session workspace/
    );
    expect(() =>
      resolveInsideSandbox("/home/user/workspace/sess-1", "../../etc/passwd")
    ).toThrow(/must be inside the session workspace/);
  });

  test("rejects absolute paths outside root", () => {
    expect(() => resolveInsideSandbox("/home/user/ws", "/etc/passwd")).toThrow(
      /must be inside the session workspace/
    );
  });

  test("allows the workspace root itself", () => {
    expect(resolveInsideSandbox("/home/user/ws", ".")).toBe("/home/user/ws");
  });

  test("handles workspace paths with trailing slash", () => {
    expect(resolveInsideSandbox("/home/user/ws/", "x.txt")).toBe("/home/user/ws/x.txt");
  });

  test("allows the workspace root ('.') even when workspacePath has a trailing slash", () => {
    // Regression guard: `resolved` is always normalized (no trailing slash), so
    // the root comparison must also use a normalized workspace, else this
    // benign case was spuriously rejected.
    expect(resolveInsideSandbox("/home/user/ws/", ".")).toBe("/home/user/ws");
  });

  test("uses POSIX semantics regardless of host OS", () => {
    // On Windows, path.resolve would default to backslash. Sandbox paths are
    // always Linux, so the result must stay POSIX.
    const resolved = resolveInsideSandbox("/home/u/ws", "x/y.txt");
    expect(resolved).toContain("/");
    expect(resolved).not.toContain("\\");
  });
});
