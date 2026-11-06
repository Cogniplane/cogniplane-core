import { expect } from "vitest";
import { FakeRefreshTokenRedis } from "./fake-refresh-token-redis.js";

/** Record all fake commands except GET. Unknown commands throw rather than pass silently. */
export function guardedAuthRedis() {
  const target = new FakeRefreshTokenRedis();
  const commands: string[] = [];
  const redis = new Proxy(target, {
    get(object, key) {
      // Fastify probes decorator descriptors; these are not Redis commands.
      if (key === "getter" || key === "setter") return undefined;
      const value = Reflect.get(object, key);
      if (value === undefined) throw new Error(`Unsupported Redis command/property: ${String(key)}`);
      if (typeof value !== "function" || key === "asAppRedis") return value;
      return (...args: unknown[]) => {
        if (key !== "get") commands.push(String(key));
        return Reflect.apply(value, object, args);
      };
    }
  });
  const checkpoint = () => {
    const values = [...target.store];
    const ttls = [...target.ttlMs];
    const offset = commands.length;
    return () => {
      // GETDEL and EVAL are writes even when this particular key is absent.
      expect(commands.slice(offset), "Redis commands before proof").toEqual([]);
      expect([...target.store], "Redis durable/security values before proof").toEqual(values);
      expect([...target.ttlMs], "Redis expiry changes before proof").toEqual(ttls);
    };
  };
  return { redis, checkpoint };
}
