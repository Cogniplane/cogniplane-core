// Microsoft Graph IDs (drive, item, parent, folder, site) are interpolated
// directly into Graph API URLs. They must be validated before URL construction
// because LLM-supplied or HTTP-supplied values can otherwise carry `/`, `?`,
// `&`, `:`, `#` or other URL-meaningful characters that pivot the request to
// a different Graph endpoint under the user's Microsoft token.
//
// Pattern allows the union of:
//   - drive/item/parent/folder IDs: typically base64url-ish, e.g. "b!AbCdEf..."
//   - composite site IDs: "contoso.sharepoint.com,<guid>,<guid>"
// It explicitly rejects URL-meaningful characters and whitespace.
export const GRAPH_ID_PATTERN = /^[A-Za-z0-9!,._-]+$/;

// A value of only dots ("." or "..") matches the pattern, but the URL parser of
// fetch removes it as a dot segment, and the request goes to another Graph path.
const DOT_SEGMENT = /^\.+$/;

export function isValidGraphId(value: string): boolean {
  return GRAPH_ID_PATTERN.test(value) && !DOT_SEGMENT.test(value);
}

export class MicrosoftInvalidIdError extends Error {
  readonly field: string;
  constructor(field: string) {
    super(`Invalid Microsoft Graph ID for "${field}". Must match ${GRAPH_ID_PATTERN} and not be only dots.`);
    this.field = field;
    this.name = "MicrosoftInvalidIdError";
  }
}

export function assertValidGraphId(value: string, field: string): void {
  if (!isValidGraphId(value)) {
    throw new MicrosoftInvalidIdError(field);
  }
}
