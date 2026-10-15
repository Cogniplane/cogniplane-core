const apiUrl = process.env.COGNIPLANE_API_URL ?? "http://localhost:3001";
const userId = process.env.COGNIPLANE_USER_ID ?? "local-dev-user";
// Matches the compose default; the backend rejects identity headers without it.
const devAuthKey = process.env.DEV_HEADERS_AUTH_KEY ?? "local-dev-headers-auth-key";
const expectedText = process.env.COGNIPLANE_EXPECTED_TEXT ?? "COGNIPLANE_SMOKE_TEST_OK";
const prompt =
  process.env.COGNIPLANE_PROMPT ?? `Respond with exactly this text and nothing else: ${expectedText}`;

// Every network wait has a deadline so a stalled backend fails the run instead of hanging it.
// Override a deadline with a whole number of milliseconds between 1 and MAX_TIMEOUT_MS.
const timeoutSettings = {
  request: { variable: "COGNIPLANE_E2E_REQUEST_TIMEOUT_MS", defaultMs: 30_000 },
  stream: { variable: "COGNIPLANE_E2E_STREAM_TIMEOUT_MS", defaultMs: 180_000 },
  cleanup: { variable: "COGNIPLANE_E2E_CLEANUP_TIMEOUT_MS", defaultMs: 10_000 }
};
// Larger values overflow the Node.js timer and fire after 1 ms.
const MAX_TIMEOUT_MS = 2_147_483_647;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function readTimeoutMs({ variable, defaultMs }) {
  const raw = process.env[variable];
  if (raw === undefined) {
    return defaultMs;
  }

  const trimmed = raw.trim();
  const value = Number(trimmed);
  if (!/^\d+$/.test(trimmed) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error(`${variable} must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS}, received "${raw}"`);
  }

  return value;
}

function readTimeouts() {
  return Object.fromEntries(
    Object.entries(timeoutSettings).map(([name, setting]) => [name, readTimeoutMs(setting)])
  );
}

// Runs operation(signal) and rejects with timeoutError once timeoutMs passes. The signal aborts
// the fetch and its body stream when the deadline passes or the operation settles, so no
// socket or reader stays open after this function returns.
async function withDeadline(timeoutMs, timeoutError, operation) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });

  try {
    return await Promise.race([operation(controller.signal), deadline]);
  } catch (error) {
    throw controller.signal.reason === timeoutError ? timeoutError : error;
  } finally {
    clearTimeout(timer);
    controller.abort(new Error("Request finished"));
  }
}

function headersFor(init) {
  const headers = {
    "x-user-id": userId,
    "x-dev-auth-key": devAuthKey,
    ...(init.headers ?? {})
  };

  if (init.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  return headers;
}

async function request(path, init, timeout) {
  const label = `${init.method ?? "GET"} ${path}`;
  const timeoutError = new Error(
    `${label} did not complete within ${timeout.ms} ms. Check that the backend at ${apiUrl} is running and responsive, or set ${timeout.variable} to a larger value.`
  );

  return withDeadline(timeout.ms, timeoutError, async (signal) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: headersFor(init),
      signal
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`${label} failed with ${response.status}: ${body}`);
    }

    if (response.status === 204) {
      return undefined;
    }

    return response.json();
  });
}

async function readSse(response) {
  assert(response.ok, `POST /messages failed with ${response.status}`);
  assert(response.body, "POST /messages returned no response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let completedStatus = null;
  let streamEnded = false;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        streamEnded = true;
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";

      for (const frame of frames) {
        const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));

        if (!dataLine) {
          continue;
        }

        const payload = JSON.parse(dataLine.slice(6));

        if (payload.type === "TEXT_MESSAGE_CONTENT" && typeof payload.delta === "string") {
          assistantText += payload.delta;
        }

        if (payload.type === "RUN_ERROR") {
          throw new Error(payload.message ?? "Assistant response failed");
        }

        if (payload.type === "RUN_FINISHED") {
          completedStatus = "completed";
        }
      }
    }
  } finally {
    if (!streamEnded) {
      // Stop the server stream now. Do not wait for the cancel: a stalled server must not
      // delay the error report.
      reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }

  return {
    assistantText,
    completedStatus
  };
}

async function streamMessage(sessionId, timeout) {
  const timeoutError = new Error(
    `POST /messages did not finish its event stream within ${timeout.ms} ms. Check the backend logs for a stalled model or provider call, or set ${timeout.variable} to a larger value for slow models.`
  );

  return withDeadline(timeout.ms, timeoutError, async (signal) => {
    const body = JSON.stringify({ sessionId, text: prompt });
    const response = await fetch(`${apiUrl}/messages`, {
      method: "POST",
      headers: headersFor({ body }),
      body,
      signal
    });

    return readSse(response);
  });
}

async function main() {
  const timeoutMs = readTimeouts();
  const timeoutFor = (name) => ({ ms: timeoutMs[name], variable: timeoutSettings[name].variable });
  const sessionName = `Smoke test ${new Date().toISOString()}`;
  let sessionId = null;

  try {
    const created = await request(
      "/sessions",
      {
        method: "POST",
        body: JSON.stringify({ name: sessionName })
      },
      timeoutFor("request")
    );
    sessionId = created.session.sessionId;
    assert(typeof sessionId === "string", "Session creation did not return a sessionId");

    const streamResult = await streamMessage(sessionId, timeoutFor("stream"));
    assert(
      streamResult.completedStatus === "completed",
      `Expected completed response, received ${String(streamResult.completedStatus)}`
    );
    assert(
      streamResult.assistantText.includes(expectedText),
      `Expected streamed assistant text to include "${expectedText}", received "${streamResult.assistantText}"`
    );

    const replay = await request(`/sessions/${sessionId}/messages`, {}, timeoutFor("request"));
    assert(Array.isArray(replay.messages), "Replay response did not include messages");
    assert(replay.messages.length >= 2, `Expected at least 2 messages, received ${replay.messages.length}`);

    const assistantMessages = replay.messages.filter((message) => message.role === "assistant");
    assert(assistantMessages.length > 0, "Replay did not include an assistant message");

    const finalAssistant = assistantMessages.at(-1);
    assert(finalAssistant.status === "completed", `Expected completed assistant message, received ${finalAssistant.status}`);
    assert(
      typeof finalAssistant.content === "string" && finalAssistant.content.includes(expectedText),
      `Expected replayed assistant text to include "${expectedText}", received "${finalAssistant.content}"`
    );

    console.log(`Smoke test passed for session ${sessionId}`);
  } finally {
    if (sessionId) {
      // Cleanup has its own deadline and only logs a warning, so it cannot replace the
      // original failure or keep the run open.
      try {
        await request(
          `/sessions/${sessionId}`,
          {
            method: "DELETE"
          },
          timeoutFor("cleanup")
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`Cleanup failed for session ${sessionId}: ${message}`);
      }
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
