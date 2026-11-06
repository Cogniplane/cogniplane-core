import { classifyMarkdownLink, describeImageHost } from "./safe-markdown.logic";

// Pure rules for the generated-UI renderers. Generated UI is agent-authored, so
// a URL in it follows the rules of agent-authored markdown: nothing loads
// until the user clicks, and a link opens only over HTTP(S) or inside the app.

/** The link that a generated component may render, or null when the value
 *  must show as text. Accepts HTTP(S), protocol-relative, same-origin
 *  relative, and `#` links. Rejects `javascript:`, `data:`, `mailto:`, and a
 *  value that is not a URL. */
export function safeLinkHref(href: string | undefined): string | null {
  if (!href) return null;
  const link = classifyMarkdownLink(href);
  return link.opensExternally || link.isAllowlistedHost ? href : null;
}

/** True when the link leaves the app, so it opens in a new tab and shows its host. */
export function opensExternally(href: string): boolean {
  return classifyMarkdownLink(href).opensExternally;
}

/** The host of a link that leaves the app, shown as text beside it. */
export function externalHost(href: string): string | null {
  const link = classifyMarkdownLink(href);
  return link.opensExternally && !link.isAllowlistedHost ? link.host : null;
}

/** The host label of a URL that the card shows as text, never as an image. */
export function hostLabel(url: string): string {
  return describeImageHost(url);
}

/** The first letter of the host, which stands in for a site icon that is not fetched. */
export function hostInitial(url: string): string {
  const host = classifyMarkdownLink(url).host ?? "";
  return /[a-z0-9]/i.test(host.charAt(0)) ? host.charAt(0).toUpperCase() : "?";
}

/** A coordinate as text with 4 decimals (about 11 m), or an empty string for a value that is not finite. */
export function formatCoordinate(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "";
}

/** "4.5 (120)" for a rating, or null without a rating. */
export function formatRating(rating: number | undefined, count: number | undefined): string | null {
  if (rating === undefined || !Number.isFinite(rating)) return null;
  const score = Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
  return count !== undefined && Number.isFinite(count) ? `${score} (${count})` : score;
}

/** A column count for a grid that the agent sizes. Between 1 and 4. */
export function gridColumns(columns: number | undefined): number {
  if (columns === undefined || !Number.isFinite(columns)) return 2;
  return Math.min(4, Math.max(1, Math.trunc(columns)));
}


// Paint values can become CSS backgrounds or SVG resource references. Accept
// static colors and catalog tokens, without CSS escapes, variables, or URLs.
export function safePaint(value: string): string | undefined {
  const trimmed = value.trim();
  return /^(?:[a-z][a-z0-9-]*|#[0-9a-f]{3,8}|(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([a-z0-9.%+,\s/-]+\))$/i.test(trimmed)
    ? trimmed : undefined;
}

export function safePaintProps(component: string, props: Record<string, unknown>): Record<string, unknown> {
  const result = { ...props };
  for (const [key, value] of Object.entries(result)) {
    if (/^(?:background|color|fill|stroke|.*Color|.*Background)$/.test(key) && typeof value === "string") {
      result[key] = safePaint(value);
    }
  }
  const nested = component === "Svg" ? ["paths", "circles", "rects", "lines", "texts"]
    : component === "Chart" ? ["series"] : [];
  for (const key of nested) {
    if (Array.isArray(result[key])) result[key] = result[key].map((item: unknown) =>
      typeof item === "object" && item !== null ? safePaintProps("", item as Record<string, unknown>) : item);
  }
  return result;
}
