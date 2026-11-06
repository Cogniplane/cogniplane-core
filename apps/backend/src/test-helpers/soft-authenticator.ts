import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";

import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { isoCBOR } from "@simplewebauthn/server/helpers";

// A software WebAuthn authenticator for tests: it makes real registration and
// assertion responses (ES256, attestation "none") that the backend checks
// with the real @simplewebauthn/server code. Each option can break one rule
// (origin, RP id, user verification, counter) to prove that the check holds.

const FLAG_UP = 0x01;
const FLAG_UV = 0x04;
const FLAG_BE = 0x08;
const FLAG_BS = 0x10;
const FLAG_AT = 0x40;

const b64url = (bytes: Uint8Array | Buffer) => Buffer.from(bytes).toString("base64url");
const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

export type CeremonyOverrides = {
  origin?: string;
  rpId?: string;
  userVerified?: boolean;
  type?: string;
  challenge?: string;
};

export class SoftAuthenticator {
  readonly credentialId = randomBytes(16);
  private readonly privateKey: KeyObject;
  private readonly cosePublicKey: Uint8Array;
  private userHandle: string | undefined;

  /**
   * `counter`: the signature counter. `synced` keeps it at 0, as synced
   * passkeys do; otherwise each assertion adds 1.
   */
  constructor(
    private readonly site: { origin: string; rpId: string },
    private counter = 0,
    private readonly synced = false
  ) {
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.privateKey = privateKey;
    const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
    this.cosePublicKey = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2], // kty: EC2
      [3, -7], // alg: ES256
      [-1, 1], // crv: P-256
      [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
      [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))]
    ]));
  }

  get id(): string {
    return b64url(this.credentialId);
  }

  /** Sets the counter the next assertion starts from (to replay an old value). */
  setCounter(value: number): void {
    this.counter = value;
  }

  private clientData(type: string, challenge: string, overrides: CeremonyOverrides): Buffer {
    return Buffer.from(JSON.stringify({
      type: overrides.type ?? type,
      challenge: overrides.challenge ?? challenge,
      origin: overrides.origin ?? this.site.origin,
      crossOrigin: false
    }));
  }

  private flags(overrides: CeremonyOverrides, extra: number): number {
    const backup = this.synced ? FLAG_BE | FLAG_BS : 0;
    return FLAG_UP | (overrides.userVerified === false ? 0 : FLAG_UV) | backup | extra;
  }

  /** Answers navigator.credentials.create() for these options. */
  register(options: { challenge: string; user: { id: string } }, overrides: CeremonyOverrides = {}): RegistrationResponseJSON {
    this.userHandle = options.user.id;
    const clientDataJSON = this.clientData("webauthn.create", options.challenge, overrides);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(this.credentialId.length);
    const authData = Buffer.concat([
      sha256(overrides.rpId ?? this.site.rpId),
      Buffer.from([this.flags(overrides, FLAG_AT)]),
      counter,
      Buffer.alloc(16), // aaguid
      idLength,
      this.credentialId,
      Buffer.from(this.cosePublicKey)
    ]);
    const attestationObject = isoCBOR.encode(new Map<string, string | Map<string, string> | Uint8Array>([
      ["fmt", "none"],
      ["attStmt", new Map<string, string>()],
      ["authData", new Uint8Array(authData)]
    ]));
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: { clientDataJSON: b64url(clientDataJSON), attestationObject: b64url(attestationObject), transports: ["internal"] },
      clientExtensionResults: {}
    };
  }

  /** Answers navigator.credentials.get() for this challenge. */
  assert(challenge: string, overrides: CeremonyOverrides & { userHandle?: string | null } = {}): AuthenticationResponseJSON {
    if (!this.synced) this.counter += 1;
    const clientDataJSON = this.clientData("webauthn.get", challenge, overrides);
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.counter);
    const authData = Buffer.concat([sha256(overrides.rpId ?? this.site.rpId), Buffer.from([this.flags(overrides, 0)]), counter]);
    const signature = sign("sha256", Buffer.concat([authData, sha256(clientDataJSON)]), this.privateKey);
    const userHandle = overrides.userHandle === undefined ? this.userHandle : overrides.userHandle ?? undefined;
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64url(clientDataJSON),
        authenticatorData: b64url(authData),
        signature: b64url(signature),
        ...(userHandle ? { userHandle } : {})
      },
      clientExtensionResults: {}
    };
  }
}
