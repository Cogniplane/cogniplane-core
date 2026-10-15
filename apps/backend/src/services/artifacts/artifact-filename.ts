// Artifact file names come from users, tools, and imports. Two jobs live here so
// every entry point agrees on them: refuse names that must never be stored, and
// turn a stored name into a safe suggested download name. A stored name is only
// a label (storage keys are generated), but it reaches headers and UI.

const DEFAULT_DOWNLOAD_NAME = "download";
// Common file system limit; counted in UTF-8 bytes, not characters.
const MAX_DOWNLOAD_NAME_BYTES = 255;
// A real extension is short and plain. Anything else is part of the name.
const EXTENSION = /\.[A-Za-z0-9_-]{1,16}$/;

// C0 controls (NUL included), DEL, and C1 controls.
function isControlCodePoint(code: number): boolean {
  return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
}

// Bidirectional embedding, override, and isolate controls. They can make a name
// display with a different extension.
function isBidiControlCodePoint(code: number): boolean {
  return (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
}

/**
 * Check a name that is about to be stored. Returns a message for the caller, or
 * null when the name is acceptable. The message never echoes the name.
 *
 * Path separators are allowed here: the download path reduces a name to its
 * basename. Control characters are not: NUL fails in PostgreSQL text, and the
 * others have no place in a file name.
 */
export function validateArtifactFilename(name: string): string | null {
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (code === 0) return "Artifact name must not contain NUL characters.";
    if (isControlCodePoint(code)) return "Artifact name must not contain control characters.";
    if (isBidiControlCodePoint(code)) {
      return "Artifact name must not contain bidirectional override characters.";
    }
  }
  return null;
}

/**
 * Thrown by `assertValidArtifactFilename`. `statusCode` and `code` follow the
 * convention of app errors the caller can fix: `handleAppError` answers 400
 * with this code and message, and the tool gateway relays the message. A route
 * that catches errors by class (as the Microsoft import route does) still
 * lets it reach that handler. The message never echoes the name.
 */
export class InvalidArtifactFilenameError extends Error {
  readonly code = "invalid_filename";
  readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = "InvalidArtifactFilenameError";
  }
}

/** `validateArtifactFilename`, as a typed error for code with no reply to shape. */
export function assertValidArtifactFilename(name: string): void {
  const problem = validateArtifactFilename(name);
  if (problem) throw new InvalidArtifactFilenameError(problem);
}

// Remove characters a stored name should never have carried (legacy rows can
// hold them) and make the string well formed so it always encodes.
function removeUnsafeCharacters(name: string): string {
  let result = "";
  for (const char of name) {
    const code = char.codePointAt(0) as number;
    if (isControlCodePoint(code) || isBidiControlCodePoint(code)) continue;
    // A lone surrogate cannot be percent-encoded.
    result += code >= 0xd800 && code <= 0xdfff ? "\ufffd" : char;
  }
  return result;
}

// Cut the stem so that stem + extension fit the byte limit, on a code point
// boundary. The extension is kept.
function capLength(stem: string, extension: string): string {
  const budget = MAX_DOWNLOAD_NAME_BYTES - Buffer.byteLength(extension, "utf8");
  if (Buffer.byteLength(stem, "utf8") <= budget) return `${stem}${extension}`;
  let kept = "";
  let used = 0;
  for (const char of stem) {
    const size = Buffer.byteLength(char, "utf8");
    if (used + size > budget) break;
    kept += char;
    used += size;
  }
  return `${kept.trimEnd()}${extension}`;
}

/**
 * Reduce a stored name to one safe basename for a suggested download name.
 *
 * Both `\` and `/` separate path segments, so a Windows path does not survive on
 * a POSIX client. The last non-empty segment is kept. Control and bidirectional
 * characters are dropped. The result is never empty and never only dots: such a
 * name becomes "download", keeping a plain extension if the name had one. The
 * result is capped to 255 UTF-8 bytes and keeps its extension.
 */
export function safeDownloadFilename(fileName: string): string {
  const segments = removeUnsafeCharacters(fileName)
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
  const base = segments[segments.length - 1] ?? "";
  if (/^\.*$/.test(base)) return DEFAULT_DOWNLOAD_NAME;

  const extension = EXTENSION.exec(base)?.[0] ?? "";
  const stem = base.slice(0, base.length - extension.length);
  if (/^\.+$/.test(stem)) return `${DEFAULT_DOWNLOAD_NAME}${extension}`;
  return capLength(stem, extension);
}

// ASCII-only form for the plain `filename` parameter: older clients read only
// that one. Quotes, backslash, and semicolon would break the quoted string.
function asciiFallback(name: string): string {
  return name.replace(/[^\x20-\x7e]|["\\;]/gu, "_");
}

// RFC 8187 `value-chars`. encodeURIComponent leaves `'()*` bare, but they are
// not attr-chars (the quote also delimits the language tag).
function encodeExtValue(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/**
 * Content-Disposition value for a file download. `filename` and `filename*`
 * both come from the same safe basename; `filename` is its ASCII form.
 */
export function attachmentContentDisposition(fileName: string): string {
  const safeName = safeDownloadFilename(fileName);
  return `attachment; filename="${asciiFallback(safeName)}"; filename*=UTF-8''${encodeExtValue(safeName)}`;
}
