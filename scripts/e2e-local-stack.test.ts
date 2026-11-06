import { spawn } from "node:child_process";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// These tests run the real CLI against a local HTTP server that copies the backend contract.
// Deadlines are short. Elapsed-time limits leave several seconds for Node.js startup.
const script = resolve("scripts/e2e-local-stack.mjs");
const sessionId = "session-smoke-1";
const expectedText = "COGNIPLANE_SMOKE_TEST_OK";
const userId = "smoke-user";
const devAuthKey = "smoke-dev-key";
const fastTimeouts = {
  COGNIPLANE_E2E_REQUEST_TIMEOUT_MS: "400",
  COGNIPLANE_E2E_STREAM_TIMEOUT_MS: "600",
  COGNIPLANE_E2E_CLEANUP_TIMEOUT_MS: "400"
};
// The child is killed after this time, so a regression fails the test and does not hang it.
const childKillAfterMs = 15_000;

type Handler = (response: ServerResponse, fixture: Fixture) => void;

interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

interface Fixture {
  url: string;
  requests: RecordedRequest[];
  // Resolves when the server sees the POST /messages connection close.
  messagesClosed: Promise<void>;
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolveClose, rejectClose) => {
          server.closeAllConnections();
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        })
    )
  );
});

function sseFrame(payload: unknown) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function sendJson(response: ServerResponse, status: number, payload: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

function startSse(response: ServerResponse) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(sseFrame({ type: "RUN_STARTED" }));
}

const createSession: Handler = (response) => sendJson(response, 201, { session: { sessionId } });

const completedStream: Handler = (response) => {
  startSse(response);
  // Split one frame across two writes to check that the client buffers partial frames.
  const frame = sseFrame({ type: "TEXT_MESSAGE_CONTENT", delta: expectedText });
  response.write(frame.slice(0, 20));
  response.write(frame.slice(20));
  response.end(sseFrame({ type: "RUN_FINISHED" }));
};

const replay: Handler = (response) =>
  sendJson(response, 200, {
    messages: [
      { role: "user", status: "completed", content: "prompt" },
      { role: "assistant", status: "completed", content: expectedText }
    ]
  });

const deleted: Handler = (response) => {
  response.writeHead(204);
  response.end();
};

// Accepts the request and never sends a status line or headers.
const neverRespond: Handler = () => {};

const stalledJsonBody: Handler = (response) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.write('{"messages": [');
};

const stalledStream: Handler = (response) => {
  startSse(response);
  response.write(sseFrame({ type: "TEXT_MESSAGE_CONTENT", delta: "partial" }));
};

const runErrorThenStall: Handler = (response) => {
  startSse(response);
  response.write(sseFrame({ type: "RUN_ERROR", message: "Provider rejected the request. Reconnecting..." }));
};

async function startFixture(routes: Record<string, Handler>): Promise<Fixture> {
  let markMessagesClosed: () => void = () => {};
  const fixture: Fixture = {
    url: "",
    requests: [],
    messagesClosed: new Promise<void>((resolveClosed) => {
      markMessagesClosed = resolveClosed;
    })
  };

  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => {
      body += chunk;
    });
    request.on("end", () => {
      const method = request.method ?? "";
      const url = request.url ?? "";
      fixture.requests.push({ method, url, headers: request.headers, body });
      if (method === "POST" && url === "/messages") {
        response.on("close", markMessagesClosed);
      }
      const handler = routes[`${method} ${url}`];
      if (handler) {
        handler(response, fixture);
      } else {
        sendJson(response, 404, { error: `No fixture route for ${method} ${url}` });
      }
    });
  });
  servers.push(server);
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server did not bind to TCP");
  fixture.url = `http://127.0.0.1:${address.port}`;
  return fixture;
}

// Responds to DELETE only after the client has closed the POST /messages stream. If the CLI
// kept the stream open until process exit, this cleanup would stall and log a warning.
const deleteAfterStreamClosed: Handler = (response, fixture) => {
  void fixture.messagesClosed.then(() => deleted(response, fixture));
};

async function runCli(fixtureUrl: string, env: Record<string, string> = fastTimeouts) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [script], {
    env: {
      ...process.env,
      COGNIPLANE_API_URL: fixtureUrl,
      COGNIPLANE_USER_ID: userId,
      DEV_HEADERS_AUTH_KEY: devAuthKey,
      COGNIPLANE_EXPECTED_TEXT: expectedText,
      ...env
    },
    stdio: ["ignore", "pipe", "pipe"],
    timeout: childKillAfterMs
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const [exitCode, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolveExit) =>
    child.on("close", (code, closeSignal) => resolveExit([code, closeSignal]))
  );
  return { exitCode, signal, stdout, stderr, elapsedMs: performance.now() - startedAt };
}

function routeLog(fixture: Fixture) {
  return fixture.requests.map((request) => `${request.method} ${request.url}`);
}

test("completes the smoke flow, checks replay, and deletes the session", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": completedStream,
    [`GET /sessions/${sessionId}/messages`]: replay,
    [`DELETE /sessions/${sessionId}`]: deleted
  });

  const result = await runCli(fixture.url);

  expect(result.stderr).toBe("");
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Smoke test passed for session ${sessionId}`);
  expect(routeLog(fixture)).toEqual([
    "POST /sessions",
    "POST /messages",
    `GET /sessions/${sessionId}/messages`,
    `DELETE /sessions/${sessionId}`
  ]);
  for (const request of fixture.requests) {
    expect(request.headers["x-user-id"]).toBe(userId);
    expect(request.headers["x-dev-auth-key"]).toBe(devAuthKey);
  }
  const [createRequest, messageRequest] = fixture.requests;
  expect(createRequest.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(createRequest.body)).toEqual({ name: expect.stringMatching(/^Smoke test /) });
  expect(messageRequest.headers["content-type"]).toBe("application/json");
  expect(JSON.parse(messageRequest.body)).toEqual({
    sessionId,
    text: `Respond with exactly this text and nothing else: ${expectedText}`
  });
});

test("fails when the replayed assistant text does not match the expected text", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": completedStream,
    [`GET /sessions/${sessionId}/messages`]: (response) =>
      sendJson(response, 200, {
        messages: [
          { role: "user", status: "completed", content: "prompt" },
          { role: "assistant", status: "completed", content: "something else" }
        ]
      }),
    [`DELETE /sessions/${sessionId}`]: deleted
  });

  const result = await runCli(fixture.url);

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Expected replayed assistant text to include "${expectedText}"`);
  expect(routeLog(fixture)).toContain(`DELETE /sessions/${sessionId}`);
});

test("stops when the server never sends response headers to a request", async () => {
  const fixture = await startFixture({ "POST /sessions": neverRespond });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("POST /sessions did not complete within 400 ms");
  expect(result.stderr).toContain("COGNIPLANE_E2E_REQUEST_TIMEOUT_MS");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
  expect(result.elapsedMs).toBeLessThan(5_000);
  // No session exists yet, so there is nothing to clean up.
  expect(routeLog(fixture)).toEqual(["POST /sessions"]);
});

test("stops when a request body stalls after headers and still cleans up", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": completedStream,
    [`GET /sessions/${sessionId}/messages`]: stalledJsonBody,
    [`DELETE /sessions/${sessionId}`]: deleted
  });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`GET /sessions/${sessionId}/messages did not complete within 400 ms`);
  expect(result.stderr).not.toContain("Cleanup failed");
  expect(result.elapsedMs).toBeLessThan(5_000);
  expect(routeLog(fixture)).toContain(`DELETE /sessions/${sessionId}`);
});

test("stops when POST /messages never sends response headers and still cleans up", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": neverRespond,
    [`DELETE /sessions/${sessionId}`]: deleteAfterStreamClosed
  });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("POST /messages did not finish its event stream within 600 ms");
  expect(result.stderr).toContain("COGNIPLANE_E2E_STREAM_TIMEOUT_MS");
  expect(result.stderr).not.toContain("Cleanup failed");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
  expect(result.elapsedMs).toBeLessThan(5_000);
  expect(routeLog(fixture)).toEqual(["POST /sessions", "POST /messages", `DELETE /sessions/${sessionId}`]);
});

test("stops when the event stream never finishes, closes it, and still cleans up", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": stalledStream,
    [`DELETE /sessions/${sessionId}`]: deleteAfterStreamClosed
  });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("POST /messages did not finish its event stream within 600 ms");
  expect(result.stderr).not.toContain("Cleanup failed");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(600);
  expect(result.elapsedMs).toBeLessThan(5_000);
  expect(routeLog(fixture)).toEqual(["POST /sessions", "POST /messages", `DELETE /sessions/${sessionId}`]);
});

test("closes the event stream on RUN_ERROR before cleanup", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": runErrorThenStall,
    [`DELETE /sessions/${sessionId}`]: deleteAfterStreamClosed
  });

  // A long stream deadline shows that the RUN_ERROR frame ends the run, not the deadline.
  const result = await runCli(fixture.url, { ...fastTimeouts, COGNIPLANE_E2E_STREAM_TIMEOUT_MS: "20000" });

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("Error: Provider rejected the request. Reconnecting...");
  expect(result.stderr).not.toContain("ChatGPT");
  expect(result.stderr).not.toContain("OPENAI_API_KEY");
  expect(result.stderr).not.toContain("did not finish its event stream");
  expect(result.stderr).not.toContain("Cleanup failed");
  expect(result.elapsedMs).toBeLessThan(5_000);
  expect(routeLog(fixture)).toEqual(["POST /sessions", "POST /messages", `DELETE /sessions/${sessionId}`]);
});

test("a stalled cleanup after a passing run only warns and does not hang", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": completedStream,
    [`GET /sessions/${sessionId}/messages`]: replay,
    [`DELETE /sessions/${sessionId}`]: neverRespond
  });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(0);
  expect(result.stdout).toContain(`Smoke test passed for session ${sessionId}`);
  expect(result.stderr).toContain(
    `Cleanup failed for session ${sessionId}: DELETE /sessions/${sessionId} did not complete within 400 ms`
  );
  expect(result.stderr).toContain("COGNIPLANE_E2E_CLEANUP_TIMEOUT_MS");
  expect(result.elapsedMs).toBeGreaterThanOrEqual(400);
  expect(result.elapsedMs).toBeLessThan(5_000);
});

test("keeps the original stream failure when cleanup also times out", async () => {
  const fixture = await startFixture({
    "POST /sessions": createSession,
    "POST /messages": stalledStream,
    [`DELETE /sessions/${sessionId}`]: neverRespond
  });

  const result = await runCli(fixture.url);

  expect(result.signal).toBeNull();
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain(`Cleanup failed for session ${sessionId}: DELETE /sessions/${sessionId} did not complete`);
  // The cleanup warning comes first. The original failure is the last error the CLI reports.
  const cleanupWarningAt = result.stderr.indexOf("Cleanup failed");
  const streamFailureAt = result.stderr.indexOf("POST /messages did not finish its event stream within 600 ms");
  expect(streamFailureAt).toBeGreaterThan(cleanupWarningAt);
  // Both deadlines run one after the other: 600 ms for the stream and 400 ms for cleanup.
  expect(result.elapsedMs).toBeGreaterThanOrEqual(1_000);
  expect(result.elapsedMs).toBeLessThan(6_000);
});

test.each(["0", "-5", "", "abc", "1.5", "Infinity", "2147483648"])(
  "rejects request timeout %j before it sends a request",
  async (value) => {
    const fixture = await startFixture({});

    const result = await runCli(fixture.url, { ...fastTimeouts, COGNIPLANE_E2E_REQUEST_TIMEOUT_MS: value });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `COGNIPLANE_E2E_REQUEST_TIMEOUT_MS must be a whole number of milliseconds from 1 to 2147483647, received "${value}"`
    );
    expect(fixture.requests).toEqual([]);
  }
);
