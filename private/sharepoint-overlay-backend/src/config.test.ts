import { describe, expect, it } from "vitest";
import { loadOverlayConfig } from "./config.js";

describe("loadOverlayConfig", () => {
  it("loads undefined when MICROSOFT_OAUTH_REDIRECT_URI is not set", () => {
    const config = loadOverlayConfig({});
    expect(config.MICROSOFT_OAUTH_REDIRECT_URI).toBeUndefined();
  });

  it("treats empty MICROSOFT_OAUTH_REDIRECT_URI as undefined", () => {
    const config = loadOverlayConfig({ MICROSOFT_OAUTH_REDIRECT_URI: "" });
    expect(config.MICROSOFT_OAUTH_REDIRECT_URI).toBeUndefined();
  });

  it("loads valid MICROSOFT_OAUTH_REDIRECT_URI", () => {
    const config = loadOverlayConfig({
      MICROSOFT_OAUTH_REDIRECT_URI: "https://app.example.com/api/v1/integrations/microsoft/oauth/callback"
    });
    expect(config.MICROSOFT_OAUTH_REDIRECT_URI).toBe(
      "https://app.example.com/api/v1/integrations/microsoft/oauth/callback"
    );
  });

  it("throws for invalid MICROSOFT_OAUTH_REDIRECT_URI", () => {
    expect(() =>
      loadOverlayConfig({ MICROSOFT_OAUTH_REDIRECT_URI: "not-a-valid-url" })
    ).toThrow();
  });
});
