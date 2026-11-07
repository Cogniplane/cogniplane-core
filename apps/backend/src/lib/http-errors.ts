import type { ZodError } from "zod";

/**
 * Standard API error envelope used across all REST endpoints.
 * JSON-RPC endpoints (MCP routes) use the JSON-RPC 2.0 error format instead.
 */
export type ApiError = {
  error: string;
  message?: string;
  details?: Array<{ path: string; message: string }>;
};

export function validationError(error: ZodError): ApiError {
  return {
    error: "invalid_request",
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

export function notFoundError(error: string): ApiError {
  return { error };
}

export function apiError(error: string, message?: string): ApiError {
  return message ? { error, message } : { error };
}

/**
 * Use this for request-level validation that is not driven by a Zod schema.
 */
export function requestError(details: Array<{ path: string; message: string }>): ApiError {
  return { error: "invalid_request", details };
}

/**
 * Returns the message of an Error. Any other value gives the fallback.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
