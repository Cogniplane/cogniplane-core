import { createServer } from "node:net";
import { readFile as fsReadFile, writeFile as fsWriteFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import type { FastifyBaseLogger } from "fastify";

const textDecoder = new TextDecoder();

type JsonRpcSuccess = {
  id: number | string;
  result: unknown;
};

type JsonRpcFailure = {
  id: number | string;
  error: {
    code: number;
    message: string;
  };
};

export type JsonRpcRequest = {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcNotification = {
  method: string;
  params?: Record<string, unknown>;
};

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ParsedJsonRpc =
  | { kind: "request"; request: JsonRpcRequest }
  | { kind: "response"; response: JsonRpcSuccess | JsonRpcFailure }
  | { kind: "notification"; notification: JsonRpcNotification };

function parseJsonRpcMessage(raw: string): ParsedJsonRpc | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const obj = msg as Record<string, unknown>;
  const hasId = "id" in obj && (typeof obj.id === "number" || typeof obj.id === "string");
  const hasMethod = typeof obj.method === "string";
  if (hasId && hasMethod) {
    return { kind: "request", request: obj as unknown as JsonRpcRequest };
  }
  if (hasId) {
    return { kind: "response", response: obj as unknown as JsonRpcSuccess | JsonRpcFailure };
  }
  if (hasMethod) {
    return { kind: "notification", notification: obj as unknown as JsonRpcNotification };
  }
  return null;
}

export class CodexRuntimeProcessStartError extends Error {
  constructor(
    message: string,
    readonly port: number,
    readonly processId: number | null
  ) {
    super(message);
  }
}

export class CodexRuntimeProcess {
  private requestId = 1;
  private readonly pendingRequests = new Map<number | string, PendingRequest>();
  private readonly notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
  private readonly requestListeners = new Set<(request: JsonRpcRequest) => void>();
  private readonly closeListeners = new Set<() => void>();
  private readonly exitListeners = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();

  private constructor(
    readonly port: number,
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly socket: WebSocket,
    private readonly requestTimeoutMs: number
  ) {
    this.attachHandlers();
  }

  static async start(input: {
    binaryPath: string;
    cwd: string;
    logger: FastifyBaseLogger;
    requestTimeoutMs: number;
    startTimeoutMs: number;
    runtimeId: string;
    sessionId: string;
    env?: Record<string, string>;
  }): Promise<CodexRuntimeProcess> {
    const port = await allocatePort();
    const child = spawn(input.binaryPath, ["app-server", "--listen", `ws://127.0.0.1:${port}`], {
      cwd: input.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      ...(input.env ? { env: { ...process.env, ...input.env } as NodeJS.ProcessEnv } : {})
    });

    child.stdout.on("data", (chunk) => {
      input.logger.info(
        { sessionId: input.sessionId, runtimeId: input.runtimeId, output: chunk.toString() },
        "Codex runtime stdout"
      );
    });
    child.stderr.on("data", (chunk) => {
      input.logger.info(
        { sessionId: input.sessionId, runtimeId: input.runtimeId, output: chunk.toString() },
        "Codex runtime stderr"
      );
    });
    child.on("exit", (code, signal) => {
      input.logger.info(
        { sessionId: input.sessionId, runtimeId: input.runtimeId, code, signal },
        "Codex runtime exited"
      );
    });

    try {
      const socket = await connectWebSocket(`ws://127.0.0.1:${port}`, input.startTimeoutMs);
      return new CodexRuntimeProcess(port, child, socket, input.requestTimeoutMs);
    } catch (error) {
      child.kill("SIGTERM");
      throw new CodexRuntimeProcessStartError(
        error instanceof Error ? error.message : "Codex runtime startup failed",
        port,
        child.pid ?? null
      );
    }
  }

  get pid(): number | null {
    return this.child.pid ?? null;
  }

  get socketReadyState(): number {
    return this.socket.readyState;
  }

  isAlive(): boolean {
    return this.child.exitCode === null;
  }

  async sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T> {
    const id = this.requestId++;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`Timed out waiting for ${method} response.`));
      }, this.requestTimeoutMs);

      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout
      });

      this.socket.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          params
        })
      );
    });
  }

  sendNotification(method: string, params?: Record<string, unknown>): void {
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params ? { params } : {})
      })
    );
  }

  sendResponse(id: number | string, result: unknown): void {
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        result
      })
    );
  }

  sendError(id: number | string, code: number, message: string): void {
    this.socket.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: {
          code,
          message
        }
      })
    );
  }

  async readFile(filePath: string): Promise<Uint8Array> {
    const buffer = await fsReadFile(filePath);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  }

  async writeFile(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<void> {
    await mkdir(path.dirname(filePath), { recursive: true });
    if (typeof data === "string") {
      await fsWriteFile(filePath, data);
    } else if (data instanceof Uint8Array) {
      await fsWriteFile(filePath, data);
    } else {
      await fsWriteFile(filePath, Buffer.from(data));
    }
  }

  closeSocket(): void {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
      this.socket.close();
    }
  }

  terminate(): void {
    if (this.child.exitCode === null) {
      this.child.kill("SIGTERM");
    }
  }

  rejectPendingRequests(message: string): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }

  onNotification(listener: (notification: JsonRpcNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onRequest(listener: (request: JsonRpcRequest) => void): () => void {
    this.requestListeners.add(listener);
    return () => this.requestListeners.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private dispatchResponse(response: JsonRpcSuccess | JsonRpcFailure): void {
    const pending = this.pendingRequests.get(response.id);
    if (!pending) return;

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(response.id);

    if ("error" in response) {
      pending.reject(new Error(response.error.message));
      return;
    }
    pending.resolve(response.result);
  }

  private attachHandlers(): void {
    this.child.on("exit", (code, signal) => {
      for (const listener of this.exitListeners) {
        listener(code, signal);
      }
    });

    this.socket.addEventListener("message", (event) => {
      const raw =
        typeof event.data === "string"
          ? event.data
          : event.data instanceof ArrayBuffer
            ? textDecoder.decode(event.data)
            : "";
      if (!raw) {
        return;
      }

      const parsed = parseJsonRpcMessage(raw);
      if (!parsed) {
        // Malformed JSON or unknown shape — drop silently (matches prior behavior).
        return;
      }

      switch (parsed.kind) {
        case "request":
          for (const listener of this.requestListeners) {
            listener(parsed.request);
          }
          return;
        case "response":
          this.dispatchResponse(parsed.response);
          return;
        case "notification":
          for (const listener of this.notificationListeners) {
            listener(parsed.notification);
          }
          return;
      }
    });

    this.socket.addEventListener("close", () => {
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }
}

async function connectWebSocket(url: string, startTimeoutMs: number): Promise<WebSocket> {
  const deadline = Date.now() + startTimeoutMs;

  while (Date.now() < deadline) {
    try {
      return await new Promise<WebSocket>((resolve, reject) => {
        const socket = new WebSocket(url);

        const onOpen = () => {
          socket.removeEventListener("error", onError);
          resolve(socket);
        };

        const onError = () => {
          socket.removeEventListener("open", onOpen);
          socket.close();
          reject(new Error("WebSocket connection failed"));
        };

        socket.addEventListener("open", onOpen, { once: true });
        socket.addEventListener("error", onError, { once: true });
      });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  throw new Error(`Timed out connecting to Codex runtime at ${url}.`);
}

async function allocatePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Unable to allocate a runtime port."));
        return;
      }

      const { port } = address;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
    server.on("error", reject);
  });
}
