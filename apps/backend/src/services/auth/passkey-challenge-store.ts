import { createHash, randomBytes } from "node:crypto";

import type { StepUpAction } from "./step-up-store.js";

// The server half of a passkey ceremony: the challenge it sent, what the
// ceremony is for, and who or what it is bound to. It lives in Redis under a
// hash of a random id and is consumed once (GETDEL) when the browser answers.
// A record made for one purpose never serves another, and a record bound to
// a user, a sign-in flow, or a session serves only that one. See
// docs/architecture/local-accounts.md.

export const PASSKEY_CHALLENGE_TTL_SECONDS = 5 * 60;

/**
 * register: add a passkey (signed in, or a sign-in enrolment).
 * login: passwordless sign-in; the account is not known yet.
 * second_factor: the step after the password.
 * step_up: fresh proof for one sensitive action.
 */
export type PasskeyChallengePurpose = "register" | "login" | "second_factor" | "step_up";

export type PasskeyChallenge = {
  challenge: string;
  purpose: PasskeyChallengePurpose;
  /** The expected account, when it is known before the ceremony. */
  tenantId?: string;
  userId?: string;
  securityVersion?: number;
  /** SHA-256 of the sign-in flow id (second factor, sign-in enrolment). */
  flowKey?: string;
  /** The session family (signed-in registration, step-up). */
  familyId?: string;
  /** Step-up: the action to prove. Signed-in registration: the step-up it passed. */
  action?: StepUpAction;
  createdAtMs: number;
};

export type PasskeyChallengeRedis = {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
};

/** The binding key of a sign-in flow id, as stored in a challenge record. */
export function flowKeyOf(flowId: string): string {
  return createHash("sha256").update(`passkey-flow:${flowId}`, "utf8").digest("hex");
}

function keyFor(id: string): string {
  return `passkey_challenge:${createHash("sha256").update(id, "utf8").digest("hex")}`;
}

function isChallengeId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class PasskeyChallengeStore {
  constructor(private readonly redis: PasskeyChallengeRedis, private readonly now: () => number = Date.now) {}

  async create(record: Omit<PasskeyChallenge, "createdAtMs">): Promise<string> {
    const id = randomBytes(32).toString("base64url");
    const stored: PasskeyChallenge = { ...record, createdAtMs: this.now() };
    await this.redis.set(keyFor(id), JSON.stringify(stored), "EX", PASSKEY_CHALLENGE_TTL_SECONDS);
    return id;
  }

  /** Ends the record and returns it, once, when it has this purpose. */
  async consume(id: unknown, purpose: PasskeyChallengePurpose): Promise<PasskeyChallenge | null> {
    if (!isChallengeId(id)) return null;
    const raw = await this.redis.getdel(keyFor(id));
    if (!raw) return null;
    try {
      const record = JSON.parse(raw) as PasskeyChallenge;
      if (record.purpose !== purpose) return null;
      if (this.now() - record.createdAtMs > PASSKEY_CHALLENGE_TTL_SECONDS * 1000) return null;
      return record;
    } catch {
      return null;
    }
  }
}
