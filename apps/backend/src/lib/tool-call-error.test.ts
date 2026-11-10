import { expect, test } from "vitest";

import { AdminConfigError } from "../services/admin-config-error.js";
import { GithubConnectionNotConfiguredError } from "../services/integrations/github/github-connection-errors.js";
import { clientSafeToolErrorMessage, ToolCallError, toolErrorForLog } from "./tool-call-error.js";

const FALLBACK = "Tool call failed.";

test("a ToolCallError message reaches the model verbatim", () => {
  const error = new ToolCallError("Managed tool memory_search is not allowed by runtime policy rp-1.");
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(error.message);
});

test("an AdminConfigError message reaches the model verbatim", () => {
  const error = new AdminConfigError("Skill bundle is missing SKILL.md.");
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(error.message);
});

test("a 4xx statusCode passes through — the app's client-safe convention", () => {
  const error = Object.assign(new Error("artifactId is required."), { statusCode: 400 });
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe("artifactId is required.");
});

test("a 4xx status (SDK convention) passes through too", () => {
  const error = Object.assign(new Error("Rate limited."), { status: 429 });
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe("Rate limited.");
});

test("an E2B sandbox id never reaches the model", () => {
  const error = new Error("sandbox i7x9k2mq0zt4vabc is not running");
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(FALLBACK);
});

test("an S3 bucket name never reaches the model", () => {
  const error = new Error(
    "NoSuchKey: The specified key does not exist. Bucket: cogniplane-prod-artifacts-us-east-1"
  );
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(FALLBACK);
});

test("a Postgres relation name never reaches the model", () => {
  const error = Object.assign(new Error('relation "tenant_org_settings" does not exist'), {
    code: "42P01"
  });
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(FALLBACK);
});

test("GithubConnectionNotConfiguredError reaches the model", () => {
  // This error comes from getRuntimeCredentials, which every GitHub managed
  // tool calls. The user needs its message. It has no name in the passthrough
  // list, so it must keep its 4xx statusCode to survive.
  const error = new GithubConnectionNotConfiguredError();
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(
    "GitHub App integration is not configured."
  );
});

test("a 5xx status is an internal fault and collapses", () => {
  const error = Object.assign(new Error("upstream db pool exhausted at 10.0.4.17:5432"), {
    statusCode: 503
  });
  expect(clientSafeToolErrorMessage(error, FALLBACK)).toBe(FALLBACK);
});

test("a non-Error throw collapses", () => {
  expect(clientSafeToolErrorMessage("postgres://user:pw@10.0.4.17/db", FALLBACK)).toBe(FALLBACK);
  expect(clientSafeToolErrorMessage(null, FALLBACK)).toBe(FALLBACK);
  expect(clientSafeToolErrorMessage({ message: "spoofed" }, FALLBACK)).toBe(FALLBACK);
});

test("classification is by name, so a duplicated module instance still passes through", () => {
  // instanceof breaks when a module is loaded twice (bundling, vitest module
  // graph). The name survives, which is why the classifier reads it.
  const impostor = new Error("Managed tool x is not allowed by runtime policy rp-1.");
  impostor.name = "ToolCallError";
  expect(impostor instanceof ToolCallError).toBe(false);
  expect(clientSafeToolErrorMessage(impostor, FALLBACK)).toBe(impostor.message);
});

test("a non-Error throw logs only its type", () => {
  expect(toolErrorForLog("postgres://user:pw@10.0.4.17/db")).toEqual({ type: "string" });
  expect(toolErrorForLog({ message: "spoofed", token: "abc" })).toEqual({ type: "object" });
});

test("the logged type is the class name, as pino's serializer writes it", () => {
  // pg's DatabaseError sets `name` to the protocol message name, "error".
  class DatabaseError extends Error {}
  const error = Object.assign(new DatabaseError("deadlock detected"), { name: "error", code: "40P01" });
  expect(toolErrorForLog(error)).toMatchObject({ type: "DatabaseError", message: "deadlock detected", code: "40P01" });
});

test("a cause chain that loops stops after three causes", () => {
  const error = new Error("outer");
  error.cause = error;
  let depth = 0;
  for (let logged = toolErrorForLog(error); logged.cause; logged = logged.cause) depth += 1;
  expect(depth).toBe(3);
});

test("an error whose getter throws logs as unknown instead of throwing", () => {
  const error = new Error("hidden");
  Object.defineProperty(error, "message", { get() { throw new Error("getter"); } });
  expect(toolErrorForLog(error)).toEqual({ type: "unknown" });
});


test("logged messages, stacks, codes and causes remove URL credentials", () => {
  const error = Object.assign(new Error("connect postgres://db-user:db-password@db.internal/app"), {
    code: "https://api-user:p%40ss@api.internal/failure",
    cause: new Error("fetch https://cause-user:cause-password@upstream.internal/tool")
  });
  const logged = toolErrorForLog(error);
  expect(logged.message).toBe("connect postgres://[REDACTED]@db.internal/app");
  expect(logged.stack).toContain(logged.message);
  expect(logged.code).toBe("https://[REDACTED]@api.internal/failure");
  expect(logged.cause?.message).toBe("fetch https://[REDACTED]@upstream.internal/tool");
  for (const secret of ["db-user", "db-password", "api-user", "p%40ss", "cause-user", "cause-password"]) {
    expect(JSON.stringify(logged)).not.toContain(secret);
  }
});
