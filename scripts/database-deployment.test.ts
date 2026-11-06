import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { parse } from "yaml";

test.each(["compose.yaml"])("%s separates migration from runtime", async file => {
  const { services } = parse(await readFile(file, "utf8"));
  expect(services.migrate.command).toEqual(["node", "apps/backend/dist/scripts/migrate.js"]);
  expect(services.migrate.restart).toBe("no");
  expect(services.backend.depends_on.migrate.condition).toBe("service_completed_successfully");
  // In the homelab stack, explicit empty values override the shared env file.
  expect(services.backend.environment.MIGRATION_DATABASE_URL || "").toBe("");
  expect(services.backend.environment.POSTGRES_PASSWORD || "").toBe("");
  expect(services.backend.environment.APP_USER_PASSWORD || "").toBe("");
});

test("compose exposure guard refuses a non-loopback bind while any default credential is active", async () => {
  const { services } = parse(await readFile("compose.yaml", "utf8"));
  const guard = services["exposure-guard"];
  // Compose writes a literal `$` as `$$`. The shell sees the script with single `$`.
  const script = (guard.command[0] as string).replaceAll("$$", "$");
  const changed = {
    POSTGRES_PASSWORD: "owner-secret", APP_USER_PASSWORD: "app-secret",
    MAINTENANCE_USER_PASSWORD: "maintenance-secret", DEV_HEADERS_AUTH_KEY: "headers-secret"
  };
  const run = (env: Record<string, string>) => promisify(execFile)("sh", ["-ec", script], { env: { PATH: process.env.PATH, ...env } })
    .then(() => 0, (error: { code?: number }) => error.code ?? -1);

  expect(Object.keys(guard.environment).sort()).toEqual(["POSTGRES_BIND_ADDR", ...Object.keys(changed)].sort());
  expect(await run({ POSTGRES_BIND_ADDR: "10.0.0.5", ...changed })).toBe(0);
  expect(await run({ POSTGRES_BIND_ADDR: "127.0.0.1", ...changed, MAINTENANCE_USER_PASSWORD: "local-dev-maintenance-password" })).toBe(0);
  // maintenance_user has BYPASSRLS: its default password must block an exposed bind like the others.
  for (const [name, value] of Object.entries({
    POSTGRES_PASSWORD: "postgres", APP_USER_PASSWORD: "local-dev-app-user-password",
    MAINTENANCE_USER_PASSWORD: "local-dev-maintenance-password", DEV_HEADERS_AUTH_KEY: "local-dev-headers-auth-key"
  })) {
    expect(await run({ POSTGRES_BIND_ADDR: "10.0.0.5", ...changed, [name]: value }), name).toBe(1);
  }
});

test("server entrypoint removes bootstrap credentials and never starts migrations", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "cogniplane-entrypoint-"));
  try {
    await writeFile(path.join(dir, "node"), `#!/bin/sh
set -eu
test -z "\${MIGRATION_DATABASE_URL+x}"
test -z "\${POSTGRES_PASSWORD+x}"
test -z "\${APP_USER_PASSWORD+x}"
test -z "\${MAINTENANCE_USER_PASSWORD+x}"
test "$MAINTENANCE_DATABASE_URL" = maintenance-fixture
test "$DATABASE_URL" = app-fixture
printf '%s\\n' "$*"
`, { mode: 0o755 });
    const { stdout } = await promisify(execFile)("sh", ["docker/backend-entrypoint.sh"], {
      env: {
        ...process.env, PATH: `${dir}:${process.env.PATH}`,
        MIGRATION_DATABASE_URL: "migration-fixture", POSTGRES_PASSWORD: "owner-fixture",
        APP_USER_PASSWORD: "bootstrap-fixture", MAINTENANCE_USER_PASSWORD: "bootstrap-fixture",
        DATABASE_URL: "app-fixture", MAINTENANCE_DATABASE_URL: "maintenance-fixture"
      }
    });
    expect(stdout).toBe("apps/backend/dist/server.js\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
