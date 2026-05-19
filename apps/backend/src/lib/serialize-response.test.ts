import { test, expect, describe, vi, afterEach, beforeEach } from "vitest";

import { z } from "zod";

import { serialize } from "./serialize-response.js";

describe("serialize", () => {
  let originalEnv: string | undefined;
  beforeEach(() => {
    originalEnv = process.env.NODE_ENV;
  });
  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  test("returns parsed value when input matches schema", () => {
    const schema = z.object({ id: z.string(), count: z.number() });
    expect(serialize(schema, { id: "x", count: 1 })).toEqual({ id: "x", count: 1 });
  });

  test("strips unknown keys (Zod default) without throwing", () => {
    const schema = z.object({ id: z.string() });
    expect(serialize(schema, { id: "x", extra: "drop-me" })).toEqual({ id: "x" });
  });

  test("throws with field paths included in the message on contract drift", () => {
    process.env.NODE_ENV = "production"; // suppress stderr mirror
    const schema = z.object({ id: z.string(), nested: z.object({ flag: z.boolean() }) });
    expect(() => serialize(schema, { id: 1, nested: { flag: "no" } })).toThrow(
      /Response shape does not match contract/
    );
    try {
      serialize(schema, { id: 1, nested: { flag: "no" } });
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("id");
      expect(msg).toContain("nested.flag");
    }
  });

  test("uses '<root>' for top-level path errors", () => {
    process.env.NODE_ENV = "production";
    const schema = z.string();
    try {
      serialize(schema, 42);
    } catch (e) {
      expect((e as Error).message).toContain("<root>");
    }
  });

  test("mirrors contract violation summary to console.error in non-production", () => {
    process.env.NODE_ENV = "test";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const schema = z.object({ id: z.string() });
    expect(() => serialize(schema, { id: 42 })).toThrow();
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toMatch(/contract violation/);
    errSpy.mockRestore();
  });

  test("does NOT mirror to console.error in production", () => {
    process.env.NODE_ENV = "production";
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const schema = z.object({ id: z.string() });
    expect(() => serialize(schema, { id: 42 })).toThrow();
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
