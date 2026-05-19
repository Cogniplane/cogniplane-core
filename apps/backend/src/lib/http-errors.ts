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

/**
 * Format a Zod validation error into a standard API error response body.
 */
export function validationError(error: ZodError): ApiError {
  return {
    error: "invalid_request",
    details: error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message
    }))
  };
}

/**
 * Create a standard not-found error response.
 */
export function notFoundError(error: string): ApiError {
  return { error };
}

/**
 * Create a standard API error with a code and optional human-readable message.
 */
export function apiError(error: string, message?: string): ApiError {
  return message ? { error, message } : { error };
}

/**
 * Create an invalid_request error with hand-built detail entries.
 * Use this for request-level validation that isn't driven by a Zod schema.
 */
export function requestError(details: Array<{ path: string; message: string }>): ApiError {
  return { error: "invalid_request", details };
}

/**
 * Extract a human-readable message from an unknown caught error value.
 */
export function getErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}
