import { expect, test } from "vitest";

import { AdminConfigError } from "../services/admin-config-error.js";
import { GithubConnectionNotConfiguredError } from "../services/integrations/github/github-connection-errors.js";
import { clientSafeToolErrorMessage, ToolCallError } from "./tool-call-error.js";

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
  // Caught in review: this is thrown by getRuntimeCredentials, which every
  // GitHub managed tool calls, and "the integration is not configured" is
  // exactly what a user needs to hear. It carries no name in the passthrough
  // list, so it needs the 4xx statusCode to survive — and the first version of
  // this classifier silently collapsed it.
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
