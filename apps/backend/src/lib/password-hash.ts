import crypto, { randomBytes, timingSafeEqual } from "node:crypto";

// Argon2id password hashes for local accounts, with Node's built-in
// crypto.argon2 (Node 24.7+; config.ts refuses local login without it).
// Parameters are the OWASP minimum for Argon2id: 19 MiB, 2 passes, 1 lane.
// The stored value is a PHC string, so a later change of parameters can be
// recognised and the hash replaced at the next sign-in.
// See docs/ARCHITECTURE.md, "Authentication".

type Argon2Params = { memory: number; passes: number; parallelism: number };

const CURRENT_PARAMS: Argon2Params = { memory: 19_456, passes: 2, parallelism: 1 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;
// Stops a stored string from asking for an absurd amount of memory or time.
const MAX_MEMORY_KIB = 262_144;
const MAX_PASSES = 10;
const MAX_PARALLELISM = 8;

type Argon2Fn = (
  algorithm: "argon2id",
  parameters: {
    message: Buffer;
    nonce: Buffer;
    parallelism: number;
    tagLength: number;
    memory: number;
    passes: number;
  },
  callback: (error: Error | null, derived: Buffer) => void
) => void;

function argon2(): Argon2Fn {
  const fn = (crypto as unknown as { argon2?: Argon2Fn }).argon2;
  if (typeof fn !== "function") throw new Error("crypto.argon2 is not available in this Node version.");
  return fn;
}

function derive(password: string, salt: Buffer, params: Argon2Params, tagLength: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    argon2()(
      "argon2id",
      {
        message: Buffer.from(password, "utf8"),
        nonce: salt,
        parallelism: params.parallelism,
        tagLength,
        memory: params.memory,
        passes: params.passes
      },
      (error, derived) => (error ? reject(error) : resolve(derived))
    );
  });
}

function b64(buffer: Buffer): string {
  return buffer.toString("base64").replace(/=+$/, "");
}

type ParsedHash = { params: Argon2Params; salt: Buffer; hash: Buffer };

const PHC_PATTERN = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

function parse(stored: string): ParsedHash | null {
  const match = PHC_PATTERN.exec(stored);
  if (!match) return null;
  const params = { memory: Number(match[1]), passes: Number(match[2]), parallelism: Number(match[3]) };
  if (
    params.memory < 8 * params.parallelism || params.memory > MAX_MEMORY_KIB ||
    params.passes < 1 || params.passes > MAX_PASSES ||
    params.parallelism < 1 || params.parallelism > MAX_PARALLELISM
  ) {
    return null;
  }
  const salt = Buffer.from(match[4]!, "base64");
  const hash = Buffer.from(match[5]!, "base64");
  if (salt.length < 8 || hash.length < 16) return null;
  return { params, salt, hash };
}

/**
 * Raised when this process already computes as many hashes as
 * LOCAL_AUTH_HASH_CONCURRENCY allows. Callers answer a retryable 503.
 */
export class PasswordHasherBusyError extends Error {
  constructor() {
    super("Password hashing is at capacity.");
    this.name = "PasswordHasherBusyError";
  }
}

export type PasswordVerification = { ok: boolean; needsRehash: boolean };

export class PasswordHasher {
  private active = 0;
  private dummyHash: Promise<string> | null = null;

  constructor(private readonly maxConcurrent: number) {}

  private async withSlot<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrent) throw new PasswordHasherBusyError();
    this.active += 1;
    try {
      return await work();
    } finally {
      this.active -= 1;
    }
  }

  async hash(password: string): Promise<string> {
    return this.withSlot(async () => {
      const salt = randomBytes(SALT_BYTES);
      const hash = await derive(password, salt, CURRENT_PARAMS, TAG_BYTES);
      const p = CURRENT_PARAMS;
      return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(hash)}`;
    });
  }

  /**
   * Compares a password with a stored hash in constant time. A stored value
   * this code cannot parse never matches. `needsRehash` is true when the hash
   * uses other parameters than the current ones.
   */
  async verify(stored: string, password: string): Promise<PasswordVerification> {
    const parsed = parse(stored);
    if (!parsed) {
      // Spend the same work as a real check, so a broken row does not answer faster.
      await this.verify(await this.getDummyHash(), password);
      return { ok: false, needsRehash: false };
    }
    return this.withSlot(async () => {
      const candidate = await derive(password, parsed.salt, parsed.params, parsed.hash.length);
      const ok = candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
      const p = parsed.params;
      const needsRehash =
        p.memory !== CURRENT_PARAMS.memory || p.passes !== CURRENT_PARAMS.passes ||
        p.parallelism !== CURRENT_PARAMS.parallelism || parsed.hash.length !== TAG_BYTES;
      return { ok, needsRehash };
    });
  }

  /**
   * Does the work of one verification against a fixed hash and always fails.
   * Sign-in calls it for an unknown email, so the response time does not show
   * whether an account exists.
   */
  async verifyDummy(password: string): Promise<void> {
    const parsed = parse(await this.getDummyHash())!;
    await this.withSlot(() => derive(password, parsed.salt, parsed.params, parsed.hash.length));
  }

  private getDummyHash(): Promise<string> {
    this.dummyHash ??= this.hash(randomBytes(24).toString("base64url")).catch((error) => {
      this.dummyHash = null;
      throw error;
    });
    return this.dummyHash;
  }
}
