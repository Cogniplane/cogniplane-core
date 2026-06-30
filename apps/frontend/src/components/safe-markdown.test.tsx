// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { API_URL } from "../lib/api-client";
import { SafeMarkdown } from "./safe-markdown";

afterEach(cleanup);

describe("SafeMarkdown links", () => {
  it("opens external links safely and identifies non-allowlisted hosts", async () => {
    render(<SafeMarkdown>{"[Vendor docs](https://vendor.example/docs)"}</SafeMarkdown>);

    // react-markdown is lazy-loaded, so the link appears after the chunk resolves.
    const link = await screen.findByRole("link", { name: /Vendor docs/ });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("[external: vendor.example]");
  });

  it("does not warn for allowlisted API links", async () => {
    render(<SafeMarkdown>{`[Download](${API_URL}/downloads/file)`}</SafeMarkdown>);

    const link = await screen.findByRole("link", { name: "Download" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).not.toContain("external:");
  });

  it("keeps relative links in the current browsing context", async () => {
    render(<SafeMarkdown>{"[Settings](/settings)"}</SafeMarkdown>);

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.hasAttribute("rel")).toBe(false);
  });
});
