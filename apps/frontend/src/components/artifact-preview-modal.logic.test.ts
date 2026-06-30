import { describe, expect, it } from "vitest";

import { getInertHtmlPreviewProps } from "./artifact-preview-modal.logic";

describe("getInertHtmlPreviewProps", () => {
  it("uses an empty sandbox with no script or same-origin permissions", () => {
    const preview = getInertHtmlPreviewProps("<p>Hello</p>");

    expect(preview.sandbox).toBe("");
    expect(preview.sandbox).not.toContain("allow-scripts");
    expect(preview.sandbox).not.toContain("allow-same-origin");
  });

  it("places a fail-closed CSP before the untrusted document", () => {
    const content = '<img src="https://attacker.example/exfil">';
    const preview = getInertHtmlPreviewProps(content);

    const cspIndex = preview.srcDoc.indexOf('http-equiv="Content-Security-Policy"');
    const contentIndex = preview.srcDoc.indexOf(content);
    expect(cspIndex).toBeGreaterThanOrEqual(0);
    expect(cspIndex).toBeLessThan(contentIndex);
    expect(preview.srcDoc).toContain("default-src 'none'");
    expect(preview.srcDoc).toContain("base-uri 'none'");
    expect(preview.srcDoc).toContain("form-action 'none'");
  });

  it("preserves the artifact HTML after the security prelude", () => {
    const content = "<!doctype html><html><body><h1>Report</h1></body></html>";

    expect(getInertHtmlPreviewProps(content).srcDoc.endsWith(content)).toBe(true);
  });
});
