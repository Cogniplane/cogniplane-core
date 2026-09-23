import Fastify from "fastify";

export async function createProxyMcpUpstream() {
  const upstreamRequests: Array<{
    headers: Record<string, string | string[] | undefined>;
    body: Record<string, unknown>;
    /** The body exactly as received, for signed body-hash checks. */
    rawBody: string;
  }> = [];

  const upstream = Fastify();
  // Keep the raw body next to the parsed one: the v2 proxy signature covers a
  // hash of the exact bytes sent.
  const rawBodies = new WeakMap<object, string>();
  upstream.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    try {
      rawBodies.set(request, body as string);
      done(null, JSON.parse(body as string));
    } catch (error) {
      done(error as Error, undefined);
    }
  });
  upstream.post("/", async (request) => {
    upstreamRequests.push({
      headers: request.headers,
      body: request.body as Record<string, unknown>,
      rawBody: rawBodies.get(request) ?? ""
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
