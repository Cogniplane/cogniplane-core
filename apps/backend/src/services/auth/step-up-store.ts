import { createHash, randomBytes } from "node:crypto";

import { StepUpActionSchema, type StepUpAction as StepUpActionType } from "@cogniplane/shared-types";

import type { AuthMethod } from "../../lib/jwt.js";

// Fresh proof for one sensitive action (docs/architecture/sensitive-changes.md).
// POST /auth/step-up checks a proof and returns a token; the
// sensitive route takes it in the X-Step-Up header and consumes it.
//
// The token is single use, lives STEP_UP_TTL_SECONDS, and is bound to the
// user, the tenant, the session's refresh family, the account's security
// version, and one action name. An access token alone never carries step-up,
// so a token stolen before the proof gains nothing, and a proof for one action
// cannot be spent on another.

export const STEP_UP_TTL_SECONDS = 5 * 60;

/**
 * The actions that need step-up: the shared contract's list, which POST
 * /auth/step-up also accepts. step-up-routes.ts gives each one to one route.
 */
export const STEP_UP_ACTIONS = StepUpActionSchema.options;
export type StepUpAction = StepUpActionType;

export function isStepUpAction(value: unknown): value is StepUpAction {
  return typeof value === "string" && (STEP_UP_ACTIONS as readonly string[]).includes(value);
}

export type StepUpBinding = {
  userId: string;
  tenantId: string;
  familyId: string;
  securityVersion: number;
  action: StepUpAction;
};

type StoredStepUp = StepUpBinding & { amr: AuthMethod[] };

export type StepUpRedis = {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  getdel(key: string): Promise<string | null>;
};

function keyFor(rawToken: string): string {
  return `step_up:${createHash("sha256").update(rawToken, "utf8").digest("hex")}`;
}

export class StepUpStore {
  constructor(private readonly redis: StepUpRedis) {}

  async create(binding: StepUpBinding, amr: AuthMethod[]): Promise<{ token: string; expiresInSeconds: number }> {
    const token = randomBytes(32).toString("base64url");
    const stored: StoredStepUp = { ...binding, amr };
    await this.redis.set(keyFor(token), JSON.stringify(stored), "EX", STEP_UP_TTL_SECONDS);
    return { token, expiresInSeconds: STEP_UP_TTL_SECONDS };
  }

  /**
   * Consumes the token: it is gone after this call whatever the result.
   * Returns the proof's methods when every binding matches, else null.
   */
  async consume(rawToken: unknown, expected: StepUpBinding): Promise<AuthMethod[] | null> {
    if (typeof rawToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(rawToken)) return null;
    const value = await this.redis.getdel(keyFor(rawToken));
    if (!value) return null;
    let stored: StoredStepUp;
    try {
      stored = JSON.parse(value) as StoredStepUp;
    } catch {
      return null;
    }
    const matches =
      stored.userId === expected.userId &&
      stored.tenantId === expected.tenantId &&
      stored.familyId === expected.familyId &&
      stored.securityVersion === expected.securityVersion &&
      stored.action === expected.action;
    return matches ? stored.amr : null;
  }
}
