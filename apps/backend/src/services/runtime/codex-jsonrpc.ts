/**
 * Codex JSON-RPC transport types and the runtime-process handle contract.
 *
 * These are shared by the live E2B runtime path (`e2b-runtime-process.ts`), the
 * turn orchestrator, the request handler, and the approval coordinator. The
 * concrete WebSocket-based `CodexRuntimeProcess` that originally defined them
 * was removed with the in-process local execution mode (E2B is the only
 * execution backend now), so these contracts live here independent of any one
 * implementation.
 */

export type JsonRpcSuccess = {
  id: number | string;
  result: unknown;
};

export type JsonRpcFailure = {
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

/**
 * Thrown when a Codex runtime process fails to start. Carries the allocated
 * port and the child process id (when known) for diagnostics. The session
 * lifecycle wraps non-typed startup errors into this so callers can branch on
 * `instanceof`.
 */
export class CodexRuntimeProcessStartError extends Error {
  constructor(
    message: string,
    readonly port: number,
    readonly processId: number | null
  ) {
    super(message);
  }
}

/**
 * The interface the rest of the backend uses to drive a Codex runtime process,
 * regardless of transport. `E2bRuntimeProcess` is the only implementation.
 *
 * `terminate()` ends the process and fires registered close listeners; there is
 * no separate socket-close step (the WebSocket transport that needed one was
 * removed with the in-process local mode). Liveness is reported via `isAlive()`.
 */
export interface RuntimeProcessHandle {
  readonly port: number;
  readonly pid: number | null;
  isAlive(): boolean;
  sendRequest<T>(method: string, params: Record<string, unknown>): Promise<T>;
  sendNotification(method: string, params?: Record<string, unknown>): void;
  terminate(): void;
  sendResponse(id: number | string, result: unknown): void;
  sendError(id: number | string, code: number, message: string): void;
  rejectPendingRequests(message: string): void;
  readFile(filePath: string): Promise<Uint8Array>;
  writeFile(filePath: string, data: Uint8Array | ArrayBuffer | string): Promise<void>;
  onNotification(listener: (notification: JsonRpcNotification) => void): () => void;
  onRequest(listener: (request: JsonRpcRequest) => void): () => void;
  onClose(listener: () => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
}
