import { describe, expect, test } from "vitest";

import { buildArtifactStorageKey } from "./artifact-storage-key.js";

const UUID_V7 = "[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

function keyFor(artifactName: string, tenantId = "tenant-a"): string {
  return buildArtifactStorageKey({ tenantId, userId: "user-1", sessionId: "session-1", artifactName });
}

// The last segment is `<uuidv7><extension>`; a UUID has 36 characters.
function extensionOf(storageKey: string): string {
  return storageKey.slice(storageKey.lastIndexOf("/") + 1).slice(36);
}

describe("buildArtifactStorageKey", () => {
  test("puts the tenant first: <tenantId>/<userId>/<sessionId>/<uuidv7><extension>", () => {
    expect(keyFor("report.csv")).toMatch(new RegExp(`^tenant-a/user-1/session-1/${UUID_V7}\\.csv$`));
  });

  test("gives the same user and session a different prefix in each tenant", () => {
    expect(keyFor("report.csv", "tenant-a").startsWith("tenant-a/user-1/session-1/")).toBe(true);
    expect(keyFor("report.csv", "tenant-b").startsWith("tenant-b/user-1/session-1/")).toBe(true);
  });

  test("gives each object a new key", () => {
    expect(keyFor("report.csv")).not.toBe(keyFor("report.csv"));
  });

  test.each([
    ["a plain extension", "report.csv", ".csv"],
    ["the last of several extensions", "archive.tar.gz", ".gz"],
    ["an upper-case extension", "Scan.PDF", ".PDF"],
    ["no extension", "README", ""],
    ["a dot file", ".env", ""],
    ["a dot in a folder name only", "reports.v2/summary", ""],
    ["unsafe characters", "weird.tar.g$", ".g"],
    ["a long extension", `notes.${"a".repeat(40)}`, `.${"a".repeat(31)}`]
  ])("keeps only a safe extension for %s", (_label, artifactName, extension) => {
    expect(extensionOf(keyFor(artifactName))).toBe(extension);
  });

  test("never copies folders from the name into the key", () => {
    const storageKey = keyFor("../../tmp/run.sh");

    expect(storageKey).toMatch(new RegExp(`^tenant-a/user-1/session-1/${UUID_V7}\\.sh$`));
  });
});
