import { buildMcpAppSandboxHtml } from "../src/lib/mcp-app-sandbox-html.ts";
import { mcpAppParentOrigin, sandboxSecurityHeaders } from "../src/lib/mcp-app-sandbox-headers.ts";

export default {
  fetch(request: Request, env: Env): Response {
    if (new URL(request.url).pathname !== "/mcp-app-sandbox.html") {
      return new Response("Not found", { status: 404 });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
    }

    const headers = sandboxSecurityHeaders(env.MCP_APP_PARENT_ORIGIN);
    headers.set("content-type", "text/html; charset=utf-8");
    headers.set("cache-control", "no-store");
    const html = request.method === "HEAD" ? null : buildMcpAppSandboxHtml(mcpAppParentOrigin(env.MCP_APP_PARENT_ORIGIN));
    return new Response(html, { headers });
  }
};
