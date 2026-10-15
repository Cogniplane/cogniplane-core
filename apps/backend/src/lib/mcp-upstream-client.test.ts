import { test, expect, vi } from "vitest";
import { createServer } from "node:http";
import type { fetch as undiciFetch } from "undici";

import { forwardRpc, isReservedMcpUpstreamHeader } from "./mcp-upstream-client.js";

test("reserves every framework identity and signature header", () => {
  expect(isReservedMcpUpstreamHeader("X-Framework-Nonce")).toBe(true);
  expect(isReservedMcpUpstreamHeader("x-framework-body-sha256")).toBe(true);
  expect(isReservedMcpUpstreamHeader("X-Framework-Signature-Version")).toBe(true);
  expect(isReservedMcpUpstreamHeader("X-Api-Key")).toBe(false);
});

// A proxy MCP upstream URL is admin-supplied, and several MCP vendors
// authenticate by API key in the query string. On a transport failure the
// client logs which upstream failed — these tests pin that the log record
// carries the origin plus the serverId (what an operator needs) and never the
// query, userinfo or path (where a credential can hide). Central
// redactSecrets() does not cover this: it redacts tool results and persisted
// errors, not logger fields.

const payload = { jsonrpc: "2.0" as const, id: 1, method: "tools/call" };

function loggerSpy() {
  const warn = vi.fn();
  return { logger: { warn }, warn };
}

/**
 * Every string a log record could carry, including the places a naive
 * `JSON.stringify` cannot reach.
 *
 * This matters: `Error.prototype.message` and `.stack` are NON-ENUMERABLE, so
 * `JSON.stringify({ error })` yields `{"error":{}}` and would report a clean
 * record even while pino's error serializer prints the message in full. An
 * assertion built on JSON alone passes for the wrong reason.
 */
function loggedStrings(fields: Record<string, unknown>): string {
  const parts: string[] = [JSON.stringify(fields)];
  for (const value of Object.values(fields)) {
    if (value instanceof Error) {
      parts.push(value.name, value.message, String(value.stack));
      const cause = value.cause;
      if (cause instanceof Error) {
        parts.push(cause.name, cause.message, String(cause.stack));
      } else if (cause !== undefined) {
        parts.push(String(cause));
      }
      // Own properties too, enumerable or not.
      for (const key of Object.getOwnPropertyNames(value)) {
        parts.push(String((value as unknown as Record<string, unknown>)[key]));
      }
    } else {
      parts.push(String(value));
    }
  }
  return parts.join(" ");
}

/** Guard the guard: the helper must actually see a non-enumerable message. */
test("loggedStrings sees what JSON.stringify cannot", () => {
  const fields = { error: new Error("boom SEKRET") };
  expect(JSON.stringify(fields)).not.toContain("SEKRET");
  expect(loggedStrings(fields)).toContain("SEKRET");
});

/** A fetch that always fails the way a refused or unreachable upstream does. */
const failingFetch = (() =>
  Promise.reject(
    Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED 203.0.113.1:443"), {
        code: "ECONNREFUSED"
      })
    })
  )) as unknown as typeof undiciFetch;

test("does not log the upstream query string on transport failure", async () => {
  const { logger, warn } = loggerSpy();

  await forwardRpc(
    "https://mcp.example.com/rpc?api_key=SEKRET",
    payload,
    {},
    failingFetch,
    { logger }
  );

  expect(warn).toHaveBeenCalledTimes(1);
  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.upstreamOrigin).toBe("https://mcp.example.com");
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test("redacts a query parameter whose name no allowlist would know", async () => {
  // The vendor picks the parameter name, so matching on known-sensitive names
  // (sanitize-url.ts's approach, correct for our own inbound routes) cannot
  // work here. The whole query goes.
  const { logger, warn } = loggerSpy();

  await forwardRpc(
    "https://mcp.example.com/rpc?zzz_vendor_specific=SEKRET",
    payload,
    {},
    failingFetch,
    { logger }
  );

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test("never logs the raw error object", async () => {
  // undici composes some messages from the request URL, and message/stack are
  // non-enumerable, so the whole error is kept out of the record rather than
  // trusted to redact. Only an allowlisted classification is logged.
  const { logger, warn } = loggerSpy();
  const urlEchoingFetch = (() =>
    Promise.reject(
      new TypeError(
        "Request cannot be constructed from a URL that includes credentials: " +
          "https://user:pw@mcp.example.com/rpc?api_key=SEKRET"
      )
    )) as unknown as typeof undiciFetch;

  await forwardRpc("https://mcp.example.com/rpc", payload, {}, urlEchoingFetch, { logger });

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.error).toBeUndefined();
  expect(loggedStrings(fields)).not.toContain("SEKRET");
  expect(loggedStrings(fields)).not.toContain("user:pw");
});

test("logs an allowlisted transport code and drops an unrecognised one", async () => {
  const { logger, warn } = loggerSpy();
  await forwardRpc("https://mcp.example.com/rpc", payload, {}, failingFetch, { logger });
  expect((warn.mock.calls[0] as [Record<string, unknown>, string])[0].errorCode).toBe(
    "ECONNREFUSED"
  );

  const { logger: logger2, warn: warn2 } = loggerSpy();
  const oddFetch = (() =>
    Promise.reject(
      Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("nope"), { code: "E_SECRET_LOOKING_SEKRET" })
      })
    )) as unknown as typeof undiciFetch;
  await forwardRpc("https://mcp.example.com/rpc", payload, {}, oddFetch, { logger: logger2 });
  const [fields2] = warn2.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields2.errorCode).toBe("other");
  expect(loggedStrings(fields2)).not.toContain("SEKRET");
});

test("still logs enough to identify which upstream failed", async () => {
  const { logger, warn } = loggerSpy();

  await forwardRpc("https://mcp.example.com:8443/a/rpc", payload, {}, failingFetch, {
    logger
  });

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.upstreamOrigin).toBe("https://mcp.example.com:8443");
  expect(fields.method).toBe("tools/call");
  expect(fields.timedOut).toBe(false);
  expect(fields.errorName).toBe("TypeError");
});

test("marks a timeout distinctly and still hides the query", async () => {
  const { logger, warn } = loggerSpy();
  const timingOutFetch = (() =>
    Promise.reject(
      Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError"
      })
    )) as unknown as typeof undiciFetch;

  const response = await forwardRpc(
    "https://mcp.example.com/rpc?token=SEKRET",
    payload,
    {},
    timingOutFetch,
    { logger, timeoutMs: 1234 }
  );

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.timedOut).toBe(true);
  expect(loggedStrings(fields)).not.toContain("SEKRET");
  // The model-visible message stays a fixed string naming only the budget.
  expect(response.error?.message).toBe("Upstream MCP request timed out after 1234ms.");
});

test("the model-visible error never carries the upstream URL", async () => {
  const { logger } = loggerSpy();

  const response = await forwardRpc(
    "https://mcp.example.com/rpc?api_key=SEKRET",
    payload,
    {},
    failingFetch,
    { logger }
  );

  expect(response.error?.message).toBe("Upstream MCP request failed.");
  expect(JSON.stringify(response)).not.toContain("SEKRET");
  expect(JSON.stringify(response)).not.toContain("mcp.example.com");
});

test("rejects a same-origin redirect that reintroduces credentials", async () => {
  // The blocker the write-time schema does NOT cover: a redirect target comes
  // from a Location header, so it never passed validation. Same origin, same
  // host, so every other check here accepts it — and undici would then throw
  // a TypeError quoting the whole credentialed URL.
  const { logger } = loggerSpy();
  const redirectingFetch = vi.fn(() =>
    Promise.resolve({
      status: 302,
      ok: false,
      headers: new Headers({ location: "https://user:pw@mcp.example.com/next?key=SEKRET" }),
      body: null
    })
  ) as unknown as typeof undiciFetch;

  const response = await forwardRpc(
    "https://mcp.example.com/rpc",
    payload,
    {},
    redirectingFetch,
    { logger }
  );

  expect(response.error?.message).toBe("Upstream MCP redirect must not embed credentials.");
  // Refused before a second request could be attempted with that URL.
  expect(redirectingFetch).toHaveBeenCalledTimes(1);
});

// NEW-2 from the second review: classification reads name/cause/cause.code,
// any of which can be a getter on a non-undici transport. A getter that throws
// must not escape into the caller's catch, where a default handler would log
// the error in full and reinstate the leak.

test("survives an error whose getters throw, without leaking", async () => {
  const { logger, warn } = loggerSpy();
  const hostile = new TypeError("placeholder");
  Object.defineProperty(hostile, "name", {
    get() {
      throw new Error("boom https://mcp.example.com/rpc?api_key=SEKRET");
    }
  });
  Object.defineProperty(hostile, "cause", {
    get() {
      throw new Error("boom SEKRET");
    }
  });
  const hostileFetch = (() => Promise.reject(hostile)) as unknown as typeof undiciFetch;

  // The turn still gets a clean JSON-RPC failure rather than a thrown error.
  const response = await forwardRpc(
    "https://mcp.example.com/rpc?api_key=SEKRET",
    payload,
    {},
    hostileFetch,
    { logger }
  );

  expect(response.error?.message).toBe("Upstream MCP request failed.");
  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.errorName).toBe("unknown");
  expect(fields.errorCode).toBe("unknown");
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test("does not log an error name composed from the URL", async () => {
  // A custom transport could put request data in `name`, which is logged
  // unfiltered — so the name is allowlisted the same way the code is.
  const { logger, warn } = loggerSpy();
  const named = Object.assign(new Error("x"), {
    name: "FailedTo_https://user:pw@mcp.example.com/rpc?api_key=SEKRET"
  });
  const namedFetch = (() => Promise.reject(named)) as unknown as typeof undiciFetch;

  await forwardRpc("https://mcp.example.com/rpc", payload, {}, namedFetch, { logger });

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.errorName).toBe("other");
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test("classifies a non-Error rejection without throwing", async () => {
  const { logger, warn } = loggerSpy();
  const stringFetch = (() =>
    Promise.reject("plain string SEKRET")) as unknown as typeof undiciFetch;

  const response = await forwardRpc("https://mcp.example.com/rpc", payload, {}, stringFetch, {
    logger
  });

  expect(response.error?.message).toBe("Upstream MCP request failed.");
  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  // A non-Error has no name to allowlist, so it lands in the same "other"
  // bucket as an unrecognised one — the classifier emits allowlisted strings
  // only, never a value derived from the rejection.
  expect(fields.errorName).toBe("other");
  expect(fields.errorCode).toBe("none");
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test("logs the undici codes a real deployment actually hits", async () => {
  // NEW-3: these are defined by undici 8.x and were missing from the first
  // allowlist, so genuine failures logged as the useless string "other".
  for (const code of [
    "UND_ERR_HEADERS_OVERFLOW",
    "UND_ERR_RES_CONTENT_LENGTH_MISMATCH",
    "UND_ERR_RES_EXCEEDED_MAX_SIZE",
    "UND_ERR_ABORTED"
  ]) {
    const { logger, warn } = loggerSpy();
    const codedFetch = (() =>
      Promise.reject(
        Object.assign(new TypeError("fetch failed"), {
          cause: Object.assign(new Error("x"), { code })
        })
      )) as unknown as typeof undiciFetch;

    await forwardRpc("https://mcp.example.com/rpc", payload, {}, codedFetch, { logger });

    const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
    expect(fields.errorCode).toBe(code);
  }
});

test("logs the serverId, which is what identifies the upstream once the path is gone", async () => {
  // Dropping the pathname costs nothing operationally BECAUSE of this field:
  // two servers on one origin are told apart by id, and an id cannot carry a
  // credential the way `/keys/<API_KEY>/rpc` can.
  const { logger, warn } = loggerSpy();

  await forwardRpc(
    "https://mcp.example.com/keys/SEKRET/rpc",
    payload,
    {},
    failingFetch,
    { logger, serverId: "srv-vendor-a" }
  );

  const [fields] = warn.mock.calls[0] as [Record<string, unknown>, string];
  expect(fields.serverId).toBe("srv-vendor-a");
  expect(fields.upstreamOrigin).toBe("https://mcp.example.com");
  expect(loggedStrings(fields)).not.toContain("SEKRET");
});

test.each([
  "http://127.0.0.1:8080/mcp",
  "http://10.0.4.17/mcp",
  "http://100.108.24.234:3108/mcp"
])("forwards to a configured local address at %s", async (upstreamUrl) => {
  const reached = vi.fn(async () => new Response(
    JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }),
    { headers: { "content-type": "application/json" } }
  ));
  const response = await forwardRpc(
    upstreamUrl, payload, {}, reached as unknown as typeof undiciFetch
  );
  expect(response.result).toEqual({ ok: true });
  expect(reached).toHaveBeenCalledTimes(1);
});

test("refuses a stored upstream embedding credentials", async () => {
  const neverCalled = vi.fn();
  const response = await forwardRpc(
    "https://user:pw@vendor.example/mcp",
    payload,
    {},
    neverCalled as unknown as typeof undiciFetch,
    {}
  );

  expect(response.error?.message).toBe("Upstream MCP URL must not embed credentials.");
  expect(neverCalled).not.toHaveBeenCalled();
});

test("refuses a non-HTTP scheme", async () => {
  const neverCalled = vi.fn();
  const response = await forwardRpc(
    "file:///etc/passwd",
    payload,
    {},
    neverCalled as unknown as typeof undiciFetch,
    {}
  );

  expect(response.error?.message).toBe("Upstream MCP URL must use HTTP(S).");
  expect(neverCalled).not.toHaveBeenCalled();
});

test("still allows an ordinary public upstream through to the transport", async () => {
  const reached = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
  await forwardRpc(
    "https://vendor.example/mcp",
    payload,
    {},
    reached as unknown as typeof undiciFetch,
    {}
  );

  expect(reached).toHaveBeenCalledTimes(1);
});

test.each([
  {
    label: "bearer token",
    auth: { type: "bearer", secret: "bearer-secret" } as const,
    assertRequest: (url: URL, headers: Record<string, string>) => {
      expect(url.toString()).toBe("https://vendor.example/mcp?region=ca");
      expect(headers.Authorization).toBe("Bearer bearer-secret");
    }
  },
  {
    label: "custom header",
    auth: { type: "header", name: "X-API-Key", secret: "header-secret" } as const,
    assertRequest: (url: URL, headers: Record<string, string>) => {
      expect(url.toString()).toBe("https://vendor.example/mcp?region=ca");
      expect(headers["X-API-Key"]).toBe("header-secret");
    }
  },
  {
    label: "query parameter",
    auth: { type: "query", name: "api_key", secret: "query-secret" } as const,
    assertRequest: (url: URL, headers: Record<string, string>) => {
      expect(url.searchParams.get("region")).toBe("ca");
      expect(url.searchParams.get("api_key")).toBe("query-secret");
      expect(headers.Authorization).toBeUndefined();
    }
  }
])("injects $label authentication only at dispatch", async ({ auth, assertRequest }) => {
  const fetchSpy = vi.fn((input: URL, init: { headers: Record<string, string> }) => {
    assertRequest(input, init.headers);
    return Promise.resolve(
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
    );
  }) as unknown as typeof undiciFetch;

  const response = await forwardRpc(
    "https://vendor.example/mcp?region=ca",
    payload,
    { "X-Forwarded-By": "cogniplane-core" },
    fetchSpy,
    {},
    auth
  );

  expect(response.result).toEqual({ ok: true });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

test("refuses a stored custom auth header that could replace proxy identity", async () => {
  const neverCalled = vi.fn();

  const response = await forwardRpc(
    "https://vendor.example/mcp",
    payload,
    { "X-Framework-Signature": "signed-identity" },
    neverCalled as unknown as typeof undiciFetch,
    {},
    { type: "header", name: "X-Framework-Signature", secret: "attacker-value" }
  );

  expect(response.error?.message).toBe("Upstream MCP authentication is invalid.");
  expect(neverCalled).not.toHaveBeenCalled();
});

test("reads a matching SSE reply after a notification and closes the stream", async () => {
  let cancelled = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(': keepalive\n\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n'));
      controller.enqueue(encoder.encode('event: message\r\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\n\r\n'));
    },
    cancel() { cancelled = true; }
  });
  const request = vi.fn(async (_url: URL, init: { headers: Record<string, string> }) => {
    expect(init.headers.Accept).toBe("application/json, text/event-stream");
    return new Response(stream, { headers: { "Content-Type": "text/event-stream; charset=utf-8" } });
  });

  const response = await forwardRpc("https://vendor.example/mcp", payload, {}, request as never);
  expect(response.result).toEqual({ ok: true });
  expect(cancelled).toBe(true);
});

test("ignores an empty SSE priming event before the reply", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response('id: first\ndata:\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } })) as never
  );
  expect(response.result).toEqual({ ok: true });
});

test("reads an SSE reply with CR-only line endings at EOF", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response('data: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\r\r',
      { headers: { "Content-Type": "text/event-stream" } })) as never
  );
  expect(response.result).toEqual({ ok: true });
});

test("rejects a server-to-client request instead of waiting for its answer", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response('data: {"jsonrpc":"2.0","id":"server-1","method":"sampling/createMessage","params":{}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } })) as never
  );
  expect(response.error?.message).toBe("Upstream MCP requested unsupported server-to-client interaction.");
});

test("sends an MCP request to a local HTTP server with the production transport", async () => {
  let receivedMethod: string | undefined;
  let receivedPath: string | undefined;
  const server = createServer((request, reply) => {
    receivedMethod = request.method;
    receivedPath = request.url;
    reply.writeHead(200, { "content-type": "application/json" });
    reply.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { local: true } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    const response = await forwardRpc(`http://127.0.0.1:${address.port}/mcp`, payload, {});
    expect(response.result).toEqual({ local: true });
    expect(receivedMethod).toBe("POST");
    expect(receivedPath).toBe("/mcp");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("times out an SSE stream that sends keepalives but no reply", async () => {
  const server = createServer((_request, reply) => {
    reply.writeHead(200, { "Content-Type": "text/event-stream" });
    reply.write(": keepalive\n\n");
    const keepalive = setInterval(() => reply.write(": keepalive\n\n"), 20);
    reply.on("close", () => clearInterval(keepalive));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test server has no port");
    const response = await forwardRpc(
      `http://127.0.0.1:${address.port}/mcp`, payload, {}, undefined,
      { timeoutMs: 180 }
    );
    expect(response.error?.message).toBe("Upstream MCP request timed out after 180ms.");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test("rejects an SSE reply with a different request id", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response('data: {"jsonrpc":"2.0","id":2,"result":{"secret":true}}\n\n',
      { headers: { "Content-Type": "text/event-stream" } })) as never
  );
  expect(response.error?.message).toBe("Upstream MCP response was not a valid JSON-RPC envelope.");
});

test("rejects a JSON reply with a different request id", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response('{"jsonrpc":"2.0","id":2,"result":{"secret":true}}',
      { headers: { "Content-Type": "application/json" } })) as never
  );
  expect(response.error?.message).toBe("Upstream MCP response was not a valid JSON-RPC envelope.");
});

test("caps SSE bytes before accepting a later reply", async () => {
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {},
    (async () => new Response(`: ${"x".repeat(200)}\n\ndata: {"jsonrpc":"2.0","id":1,"result":{}}\n\n`,
      { headers: { "Content-Type": "text/event-stream" } })) as never,
    { maxResponseBytes: 100 }
  );
  expect(response.error?.message).toContain("exceeded the maximum size of 100 bytes");
});

test("cancels an in-flight upstream fetch when the overall test budget ends", async () => {
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const diagnostics: Array<{ kind: "http"; status: number } | { kind: "transport" }> = [];
  const waitingFetch = ((_url: unknown, init: { signal?: AbortSignal }) => {
    observedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true
      });
      controller.abort();
    });
  }) as unknown as typeof undiciFetch;
  const response = await forwardRpc(
    "https://vendor.example/mcp", payload, {}, waitingFetch,
    { timeoutMs: 8_000, signal: controller.signal, onDiagnostic: value => diagnostics.push(value) }
  );
  expect(observedSignal?.aborted).toBe(true);
  expect(response.error).toBeDefined();
  expect(diagnostics).toEqual([{ kind: "transport" }]);
});
