import { createHash, randomBytes } from "node:crypto";

import type { AuthMethod } from "../../lib/jwt.js";

// The state of a local sign-in between its steps: after the password and
// before the second factor, or before a forced enrolment. It lives in Redis
// under a hash of a random flow id; the browser holds only the id, in an
// httpOnly cookie. It never grants a session by itself: the step that
// completes it consumes it atomically (GETDEL) and the account's security
// version must still match. A step that spends something (a code, a passkey
// answer) takes the flow first (consume), does its database work, and puts
// the flow back only when it fails: two requests never spend on one flow, and
// a commit is always followed by its answer. A new purpose is a new flow, and
// wrong codes are counted in a separate key by one script. See
// docs/ARCHITECTURE.md, "Authentication".

export const LOGIN_FLOW_TTL_SECONDS = 5 * 60;
/** Wrong codes accepted in one flow before it ends. */
export const LOGIN_FLOW_MAX_FAILURES = 5;

/**
 * mfa: password done, a second factor is due.
 * enroll: password done (or setup link used); the account must enrol a factor.
 * recover: a recovery code was used; the account must enrol a new factor.
 */
export type LoginFlowPurpose = "mfa" | "enroll" | "recover";

export type LoginFlow = {
  tenantId: string;
  userId: string;
  email: string;
  securityVersion: number;
  amr: AuthMethod[];
  purpose: LoginFlowPurpose;
  /** recover: the hash of the checked recovery code, spent by the enrolment. */
  recoveryCodeHash?: string;
  createdAtMs: number;
};

export type LoginFlowRedis = {
  set(key: string, value: string, mode: "EX", ttlSeconds: number): Promise<unknown>;
  get(key: string): Promise<string | null>;
  getdel(key: string): Promise<string | null>;
  eval(script: string, numberOfKeys: number, ...args: string[]): Promise<unknown>;
};

// KEYS: flow, failure counter. ARGV: flow JSON, TTL in seconds, "1" to count
// a wrong secret, maximum. One step: the count and the flow's return happen
// together, so no other request can take the flow in between and make the
// count miss it. At the maximum the flow ends instead. Returns 1 when the
// flow is back.
const PUT_BACK_SCRIPT = `-- login-flow-put-back-v1
if ARGV[3] == "1" then
  local failures = redis.call("INCR", KEYS[2])
  redis.call("EXPIRE", KEYS[2], tonumber(ARGV[2]))
  if failures >= tonumber(ARGV[4]) then
    redis.call("DEL", KEYS[1], KEYS[2])
    return 0
  end
end
redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[2]))
return 1
`;

function hashId(flowId: string): string {
  return createHash("sha256").update(flowId, "utf8").digest("hex");
}

function keyFor(flowId: string): string {
  return `login_flow:${hashId(flowId)}`;
}

function failureKeyFor(flowId: string): string {
  return `login_flow_failures:${hashId(flowId)}`;
}

function isFlowId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

export class LoginFlowStore {
  constructor(private readonly redis: LoginFlowRedis, private readonly now: () => number = Date.now) {}

  private remainingSeconds(createdAtMs: number): number {
    return Math.ceil((createdAtMs + LOGIN_FLOW_TTL_SECONDS * 1000 - this.now()) / 1000);
  }

  /**
   * Starts a flow. `createdAtMs` carries the deadline of an earlier flow over
   * to the next one (a recovery code does not give more time). Returns null
   * when that deadline has passed.
   */
  async create(flow: Omit<LoginFlow, "createdAtMs">, createdAtMs = this.now()): Promise<string | null> {
    const remaining = this.remainingSeconds(createdAtMs);
    if (remaining <= 0) return null;
    const id = randomBytes(32).toString("base64url");
    const stored: LoginFlow = { ...flow, createdAtMs };
    await this.redis.set(keyFor(id), JSON.stringify(stored), "EX", remaining);
    return id;
  }

  private parse(value: string | null): LoginFlow | null {
    if (!value) return null;
    try {
      const flow = JSON.parse(value) as LoginFlow;
      // The Redis TTL ends it; this also bounds a flow carried over.
      return this.now() - flow.createdAtMs > LOGIN_FLOW_TTL_SECONDS * 1000 ? null : flow;
    } catch {
      return null;
    }
  }

  async read(flowId: unknown): Promise<LoginFlow | null> {
    if (!isFlowId(flowId)) return null;
    return this.parse(await this.redis.get(keyFor(flowId)));
  }

  /** Ends the flow and returns it, once. */
  async consume(flowId: unknown): Promise<LoginFlow | null> {
    if (!isFlowId(flowId)) return null;
    return this.parse(await this.redis.getdel(keyFor(flowId)));
  }

  /**
   * Puts back a flow that this request took with `consume` and could not
   * finish (a wrong secret, a throttle answer, an error), with its original
   * deadline. With `failure`, it also counts a wrong secret, in the same
   * step; the flow ends after LOGIN_FLOW_MAX_FAILURES. Only the request that
   * consumed the flow calls it, so it never brings back a flow that another
   * request finished.
   */
  async restore(flowId: string, flow: LoginFlow, options: { failure?: boolean } = {}): Promise<void> {
    const remaining = this.remainingSeconds(flow.createdAtMs);
    if (remaining <= 0) return;
    await this.redis.eval(
      PUT_BACK_SCRIPT, 2, keyFor(flowId), failureKeyFor(flowId),
      JSON.stringify(flow), String(remaining), options.failure ? "1" : "0", String(LOGIN_FLOW_MAX_FAILURES)
    );
  }
}
