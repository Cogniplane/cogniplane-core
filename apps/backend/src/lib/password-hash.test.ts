import { describe, expect, test } from "vitest";

import { PasswordHasher, PasswordHasherBusyError } from "./password-hash.js";

describe("PasswordHasher", () => {
  const hasher = new PasswordHasher(4);

  test("hashes to an Argon2id PHC string with the OWASP parameters and a random salt", async () => {
    const first = await hasher.hash("correct horse battery staple");
    const second = await hasher.hash("correct horse battery staple");
    expect(first).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    expect(first).not.toBe(second);
  });

  test("verifies the right password and refuses a wrong one", async () => {
    const stored = await hasher.hash("correct horse battery staple");
    expect(await hasher.verify(stored, "correct horse battery staple")).toEqual({ ok: true, needsRehash: false });
    expect(await hasher.verify(stored, "correct horse battery stapler")).toEqual({ ok: false, needsRehash: false });
  });

  test("asks for a rehash when a stored hash uses other parameters", async () => {
    // A real hash made with older, weaker parameters.
    const crypto = await import("node:crypto");
    const salt = crypto.randomBytes(16);
    const derived = await new Promise<Buffer>((resolve, reject) =>
      (crypto as unknown as { argon2: (a: string, p: object, cb: (e: Error | null, k: Buffer) => void) => void }).argon2(
        "argon2id",
        { message: Buffer.from("old parameters password"), nonce: salt, parallelism: 1, tagLength: 32, memory: 8192, passes: 3 },
        (error, key) => (error ? reject(error) : resolve(key))
      )
    );
    const old = `$argon2id$v=19$m=8192,t=3,p=1$${salt.toString("base64").replace(/=+$/, "")}$${derived.toString("base64").replace(/=+$/, "")}`;
    expect(await hasher.verify(old, "old parameters password")).toEqual({ ok: true, needsRehash: true });
  });

  test.each([
    ["not a PHC string", "plaintext"],
    ["another algorithm", "$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"],
    ["absurd memory", "$argon2id$v=19$m=99999999,t=2,p=1$c2FsdHNhbHQ$aGFzaGhhc2hoYXNoaGFzaA"]
  ])("never matches %s", async (_case, stored) => {
    expect(await hasher.verify(stored, "anything at all here")).toEqual({ ok: false, needsRehash: false });
  });

  // 2 is the LOCAL_AUTH_HASH_CONCURRENCY default.
  test.each([1, 2])("with a limit of %i, refuses work past it instead of queueing", async (limit) => {
    const limited = new PasswordHasher(limit);
    const calls = Array.from({ length: limit + 1 }, (_, index) => limited.hash(`password value number ${index}`));
    const results = await Promise.allSettled(calls);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(limit);
    const rejected = results.filter((result) => result.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.reason).toBeInstanceOf(PasswordHasherBusyError);
  });

  test("verifyDummy does the work and never throws for a normal password", async () => {
    await expect(hasher.verifyDummy("whatever the caller typed")).resolves.toBeUndefined();
  });
});
