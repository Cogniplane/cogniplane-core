import {
  completeRefreshRotation,
  consumeRefreshJti,
  issueRefreshJti,
  revokeRefreshFamily,
  waitForRefreshRotation,
  type RefreshRotationResult,
  type RefreshTokenRedis
} from "../../lib/refresh-token-store.js";

export type RefreshRotationClaim =
  | { status: "claimed"; familyId: string }
  | { status: "completed"; result: RefreshRotationResult }
  | { status: "in_progress" }
  | { status: "reuse_detected"; familyId: string }
  | { status: "expired" }
  | { status: "revoked" };

export class RefreshTokenRotationService {
  constructor(
    private readonly redis: RefreshTokenRedis,
    private readonly tokenTtlSeconds: number
  ) {}

  async issue(input: {
    jti: string;
    familyId: string;
    loginAtEpochSeconds?: number;
  }): Promise<void> {
    await issueRefreshJti(this.redis, {
      ...input,
      ttlSeconds: this.tokenTtlSeconds
    });
  }

  async claim(input: { jti: string; familyId: string }): Promise<RefreshRotationClaim> {
    const claim = await consumeRefreshJti(this.redis, {
      ...input,
      familyTtlSeconds: this.tokenTtlSeconds
    });

    switch (claim.status) {
      case "ok":
        return { status: "claimed", familyId: claim.familyId };
      case "concurrent": {
        const result = claim.result ?? (await waitForRefreshRotation(this.redis, { jti: input.jti }));
        return result ? { status: "completed", result } : { status: "in_progress" };
      }
      case "reuse_detected":
        return claim;
      case "absolute_expired":
        return { status: "expired" };
      case "revoked":
      case "not_found":
        return { status: "revoked" };
    }
  }

  async complete(jti: string, result: RefreshRotationResult): Promise<void> {
    await completeRefreshRotation(this.redis, { jti, result });
  }

  async revoke(familyId: string): Promise<void> {
    await revokeRefreshFamily(this.redis, {
      familyId,
      ttlSeconds: this.tokenTtlSeconds
    });
  }
}
