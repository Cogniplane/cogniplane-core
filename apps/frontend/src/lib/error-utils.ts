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
