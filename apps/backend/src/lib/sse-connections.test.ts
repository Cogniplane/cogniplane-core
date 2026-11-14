import { EventEmitter } from "node:events";
import { get, type IncomingMessage } from "node:http";

import Fastify from "fastify";
import { afterEach, expect, test, vi } from "vitest";

import { createTestConfig } from "../test-helpers/test-config.js";
import { openSseResponse } from "./open-sse-response.js";
import { registerSseConnections, SseConnections } from "./sse-connections.js";

afterEach(() => {
  vi.useRealTimers();
});

async function streamApp() {
  const app = Fastify();
  app.decorate("config", createTestConfig());
  const connections = registerSseConnections(app);
  app.get("/stream", (request, reply) => {
    openSseResponse(app, request, reply);
    reply.raw.write("data: open\n\n");
  });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  return { app, connections, address };
}

/** Opens a stream and resolves when its first chunk or its end arrives. */
async function openStream(url: string): Promise<{ response: IncomingMessage; ended: () => boolean; closed: Promise<void> }> {
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    get(url, resolve).on("error", reject);
  });
  response.on("error", () => {});
  let ended = false;
  const closed = new Promise<void>((resolve) => {
    response.on("end", () => {
      ended = true;
      resolve();
    });
    response.on("close", () => resolve());
  });
  await Promise.race([new Promise<void>((resolve) => response.once("data", () => resolve())), closed]);
  response.resume();
  return { response, ended: () => ended, closed };
}

test("each app closes only its own streams, and a stream opened after the close ends at once", async () => {
  const a = await streamApp();
  const b = await streamApp();
  try {
    expect(a.connections).not.toBe(b.connections);
    const streamA = await openStream(`${a.address}/stream`);
    const streamB = await openStream(`${b.address}/stream`);
    expect(a.connections.size).toBe(1);
    expect(b.connections.size).toBe(1);

    await a.connections.close(1_000);
    await streamA.closed;

    expect(streamA.ended()).toBe(true);
    expect(a.connections.size).toBe(0);
    expect(b.connections.size).toBe(1);
    expect(streamB.ended()).toBe(false);

    // The route writes to the raw response after the registry destroyed it:
    // Node drops the write, and no error event reaches the process.
    const late = await new Promise<void>((resolve) => {
      get(`${a.address}/stream`, (response) => {
        response.on("error", () => {});
        response.on("close", () => resolve());
        response.resume();
      }).on("error", () => resolve());
    });
    await late;
    expect(a.connections.size).toBe(0);

    streamB.response.destroy();
  } finally {
    await b.connections.close(100);
    await Promise.all([a.app.close(), b.app.close()]);
  }
});

/** A response whose client does not read: end() never flushes, so close never comes on its own. */
class StalledResponse extends EventEmitter {
  destroyed = false;
  endCalls = 0;

  end(): void {
    this.endCalls += 1;
  }

  destroy(): void {
    this.destroyed = true;
    process.nextTick(() => this.emit("close"));
  }
}

test("close destroys a response that does not flush within the grace time", async () => {
  vi.useFakeTimers();
  const connections = new SseConnections();
  const stalled = new StalledResponse();
  connections.track(stalled);

  let done = false;
  const closing = connections.close(1_000).then(() => { done = true; });
  expect(stalled.endCalls).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(done).toBe(false);
  expect(stalled.destroyed).toBe(false);

  await vi.advanceTimersByTimeAsync(1);
  await closing;
  expect(stalled.destroyed).toBe(true);
  expect(connections.size).toBe(0);
});

test("a response tracked after the close is destroyed at once", async () => {
  const connections = new SseConnections();
  await connections.close(500);
  const late = new StalledResponse();

  connections.track(late);

  expect(late.destroyed).toBe(true);
  expect(late.endCalls).toBe(0);
  expect(connections.size).toBe(0);
});
