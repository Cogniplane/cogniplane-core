import { expect, it } from "vitest";

import { ApiError } from "./api-client";
import { isRouteNotFoundError, toRouteUnavailableMessage } from "./error-utils";

const routeMissing = (method: string, path: string) =>
  new ApiError({ status: 404, code: "not_found", method, path, message: "not_found" });

it("recognizes the current backend's unknown-route 404 for the matching method and path", () => {
  const error = routeMissing("GET", "/admin/sessions?status=errored");

  expect(isRouteNotFoundError(error, "GET", "/admin/sessions")).toBe(true);
  expect(isRouteNotFoundError(error, "POST", "/admin/sessions")).toBe(false);
  expect(isRouteNotFoundError(error, "GET", "/admin/users")).toBe(false);
});

it("recognizes an older backend's Fastify message", () => {
  expect(isRouteNotFoundError(new Error("Route GET:/admin/sessions/s1 not found"), "GET", "/admin/sessions")).toBe(true);
  expect(isRouteNotFoundError(new Error("Route GET:/admin/users not found"), "GET", "/admin/sessions")).toBe(false);
});

it("does not mistake a missing resource for a missing route", () => {
  const sessionMissing = new ApiError({
    status: 404, code: "session_not_found", method: "GET", path: "/admin/sessions/s1", message: "session_not_found"
  });

  expect(isRouteNotFoundError(sessionMissing, "GET", "/admin/sessions")).toBe(false);
  expect(isRouteNotFoundError("not an error", "GET", "/admin/sessions")).toBe(false);
});

it("names the unavailable feature, or falls back to the error's own message", () => {
  const options = { method: "GET" as const, pathPrefix: "/admin/sessions", featureName: "Session review", fallback: "Failed." };

  expect(toRouteUnavailableMessage(routeMissing("GET", "/admin/sessions"), options))
    .toBe("Session review is not available on this deployment yet.");
  expect(toRouteUnavailableMessage(new Error("Database is busy."), options)).toBe("Database is busy.");
});
