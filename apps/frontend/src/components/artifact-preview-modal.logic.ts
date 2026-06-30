const INERT_HTML_PREVIEW_CSP = [
  "default-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "style-src 'unsafe-inline'"
].join("; ");

/**
 * Agent-generated HTML is untrusted. The empty iframe sandbox disables
 * scripts, forms, popups, downloads, navigation, and same-origin access. The
 * CSP also blocks passive network requests such as images, fonts, media, and
 * external stylesheets; inline CSS remains available for useful previews.
 */
export function getInertHtmlPreviewProps(content: string): {
  sandbox: "";
  srcDoc: string;
} {
  const cspMeta = `<meta http-equiv="Content-Security-Policy" content="${INERT_HTML_PREVIEW_CSP}">`;
  return {
    sandbox: "",
    // Place the policy before all untrusted markup so it applies before the
    // parser encounters any attacker-controlled resource URL.
    srcDoc: `<!doctype html>${cspMeta}${content}`
  };
}
