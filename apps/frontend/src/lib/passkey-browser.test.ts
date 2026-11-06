// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

const webauthn = vi.hoisted(() => ({
  browserSupportsWebAuthn: vi.fn(() => true), startAuthentication: vi.fn(), startRegistration: vi.fn()
}));
vi.mock("@simplewebauthn/browser", () => webauthn);

import { assertWithPasskey, createPasskey, PasskeyCeremonyError } from "./passkey-browser";

const named = (name: string) => Object.assign(new Error(name), { name });

afterEach(() => vi.resetAllMocks());

describe("passkey ceremonies in the browser", () => {
  it("passes the backend options through and returns the credential", async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(true);
    webauthn.startAuthentication.mockResolvedValue({ id: "cred-1" });
    await expect(assertWithPasskey({ challenge: "c" })).resolves.toEqual({ id: "cred-1" });
    expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: { challenge: "c" } });
  });

  it.each([
    ["NotAllowedError", "passkey_cancelled"],
    ["AbortError", "passkey_cancelled"],
    ["InvalidStateError", "passkey_exists"]
  ])("names a %s", async (name, code) => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(true);
    webauthn.startRegistration.mockRejectedValue(named(name));
    await expect(createPasskey({})).rejects.toMatchObject({ code });
  });

  it("keeps other errors as they are", async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(true);
    webauthn.startRegistration.mockRejectedValue(named("SecurityError"));
    await expect(createPasskey({})).rejects.toMatchObject({ name: "SecurityError" });
  });

  it("refuses at once without WebAuthn", async () => {
    webauthn.browserSupportsWebAuthn.mockReturnValue(false);
    await expect(assertWithPasskey({})).rejects.toBeInstanceOf(PasskeyCeremonyError);
    expect(webauthn.startAuthentication).not.toHaveBeenCalled();
  });
});
