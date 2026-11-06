import { expect, test } from "vitest";
import { guardedAuthRedis } from "./redis-write-guard.js";

test.each(["set", "del", "getdel", "eval"] as const)("guard detects %s even if the final value is unchanged", async command => {
  const { redis, checkpoint } = guardedAuthRedis();
  await redis.set("refresh_family:seed", "active", "EX", 60);
  const check = checkpoint();
  if (command === "set") await redis.set("refresh_family:seed", "active", "EX", 60);
  if (command === "del") await redis.del("absent");
  if (command === "getdel") await redis.getdel("absent");
  if (command === "eval") await expect(redis.eval("unknown", 0)).rejects.toThrow("Unsupported fake Redis script");
  expect(check).toThrow("Redis commands before proof");
});

test("guard detects direct security state and expiry mutation, and refuses an unsupported adapter method", () => {
  const { redis, checkpoint } = guardedAuthRedis();
  const check = checkpoint();
  redis.store.set("tool-context", "changed");
  expect(check).toThrow();
  redis.store.clear();
  redis.ttlMs.set("refresh_family:seed", 1);
  expect(check).toThrow();
  expect(() => Reflect.get(redis, "hset")).toThrow("Unsupported Redis command/property");
});
