import { API_URL } from "../lib/api-client";

const API_ORIGIN = new URL(API_URL).origin;

// Same-origin relative path. "//host/path" is protocol-relative (an external
// host in disguise), not a relative path.
function isRelativePath(value: string): boolean {
  return value.startsWith("/") && !value.startsWith("//");
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export type MarkdownLinkDisposition = {
  opensExternally: boolean;
  isAllowlistedHost: boolean;
  host: string | null;
};

export function classifyMarkdownLink(href: string | undefined): MarkdownLinkDisposition {
  if (!href || isRelativePath(href) || href.startsWith("#")) {
    return { opensExternally: false, isAllowlistedHost: true, host: null };
  }

  // Protocol-relative ("//host/path") is an absolute URL on an external host;
  // resolve it as HTTPS so it classifies like any other absolute link.
  const parsed = parseUrl(href.startsWith("//") ? `https:${href}` : href);
  if (!parsed) {
    return { opensExternally: false, isAllowlistedHost: false, host: null };
  }

  const opensExternally = parsed.protocol === "http:" || parsed.protocol === "https:";
  return {
    opensExternally,
    isAllowlistedHost: opensExternally && parsed.origin === API_ORIGIN,
    host: opensExternally ? parsed.host : null
  };
}

// Markdown rendered by SafeMarkdown is agent-authored, so an image URL is
// attacker-influencable via prompt injection. Auto-fetching an external image
// exfiltrates whatever the agent encoded into the URL with zero user
// interaction, so only sources we host may render inline; everything else must
// require a deliberate click. Fail closed: anything unparseable (including
// protocol-relative sources) is untrusted.
export function isTrustedImageSource(src: string): boolean {
  if (isRelativePath(src)) return true;
  const parsed = parseUrl(src);
  return parsed !== null && parsed.origin === API_ORIGIN;
}

// Best-effort host label for the click-through link shown in place of an
// untrusted image. The caller never renders this as a URL, only as text.
// Protocol-relative ("//host/path") resolves as HTTPS, as classifyMarkdownLink does.
function parseImageSource(src: string): URL | null {
  return parseUrl(src.startsWith("//") ? `https:${src}` : src);
}

export function describeImageHost(src: string): string {
  // A data: or other host-less URL parses with an empty host.
  return parseImageSource(src)?.host || "unknown host";
}

// Only an HTTP(S) URL may become a click-through link. Other schemes (data:,
// blob:, javascript:, …) are shown as text.
export function isLinkableImageSource(src: string): boolean {
  const protocol = parseImageSource(src)?.protocol;
  return protocol === "http:" || protocol === "https:";
}
