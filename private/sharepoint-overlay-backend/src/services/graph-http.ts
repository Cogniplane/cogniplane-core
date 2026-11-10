/** The longest wait for one Microsoft identity or Graph JSON request. */
export const MICROSOFT_REQUEST_TIMEOUT_MS = 15_000;

/** The longest wait for the download of an imported file, body included. */
export const MICROSOFT_DOWNLOAD_TIMEOUT_MS = 120_000;

export function buildGraphHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json"
  };
}
