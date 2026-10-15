function encodedPattern(value: string): RegExp {
  const tokens = value.match(/%[0-9a-fA-F]{2}|./g) ?? [];
  const pattern = tokens.map((token) => token.startsWith("%") && token.length === 3
    ? `%[${token[1]!.toLowerCase()}${token[1]!.toUpperCase()}][${token[2]!.toLowerCase()}${token[2]!.toUpperCase()}]`
    : token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
  return new RegExp(pattern, "g");
}

/**
 * Remove an MCP server's upstream secret (personal or organization) from a
 * value, in raw and URL-encoded form, in both keys and strings. An upstream
 * that echoes its credential must not pass it to the model, a transcript or
 * telemetry. Pattern-based redaction cannot find an opaque secret.
 */
export function scrubUpstreamCredential<T>(value: T, secret: string | null | undefined): T {
  if (!secret) return value;
  const wellFormedSecret = Array.from(secret, (character) => {
    const code = character.charCodeAt(0);
    return character.length === 1 && code >= 0xD800 && code <= 0xDFFF ? "\uFFFD" : character;
  }).join("");
  const uri = encodeURIComponent(wellFormedSecret);
  const form = new URLSearchParams([["credential", secret]]).toString().slice("credential=".length);
  const patterns = [...new Set([uri, form])].filter((encoded) => encoded !== secret).map(encodedPattern);
  const redactString = (text: string): string => {
    let redacted = text.replaceAll(secret, "[REDACTED]");
    for (const pattern of patterns) redacted = redacted.replace(pattern, "[REDACTED]");
    return redacted;
  };
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") return redactString(item);
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, child]) => [redactString(key), visit(child)]));
    }
    return item;
  };
  return visit(value) as T;
}

/**
 * Scrub the values of a fixed-shape object but keep its own keys, so a short
 * secret that equals a field name (`code`, `message`, `tools`) cannot rename a
 * protocol field. Nested keys are still scrubbed: an upstream can echo the
 * secret as a key.
 */
export function scrubUpstreamCredentialValues<T extends Record<string, unknown>>(
  value: T,
  secret: string | null | undefined
): T {
  if (!secret) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, scrubUpstreamCredential(item, secret)])
  ) as T;
}
