import { z } from "@cogniplane/shared-types";
import { afterEach, expect, it, vi } from "vitest";

import { parseResponse } from "./validate-response";

afterEach(() => { vi.restoreAllMocks(); });

const Schema = z.object({ secret: z.string(), otpauthUri: z.string(), kind: z.enum(["totp"]) });

it("returns the parsed value", () => {
  const value = { secret: "s", otpauthUri: "otpauth://x", kind: "totp" };
  expect(parseResponse(Schema, value, "POST /me/security/totp/start")).toEqual(value);
});

it("names the refused fields, and neither the log nor the error holds a value of the body", () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
  const body = { secret: "SYNTHETIC-TOTP-SECRET", kind: "SYNTHETIC-KIND-VALUE" };

  let thrown: unknown;
  try {
    parseResponse(Schema, body, "POST /me/security/totp/start");
  } catch (error) {
    thrown = error;
  }

  expect(String(thrown)).toContain("Schema mismatch at POST /me/security/totp/start: otpauthUri:");
  expect(errors).toHaveBeenCalledOnce();
  const logged = JSON.stringify(errors.mock.calls) + String(thrown);
  expect(logged).toContain("otpauthUri");
  expect(logged).not.toContain("SYNTHETIC-TOTP-SECRET");
  expect(logged).not.toContain("SYNTHETIC-KIND-VALUE");
});
