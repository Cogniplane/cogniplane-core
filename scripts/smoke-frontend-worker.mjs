import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const frontendDir = fileURLToPath(new URL("../apps/frontend/", import.meta.url));
const scratch = await mkdtemp(join(tmpdir(), "cogniplane-worker-smoke-"));
const listener = createServer();
listener.listen(0, "127.0.0.1");
await once(listener, "listening");
const port = listener.address().port;
await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));

const worker = spawn("pnpm", [
  "exec", "wrangler", "dev", "--local", "--ip", "127.0.0.1",
  "--port", String(port), "--inspector-port", "0",
  "--env-file", "/dev/null", "--persist-to", join(scratch, "state"),
  "--log-level", "error"
], {
  cwd: frontendDir,
  detached: true,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false" }
});

let output = "";
let ended = false;
let spawnError;
for (const stream of [worker.stdout, worker.stderr]) {
  stream.on("data", (chunk) => { output = (output + chunk).slice(-32_768); });
}
worker.on("error", (error) => { spawnError = error; });
const closed = new Promise((resolve) => {
  worker.on("close", () => { ended = true; resolve(); });
});

try {
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 120_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    if (ended) throw new Error("The frontend Worker exited before it was ready.");
    try {
      await fetch(origin, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
      ready = true;
      break;
    } catch {
      await delay(250);
    }
  }
  assert.ok(ready, "The frontend Worker did not start within 120 seconds.");

  const response = await fetch(`${origin}/login`, {
    redirect: "manual",
    signal: AbortSignal.timeout(30_000)
  });
  const html = await response.text();
  assert.equal(response.status, 200, `/login returned HTTP ${response.status}: ${html.slice(0, 500)}`);
  assert.match(html, /Sign in to your workspace/, "The login page did not render.");
  assert.match(html, /Sign in with Email/, "The login form did not render.");
  console.log("Frontend Worker smoke check passed: /login renders in workerd.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  console.error(output);
  process.exitCode = 1;
} finally {
  if (worker.pid && !ended) {
    // Stop Wrangler and its local workerd process together.
    try { process.kill(-worker.pid, "SIGTERM"); } catch (error) {
      if (error.code !== "ESRCH") { console.error(error); process.exitCode = 1; }
    }
    await Promise.race([closed, delay(5_000)]);
    if (!ended) {
      try { process.kill(-worker.pid, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") { console.error(error); process.exitCode = 1; }
      }
      await closed;
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
