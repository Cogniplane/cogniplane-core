import Fastify from "fastify";

export async function createProxyMcpUpstream() {
  const upstreamRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
  }> = [];

  const upstream = Fastify();
  upstream.post("/", async (request) => {
    upstreamRequests.push({
      headers: request.headers,
      body: request.body as Record<string, unknown>
    });

    const body = request.body as {
      id?: string | number;
      params?: {
        arguments?: Record<string, unknown>;
      };
    };

    return {
      jsonrpc: "2.0",
      id: body.id ?? null,
      result: {
        isError: false,
        structuredContent: {
          echoedArguments: body.params?.arguments ?? {}
        }
      }
    };
  });

  const upstreamUrl = await upstream.listen({ port: 0, host: "127.0.0.1" });

  return {
    upstream,
    upstreamUrl,
    upstreamRequests
  };
}
