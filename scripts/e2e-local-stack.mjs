const apiUrl = process.env.COGNIPLANE_API_URL ?? "http://localhost:3001";
const userId = process.env.COGNIPLANE_USER_ID ?? "local-dev-user";
const expectedText = process.env.COGNIPLANE_EXPECTED_TEXT ?? "COGNIPLANE_SMOKE_TEST_OK";
const prompt =
  process.env.COGNIPLANE_PROMPT ?? `Respond with exactly this text and nothing else: ${expectedText}`;

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function request(path, init = {}) {
  const headers = {
    "x-user-id": userId,
    ...(init.headers ?? {})
  };

  if (init.body !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === "content-type")) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(`${apiUrl}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} failed with ${response.status}: ${body}`);
  }

  if (response.status === 204) {
    return undefined;
  }

  return response.json();
}

async function readSse(response) {
  assert(response.ok, `POST /messages failed with ${response.status}`);
  assert(response.body, "POST /messages returned no response body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let assistantText = "";
  let completedStatus = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() ?? "";

    for (const frame of frames) {
      const eventLine = frame.split("\n").find((line) => line.startsWith("event: "));
      const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));

      if (!eventLine || !dataLine) {
        continue;
      }

      const event = eventLine.slice(7);
      const payload = JSON.parse(dataLine.slice(6));

      if (event === "response.output_text.delta" && typeof payload.delta === "string") {
        assistantText += payload.delta;
      }

      if (event === "response.failed") {
        const message = payload.error?.message ?? "Assistant response failed";
        if (message.includes("Reconnecting...")) {
          throw new Error(
            `${message}. If you are running the backend in Docker, export OPENAI_API_KEY before starting the stack to avoid ChatGPT-session reconnect failures inside the container.`
          );
        }

        throw new Error(message);
      }

      if (event === "response.completed") {
        completedStatus = payload.response?.status ?? null;
      }
    }
  }

  return {
    assistantText,
    completedStatus
  };
}

async function main() {
  const sessionName = `Smoke test ${new Date().toISOString()}`;
  let sessionId = null;

  try {
    const created = await request("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: sessionName })
    });
    sessionId = created.session.sessionId;
    assert(typeof sessionId === "string", "Session creation did not return a sessionId");

    const streamResponse = await fetch(`${apiUrl}/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-user-id": userId
      },
      body: JSON.stringify({
        sessionId,
        text: prompt
      })
    });

    const streamResult = await readSse(streamResponse);
    assert(
      streamResult.completedStatus === "completed",
      `Expected completed response, received ${String(streamResult.completedStatus)}`
    );
    assert(
      streamResult.assistantText.includes(expectedText),
      `Expected streamed assistant text to include "${expectedText}", received "${streamResult.assistantText}"`
    );

    const replay = await request(`/sessions/${sessionId}/messages`);
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
      try {
        await request(`/sessions/${sessionId}`, {
          method: "DELETE"
        });
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
