import { ApiError } from "./api-client";

export function toErrorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

function getErrorMessage(error: unknown): string | null {
  return error instanceof Error ? error.message : null;
}

export function isRouteNotFoundError(
  error: unknown,
  method: "GET" | "POST" | "PUT" | "DELETE",
  pathPrefix: string
): boolean {
  // The backend answers an unknown route with 404 { error: "not_found" }. No
  // route sends that code for a missing resource.
  if (error instanceof ApiError && error.status === 404 && error.code === "not_found") {
    return error.method === method && error.path.startsWith(pathPrefix);
  }
  // Backends before 2026-06-13 sent Fastify's default "Route GET:/path not found".
  const message = getErrorMessage(error);
  if (!message) {
    return false;
  }

  return message.startsWith(`Route ${method}:${pathPrefix}`) && message.endsWith(" not found");
}

export function toRouteUnavailableMessage(
  error: unknown,
  options: {
    method: "GET" | "POST" | "PUT" | "DELETE";
    pathPrefix: string;
    featureName: string;
    fallback: string;
  }
): string {
  if (isRouteNotFoundError(error, options.method, options.pathPrefix)) {
    return `${options.featureName} is not available on this deployment yet.`;
  }

  return toErrorMessage(error, options.fallback);
}
