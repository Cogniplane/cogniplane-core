import {
  browserSupportsWebAuthn,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  startAuthentication,
  startRegistration
} from "@simplewebauthn/browser";

// The browser half of a passkey ceremony. The backend sends the options and
// checks the answer (docs/ARCHITECTURE.md, "Authentication"); this module
// only calls WebAuthn and names its failures.

/** passkey_cancelled: the person closed the prompt, or it timed out. */
export class PasskeyCeremonyError extends Error {
  constructor(readonly code: "passkey_cancelled" | "passkey_unsupported" | "passkey_exists", cause?: unknown) {
    super(code, { cause });
    this.name = "PasskeyCeremonyError";
  }
}

export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && browserSupportsWebAuthn();
}

function ceremonyError(error: unknown): unknown {
  const name = (error as { name?: string } | null)?.name;
  // WebAuthn reports a cancel, a timeout, and "no passkey here" all as NotAllowedError.
  if (name === "NotAllowedError" || name === "AbortError") return new PasskeyCeremonyError("passkey_cancelled", error);
  // The authenticator already holds a passkey of this account (excludeCredentials).
  if (name === "InvalidStateError") return new PasskeyCeremonyError("passkey_exists", error);
  return error;
}

export async function createPasskey(options: Record<string, unknown>): Promise<unknown> {
  if (!passkeysSupported()) throw new PasskeyCeremonyError("passkey_unsupported");
  try {
    return await startRegistration({ optionsJSON: options as unknown as PublicKeyCredentialCreationOptionsJSON });
  } catch (error) {
    throw ceremonyError(error);
  }
}

export async function assertWithPasskey(options: Record<string, unknown>): Promise<unknown> {
  if (!passkeysSupported()) throw new PasskeyCeremonyError("passkey_unsupported");
  try {
    return await startAuthentication({ optionsJSON: options as unknown as PublicKeyCredentialRequestOptionsJSON });
  } catch (error) {
    throw ceremonyError(error);
  }
}
