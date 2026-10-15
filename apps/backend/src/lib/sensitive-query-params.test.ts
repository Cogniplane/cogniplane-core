import { expect, test } from "vitest";

import { isCredentialQueryParameterName, isSensitiveQueryParameterName } from "./sensitive-query-params.js";

const VALIDATION_NAMES = [
  "token", "access_token", "api-key", "X_API_KEY", "client_secret", "key", "secret", "password",
  "auth", "authorization", "bearer", "sig", "signature"
];

test.each(VALIDATION_NAMES)("%s is refused by validation and redacted", (name) => {
  expect(isCredentialQueryParameterName(name)).toBe(true);
  expect(isSensitiveQueryParameterName(name)).toBe(true);
});

test.each(["accessToken", "refreshtoken", "idtoken", "apikey", "clientsecret", "api%2Dkey", "x%5Fapi%5Fkey"])(
  "%s is redacted",
  (name) => {
    expect(isSensitiveQueryParameterName(name)).toBe(true);
  }
);

test.each(["refreshtoken", "idtoken"])("%s stays accepted by URL validation, so saved URLs keep loading", (name) => {
  expect(isCredentialQueryParameterName(name)).toBe(false);
});

test.each(["page", "cursor", "pageToken", "monkey", "keyword", "serverId", "toolContextId", "%E0%A4%A"])(
  "%s is not a credential query name",
  (name) => {
    expect(isSensitiveQueryParameterName(name)).toBe(false);
  }
);
