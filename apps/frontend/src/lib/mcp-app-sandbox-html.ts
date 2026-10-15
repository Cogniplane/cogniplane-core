// This module has no imports. The sandbox Worker runs it through Node's type
// stripping in tests, which needs a file extension on each import.

/** JSON for the inside of an inline script. Escaping the characters that can
 *  end a script element or a line makes the text safe in HTML and in JS. */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function canonicalOrigin(value: string | null): string | null {
  if (value === null || !URL.canParse(value)) return null;
  return new URL(value).origin === value ? value : null;
}

/** The rules for a widget's content security policy sources, as script for the
 *  page. The page has no module loader, so it keeps its own copy of the parsing
 *  and matching rules of `@cogniplane/shared-types/csp-sources`. Both are tested
 *  with the same vectors. This copy has no public suffix list, so it has no
 *  wildcard-parent test. It rejects a wildcard over a single label, such as
 *  *.com. It does not decide on *.co.uk, *.github.io, or *.kobe.jp, whose
 *  children are suffixes. The page needs no such test. The backend is the
 *  authority: it checks each approved source with `isRegistrableWildcardParent`
 *  (`public-suffix.ts`, shared with the sandbox egress rules) before it saves
 *  the source, and again before it sends it. This page gives a widget only what
 *  it declared AND the host sent as approved, so a declaration that is not
 *  approved gets nothing.
 *  Keep this in step with the shared file. A change to one needs a change to both. */
const SOURCE_POLICY_SCRIPT = String.raw`  // A source is a scheme, a host, and a port. The host can start with *.
  const SPECIAL_USE = ["localhost", "local", "internal", "localdomain", "test", "invalid", "example",
    "onion", "alt", "arpa", "lan", "home", "corp", "intranet", "private"];
  const parseSource = (value, key) => {
    if (typeof value !== "string" || value.length === 0 || value.length > 300) return null;
    if (/[^\x21-\x7e]|[;,'"<>\\\`^|{}%]/.test(value)) return null;
    const match = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(value);
    if (!match) return null;
    const scheme = match[1].toLowerCase();
    if (scheme !== "https" && !(scheme === "wss" && key === "connectDomains")) return null;
    const authority = match[2];
    if (/[@\/?#\[]/.test(authority)) return null;
    let hostText = authority;
    let port = "";
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      hostText = authority.slice(0, colon);
      port = authority.slice(colon + 1);
      if (hostText.includes(":") || !/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65535) return null;
      if (port === "443") port = "";
    }
    let host = hostText.toLowerCase();
    const wildcard = host.startsWith("*.");
    if (wildcard) host = host.slice(2);
    const labels = host.split(".");
    if (host.length > 253 || labels.length < 2 ||
        labels.some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) return null;
    const top = labels[labels.length - 1];
    if (/^(?:[0-9]+|0x[0-9a-f]*)$/.test(top) || SPECIAL_USE.includes(top)) return null;
    return { scheme, wildcard, host, port,
      text: scheme + "://" + (wildcard ? "*." : "") + host + (port ? ":" + port : "") };
  };
  const covers = (approved, declared) => {
    if (approved.scheme !== declared.scheme || approved.port !== declared.port) return false;
    if (!approved.wildcard) return !declared.wildcard && declared.host === approved.host;
    return declared.host === approved.host ? declared.wildcard : declared.host.endsWith("." + approved.host);
  };
  // The declared sources of one list that the host also approved for that list.
  const allowedSources = (declared, approved, key) => {
    if (!Array.isArray(declared) || !Array.isArray(approved)) return [];
    const granted = approved.slice(0, 200).map((value) => parseSource(value, key)).filter(Boolean);
    const allowed = [];
    for (const value of declared.slice(0, 25)) {
      const source = parseSource(value, key);
      if (source && !allowed.includes(source.text) && granted.some((entry) => covers(entry, source))) {
        allowed.push(source.text);
      }
    }
    return allowed;
  };
  const sources = (csp, key) => allowedSources(csp && csp[key],
    csp && csp.approvedDomains && csp.approvedDomains[key], key).join(" ");`;

/** The sandbox proxy page. It talks to one parent origin: the host that the
 *  framing policy allows. Pass the result of `mcpAppParentOrigin`. A value that
 *  is not an origin, or no value, makes the page stop at start. */
export function buildMcpAppSandboxHtml(parentOrigin: string | null): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\">",
    "<head>",
    "  <meta charset=\"utf-8\">",
    "  <!-- The response CSP limits framing; the app CSP is inserted into srcdoc below. -->",
    "  <style>html,body{margin:0;width:100%;height:100%;overflow:hidden}iframe{display:block;width:100%;height:100%;border:0}</style>",
    "</head>",
    "<body>",
    "<script>",
    `  const parentOrigin = ${scriptSafeJson(canonicalOrigin(parentOrigin))};`,
    "  if (window.self === window.top) throw new Error(\"Frame only\");",
    "  if (typeof parentOrigin !== \"string\") throw new Error(\"Parent origin required\");",
    "  const inner = document.createElement(\"iframe\");",
    "  // App code gets an opaque origin. The proxy alone keeps its dedicated origin.",
    "  inner.setAttribute(\"sandbox\", \"allow-scripts\");",
    "  inner.setAttribute(\"title\", \"Interactive tool view\");",
    "  document.body.append(inner);",
    "",
    SOURCE_POLICY_SCRIPT,
    "  const cspFor = (declared = {}) => {",
    "    const resources = sources(declared, \"resourceDomains\");",
    "    const connections = sources(declared, \"connectDomains\");",
    "    const frames = sources(declared, \"frameDomains\");",
    "    const bases = sources(declared, \"baseUriDomains\");",
    "    return [",
    "      \"default-src 'none'\",",
    "      `script-src 'self' 'unsafe-inline' ${resources}`,",
    "      `style-src 'self' 'unsafe-inline' ${resources}`,",
    "      `img-src 'self' data: ${resources}`,",
    "      `font-src 'self' data: ${resources}`,",
    "      `media-src 'self' data: ${resources}`,",
    "      `connect-src ${connections || \"'none'\"}`,",
    "      `frame-src ${frames || \"'none'\"}`,",
    "      `base-uri ${bases || \"'self'\"}`,",
    "      \"object-src 'none'\",",
    "      \"form-action 'none'\"",
    "    ].join(\"; \");",
    "  };",
    "  window.addEventListener(\"message\", (event) => {",
    "    if (event.source === window.parent) {",
    "      // The parent window must also have the configured origin.",
    "      if (event.origin !== parentOrigin) return;",
    "      if (event.data?.method === \"ui/notifications/sandbox-resource-ready\") {",
    "        const { html, csp } = event.data.params ?? {};",
    "        if (typeof html !== \"string\") return;",
    "        // The outer frame policy also governs navigation of the app iframe itself.",
    "        // Install it before srcdoc runs. Keep declared proxy-app frame permissions.",
    "        const framePolicy = document.createElement(\"meta\");",
    "        framePolicy.httpEquiv = \"Content-Security-Policy\";",
    "        framePolicy.content = `frame-src ${sources(csp, \"frameDomains\") || \"'none'\"}`;",
    "        document.head.append(framePolicy);",
    "        const documentForView = new DOMParser().parseFromString(html, \"text/html\");",
    "        const meta = documentForView.createElement(\"meta\");",
    "        meta.httpEquiv = \"Content-Security-Policy\";",
    "        meta.content = cspFor(csp);",
    "        documentForView.head.prepend(meta);",
    "        inner.srcdoc = `<!doctype html>${documentForView.documentElement.outerHTML}`;",
    "      } else if (inner.contentWindow && !event.data?.method?.startsWith(\"ui/notifications/sandbox-\")) {",
    "        // The inner frame has an opaque origin. Only \"*\" can address it.",
    "        inner.contentWindow.postMessage(event.data, \"*\");",
    "      }",
    "    } else if (event.source === inner.contentWindow && !event.data?.method?.startsWith(\"ui/notifications/sandbox-\")) {",
    "      window.parent.postMessage(event.data, parentOrigin);",
    "    }",
    "  });",
    "  window.parent.postMessage({ jsonrpc: \"2.0\", method: \"ui/notifications/sandbox-proxy-ready\", params: {} }, parentOrigin);",
    "</script>",
    "</body>",
    "</html>",
    "",
  ].join("\n");
}
