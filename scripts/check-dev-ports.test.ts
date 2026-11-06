import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, test } from "vitest";

// These tests run the real CLI with PATH set to a temporary directory. A shell shim replaces lsof,
// so no test reads or changes a real listener. The absolute Node.js path makes PATH unnecessary for Node.js.
const script = resolve("scripts/check-dev-ports.mjs");
const header = "COMMAND   PID    USER   FD   TYPE DEVICE SIZE/OFF NODE NAME";
const noListeners = "exit 1";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function emptyBinDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "check-dev-ports-test-"));
  roots.push(dir);
  return dir;
}

// Each value is the shell body that the shim runs for that port. Other arguments fail with status 99.
async function lsofShim(byPort: { 3000: string; 3001: string }): Promise<string> {
  const dir = await emptyBinDir();
  const shim = join(dir, "lsof");
  await writeFile(shim, [
    "#!/bin/sh",
    'case "$*" in',
    `  "-nP -w -iTCP:3000 -sTCP:LISTEN") ${byPort[3000]} ;;`,
    `  "-nP -w -iTCP:3001 -sTCP:LISTEN") ${byPort[3001]} ;;`,
    "esac",
    'echo "unexpected lsof arguments: $*" >&2',
    "exit 99",
    ""
  ].join("\n"));
  await chmod(shim, 0o755);
  return dir;
}

function listening(...rows: string[]): string {
  return `printf '%s\\n' '${header}' ${rows.map((row) => `'${row}'`).join(" ")}; exit 0`;
}

function runPreflight(binDir: string) {
  const result = spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { PATH: binDir },
    timeout: 15_000
  });
  return { status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr };
}

test("passes when lsof exits 1 with no output for both ports", async () => {
  const result = runPreflight(await lsofShim({ 3000: noListeners, 3001: noListeners }));

  expect(result).toEqual({ status: 0, signal: null, stdout: "", stderr: "" });
});

test("passes when lsof succeeds with empty or header-only output", async () => {
  const result = runPreflight(await lsofShim({ 3000: "exit 0", 3001: listening() }));

  expect(result).toEqual({ status: 0, signal: null, stdout: "", stderr: "" });
});

test("reports command, PID and address of a listener on the second port", async () => {
  const result = runPreflight(await lsofShim({
    3000: noListeners,
    3001: listening("node    4242 dev   23u  IPv6 0x1234      0t0  TCP *:3001 (LISTEN)")
  }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("required ports are already in use");
  expect(result.stderr).toContain("backend port 3001:\n- node (pid 4242) listening on *:3001 (LISTEN)");
  expect(result.stderr).not.toContain("frontend port 3000");
  expect(result.stderr).toContain("make compose-down");
});

test("reports every listener on both ports", async () => {
  const result = runPreflight(await lsofShim({
    3000: listening("next-serv 101 dev 20u IPv4 0x1 0t0 TCP 127.0.0.1:3000 (LISTEN)"),
    3001: listening(
      "com.docke 202 dev 30u IPv4 0x2 0t0 TCP *:3001 (LISTEN)",
      "com.docke 202 dev 31u IPv6 0x3 0t0 TCP *:3001 (LISTEN)"
    )
  }));

  expect(result.status).toBe(1);
  expect(result.stderr).toContain("frontend port 3000:\n- next-serv (pid 101) listening on 127.0.0.1:3000 (LISTEN)");
  expect(result.stderr).toContain(
    "backend port 3001:\n"
    + "- com.docke (pid 202) listening on *:3001 (LISTEN)\n"
    + "- com.docke (pid 202) listening on *:3001 (LISTEN)"
  );
});

test("fails with installation advice when lsof is not on PATH", async () => {
  const result = runPreflight(await emptyBinDir());

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("cannot check if the required ports are free");
  expect(result.stderr).toContain("lsof is not installed or is not on PATH");
  expect(result.stderr).toContain("sudo apt-get install lsof");
  expect(result.stderr).not.toContain("already in use");
});

test("fails when lsof exits 1 with a diagnostic on the second port", async () => {
  const result = runPreflight(await lsofShim({
    3000: noListeners,
    3001: "echo 'lsof: status error on /proc/1: Permission denied' >&2; exit 1"
  }));

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Cannot inspect backend port 3001. lsof exited with status 1.");
  expect(result.stderr).toContain("lsof stderr: lsof: status error on /proc/1: Permission denied");
  expect(result.stderr).toContain("Run `lsof -nP -w -iTCP:3001 -sTCP:LISTEN`");
});

test("fails when lsof exits 1 with output on stdout only", async () => {
  const result = runPreflight(await lsofShim({ 3000: "echo partial; exit 1", 3001: noListeners }));

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Cannot inspect frontend port 3000. lsof exited with status 1.");
});

test("fails on an unexpected exit status even after a listener is found", async () => {
  const result = runPreflight(await lsofShim({
    3000: listening("node 4242 dev 23u IPv6 0x1 0t0 TCP *:3000 (LISTEN)"),
    3001: "exit 2"
  }));

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Cannot inspect backend port 3001. lsof exited with status 2.");
  expect(result.stderr).not.toContain("lsof stderr:");
});

test("fails when lsof stops on a signal", async () => {
  const result = runPreflight(await lsofShim({ 3000: noListeners, 3001: "kill -TERM $$" }));

  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Cannot inspect backend port 3001. lsof stopped on signal SIGTERM.");
});
