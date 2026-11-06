import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  __resetIntegrationRegistryForTesting,
  getIntegrationDescriptor
} from "../../../../apps/backend/src/services/integrations/integration-registry.js";
import { registerMicrosoftDescriptor } from "./register-microsoft-descriptor.js";

describe("registerMicrosoftDescriptor", () => {
  const originalEnv = process.env.MICROSOFT_OAUTH_REDIRECT_URI;

  beforeEach(() => {
    __resetIntegrationRegistryForTesting();
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.MICROSOFT_OAUTH_REDIRECT_URI = originalEnv;
    } else {
      delete process.env.MICROSOFT_OAUTH_REDIRECT_URI;
    }
    __resetIntegrationRegistryForTesting();
  });

  it("registers descriptor with unconfigured status when redirect URI is unset", () => {
    delete process.env.MICROSOFT_OAUTH_REDIRECT_URI;
    registerMicrosoftDescriptor();

    const descriptor = getIntegrationDescriptor("microsoft");
    expect(descriptor).not.toBeNull();
    expect(descriptor?.id).toBe("microsoft");
    expect(descriptor?.platformStatus).toBeDefined();

    const status = descriptor?.platformStatus?.({} as never);
    expect(status).toEqual({
      configured: false,
      message: "MICROSOFT_OAUTH_REDIRECT_URI is not configured."
    });
  });

  it("registers descriptor with configured status when redirect URI is set", () => {
    process.env.MICROSOFT_OAUTH_REDIRECT_URI = "https://app.example.com/callback";
    registerMicrosoftDescriptor();

    const descriptor = getIntegrationDescriptor("microsoft");
    expect(descriptor).not.toBeNull();

    const status = descriptor?.platformStatus?.({} as never);
    expect(status).toEqual({
      configured: true,
      message: null
    });
  });
});
