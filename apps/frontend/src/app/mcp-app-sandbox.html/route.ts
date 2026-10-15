import { buildMcpAppSandboxHtml } from "../../lib/mcp-app-sandbox-html";
import { mcpAppParentOrigin, sandboxSecurityHeaders } from "../../lib/mcp-app-sandbox-headers";

export function GET(): Response {
  const headers = sandboxSecurityHeaders(process.env.MCP_APP_PARENT_ORIGIN);
  headers.set("content-type", "text/html; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(buildMcpAppSandboxHtml(mcpAppParentOrigin(process.env.MCP_APP_PARENT_ORIGIN)), { headers });
}
