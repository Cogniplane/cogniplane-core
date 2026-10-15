export function mcpAppSandboxOrigin(appOrigin?: string): string | null {
  const raw = process.env.NEXT_PUBLIC_MCP_APP_SANDBOX_ORIGIN;
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || (url.protocol !== "https:" && !(local && url.protocol === "http:"))) {
      return null;
    }
    return url.origin === appOrigin ? null : url.origin;
  } catch {
    return null;
  }
}
