// A stand-in for the backend in rendered chat tests. Tests stub the global
// fetch with `FixtureServer.fetch`. The real API clients, AG-UI HTTP agent,
// SSE decoder, event verifier, and reducer then run against these responses.
//
//   GET  /sessions/:id/connect        SSE that the test writes in steps, or an HTTP error
//   POST /messages?format=agui        SSE that the test writes in steps, or an HTTP error
//   GET  /sessions?ids=...            the running state of the session list
//   GET  /sessions/:id/messages       saved rows
//   GET  /sessions/:id/approvals      current approval records
//   POST /sessions/:id/interrupt      Stop
//   POST /approvals/:id/decision      an approval decision
//
// Any other request answers 404, so an unexpected call fails the test.

import type { CogniplaneCustomEvent, CustomEventValue } from "@cogniplane/shared-types";

const encoder = new TextEncoder();

/** One SSE response body. */
export class FixtureStream {
  aborted = false;
  closed = false;

  constructor(private readonly controller: ReadableStreamDefaultController<Uint8Array>) {}

  get open(): boolean {
    return !this.aborted && !this.closed;
  }

  /** Writes events. After an abort or a close this does nothing, like a socket that is gone. */
  push(...events: object[]): void {
    if (!this.open) return;
    for (const event of events) this.controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  }

  finish(): void {
    if (!this.open) return;
    this.closed = true;
    this.controller.close();
  }

  /** The network drops the connection. */
  fail(): void {
    if (!this.open) return;
    this.closed = true;
    this.controller.error(new TypeError("network error"));
  }

  abort(): void {
    this.aborted = true;
    try {
      this.controller.error(new DOMException("The operation was aborted.", "AbortError"));
    } catch {
      // The stream is already closed.
    }
  }
}

export type StreamReply = (stream: FixtureStream, body: Record<string, unknown> | null) => void;
export type JsonReply = { status: number; body?: unknown };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export class FixtureServer {
  /** "GET /sessions/s-1/connect", in request order. */
  readonly calls: string[] = [];
  /** Request bodies of POST /messages, in order. */
  readonly sent: Array<Record<string, unknown>> = [];
  readonly streams = new Map<string, FixtureStream[]>();
  /** The next replies of each connect, by session. The last one repeats. */
  readonly connects = new Map<string, Array<StreamReply | JsonReply>>();
  /** The next replies of POST /messages. The last one repeats. */
  messageReplies: Array<StreamReply | JsonReply> = [];
  readonly running = new Map<string, boolean>();
  readonly savedRows = new Map<string, object[]>();
  readonly approvals = new Map<string, object[]>();
  /** The next replies of GET /sessions/:id/approvals, before the saved
   *  records answer. A function reply can wait for the test. */
  approvalReplies: Array<JsonReply | (() => Promise<JsonReply>)> = [];
  interruptReply: JsonReply = { status: 200, body: { ok: true } };

  connect(sessionId: string, ...replies: Array<StreamReply | JsonReply>): void {
    this.connects.set(sessionId, replies);
  }

  streamsOf(key: string): FixtureStream[] {
    return this.streams.get(key) ?? [];
  }

  openStreams(key: string): FixtureStream[] {
    return this.streamsOf(key).filter((stream) => stream.open);
  }

  count(call: string): number {
    return this.calls.filter((entry) => entry === call).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? "GET";
    this.calls.push(`${method} ${url.pathname}`);
    const signal = init?.signal ?? undefined;
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");

    const connect = /^\/sessions\/([^/]+)\/connect$/.exec(url.pathname);
    if (connect && method === "GET") {
      const sessionId = connect[1]!;
      const queue = this.connects.get(sessionId) ?? [];
      const reply = queue.length > 1 ? queue.shift()! : queue[0];
      if (!reply) return json({ error: "unexpected_connect" }, 404);
      return this.reply(`connect:${sessionId}`, reply, null, signal);
    }
    if (url.pathname === "/messages" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      this.sent.push(body);
      const reply = this.messageReplies.length > 1 ? this.messageReplies.shift()! : this.messageReplies[0];
      if (!reply) return json({ error: "unexpected_message" }, 404);
      return this.reply(`messages:${String(body.sessionId)}`, reply, body, signal);
    }
    if (url.pathname === "/sessions" && method === "GET") {
      const ids = url.searchParams.get("ids")?.split(",") ?? [];
      return json({
        sessions: ids.map((sessionId) => ({
          sessionId, userId: "user-1", sessionName: sessionId, status: "active",
          createdAt: "2026-10-12T10:00:00.000Z", updatedAt: "2026-10-12T10:00:00.000Z",
          isRunning: this.running.get(sessionId) === true
        })),
        trashRetentionDays: 30
      });
    }
    const messages = /^\/sessions\/([^/]+)\/messages$/.exec(url.pathname);
    if (messages && method === "GET") return json({ messages: this.savedRows.get(messages[1]!) ?? [], hasMore: false });
    const approvals = /^\/sessions\/([^/]+)\/approvals$/.exec(url.pathname);
    if (approvals && method === "GET") {
      const next = this.approvalReplies.shift();
      if (next) {
        const reply = typeof next === "function" ? await next() : next;
        return json(reply.body ?? {}, reply.status);
      }
      return json({ approvals: this.approvals.get(approvals[1]!) ?? [] });
    }
    if (/^\/sessions\/[^/]+\/interrupt$/.test(url.pathname) && method === "POST") {
      return json(this.interruptReply.body ?? {}, this.interruptReply.status);
    }
    if (/^\/approvals\/[^/]+\/decision$/.test(url.pathname) && method === "POST") return json({ ok: true });
    return json({ error: "unexpected_call", path: url.pathname }, 404);
  };

  private reply(key: string, reply: StreamReply | JsonReply, body: Record<string, unknown> | null, signal?: AbortSignal): Response {
    if (typeof reply !== "function") return json(reply.body ?? {}, reply.status);
    let stream!: FixtureStream;
    const responseBody = new ReadableStream<Uint8Array>({
      start: (controller) => {
        stream = new FixtureStream(controller);
        this.streams.set(key, [...this.streamsOf(key), stream]);
        signal?.addEventListener("abort", () => stream.abort(), { once: true });
        reply(stream, body);
      }
    });
    return new Response(responseBody, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
}

/** A CUSTOM event. The schema types its value, so a test cannot send a shape
 *  that the frontend rejects. */
function custom<Name extends CogniplaneCustomEvent["name"]>(name: Name, value: CustomEventValue<Name>) {
  return { type: "CUSTOM", name, value };
}

/** AG-UI events as the backend sends them. */
export const ev = {
  runStarted: (runId: string, threadId = "s-1") => ({ type: "RUN_STARTED", threadId, runId }),
  runFinished: (runId: string, threadId = "s-1") => ({ type: "RUN_FINISHED", threadId, runId }),
  runError: (message: string) => ({ type: "RUN_ERROR", message }),
  custom,
  turnStarted: (messageId: string) => custom("turn_started", { messageId, sequence: 9 }),
  userPersisted: (messageId: string, text: string) => custom("user_message_persisted", { messageId, text }),
  approvalRequired: (approvalId: string) => custom("approval_required", {
    approvalId, itemId: `item-${approvalId}`, kind: "command_execution", title: `Run ${approvalId}`, summary: "Needs a decision"
  }),
  expired: (approvalId: string) => custom("runtime_notice", {
    noticeId: `approval-expired:${approvalId}`, level: "warning", title: "Approval expired", message: "The request expired.", createdAt: "2026-10-12T10:00:00.000Z"
  }),
  textStart: (messageId: string) => ({ type: "TEXT_MESSAGE_START", messageId, role: "assistant" }),
  text: (messageId: string, delta: string) => ({ type: "TEXT_MESSAGE_CONTENT", messageId, delta }),
  textEnd: (messageId: string) => ({ type: "TEXT_MESSAGE_END", messageId }),
  planDelta: (plan: string) => ({ type: "STATE_DELTA", delta: [{ op: "replace", path: "/plan", value: plan }] }),
  /** The finished run that carries the saved history, as `GET /sessions/:id/connect` sends it. */
  history: (input: {
    messages: object[];
    plan?: string;
    activeTurn?: CustomEventValue<"session_connection">["activeTurn"];
    hasMoreHistory?: boolean;
    threadId?: string;
  }) => {
    const threadId = input.threadId ?? "s-1";
    const runId = `history:${threadId}`;
    return [
      { type: "RUN_STARTED", threadId, runId },
      { type: "MESSAGES_SNAPSHOT", messages: input.messages },
      { type: "STATE_SNAPSHOT", snapshot: { plan: input.plan ?? "" } },
      custom("session_connection", { activeTurn: input.activeTurn ?? "none", hasMoreHistory: input.hasMoreHistory ?? false }),
      { type: "RUN_FINISHED", threadId, runId }
    ];
  }
};

/** A connection reply with the saved history and no running turn. */
export function idleHistory(
  messages: object[],
  options: Omit<Parameters<typeof ev.history>[0], "messages" | "activeTurn"> = {}
): StreamReply {
  return (stream) => {
    stream.push(...ev.history({ ...options, messages }));
    stream.finish();
  };
}

/** A saved approval record. */
export function savedApproval(approvalId: string, status: "pending" | "approved" | "expired", sessionId = "s-1"): object {
  return { approvalId, sessionId, itemId: `item-${approvalId}`, kind: "command_execution", title: `Run ${approvalId}`, summary: "Needs a decision", status };
}

class InertObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
}

/** Layout APIs that jsdom lacks and CopilotChat calls. They are inert and
 *  replace no CopilotKit or AG-UI code. */
export function installBrowserLayoutStubs(): void {
  const target = globalThis as Record<string, unknown>;
  target.ResizeObserver ??= InertObserver;
  target.IntersectionObserver ??= InertObserver;
  if (!window.matchMedia) {
    window.matchMedia = (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
      dispatchEvent: () => false
    });
  }
  Element.prototype.scrollTo ??= function scrollTo() {};
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
}
