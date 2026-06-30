import { describe, expect, it } from "vitest";

import { API_URL } from "../lib/api-client";
import {
  classifyMarkdownLink,
  describeImageHost,
  isTrustedImageSource
} from "./safe-markdown.logic";

describe("classifyMarkdownLink", () => {
  it("keeps relative and fragment links in the current browsing context", () => {
    expect(classifyMarkdownLink("/settings")).toEqual({
      opensExternally: false,
      isAllowlistedHost: true,
      host: null
    });
    expect(classifyMarkdownLink("#details").opensExternally).toBe(false);
  });

  it("opens allowlisted API links externally without warning", () => {
    expect(classifyMarkdownLink(`${API_URL}/downloads/abc123`)).toEqual({
      opensExternally: true,
      isAllowlistedHost: true,
      host: new URL(API_URL).host
    });
  });

  it("identifies non-allowlisted HTTP hosts for a visible warning", () => {
    expect(classifyMarkdownLink("https://attacker.example/path")).toEqual({
      opensExternally: true,
      isAllowlistedHost: false,
      host: "attacker.example"
    });
    expect(classifyMarkdownLink("//attacker.example/path")).toEqual({
      opensExternally: true,
      isAllowlistedHost: false,
      host: "attacker.example"
    });
  });

  it("does not mark non-HTTP schemes or malformed links for a new tab", () => {
    expect(classifyMarkdownLink("mailto:user@example.com").opensExternally).toBe(false);
    expect(classifyMarkdownLink("not a url").opensExternally).toBe(false);
  });
});

describe("isTrustedImageSource", () => {
  it("allows same-origin relative paths", () => {
    expect(isTrustedImageSource("/downloads/abc123")).toBe(true);
    expect(isTrustedImageSource("/artifacts/img.png")).toBe(true);
  });

  it("allows absolute URLs on the API origin", () => {
    expect(isTrustedImageSource(`${API_URL}/downloads/abc123`)).toBe(true);
  });

  it("rejects external hosts", () => {
    expect(isTrustedImageSource("https://attacker.example/log.png")).toBe(false);
    expect(isTrustedImageSource("http://attacker.example/log.png")).toBe(false);
  });

  it("rejects protocol-relative URLs", () => {
    expect(isTrustedImageSource("//attacker.example/log.png")).toBe(false);
  });

  it("rejects hosts that merely embed the API origin as a prefix", () => {
    const apiHost = new URL(API_URL).host;
    expect(isTrustedImageSource(`https://${apiHost}.attacker.example/x.png`)).toBe(false);
    expect(isTrustedImageSource(`https://attacker.example/${apiHost}/x.png`)).toBe(false);
  });

  it("rejects non-http schemes and unparseable sources", () => {
    expect(isTrustedImageSource("javascript:alert(1)")).toBe(false);
    expect(isTrustedImageSource("data:image/png;base64,AAAA")).toBe(false);
    expect(isTrustedImageSource("not a url")).toBe(false);
    expect(isTrustedImageSource("")).toBe(false);
  });
});

describe("describeImageHost", () => {
  it("returns the host for absolute URLs", () => {
    expect(describeImageHost("https://attacker.example/x.png")).toBe("attacker.example");
  });

  it("falls back for unparseable sources", () => {
    expect(describeImageHost("not a url")).toBe("unknown host");
  });
});
