import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const flags = process.env.VITEST_DISABLE_CONCURRENT_RECOMPILATION === "1"
  ? ["--no-concurrent-recompilation", "--no-maglev"]
  : [];
const cli = fileURLToPath(new URL("../node_modules/vitest/vitest.mjs", import.meta.url));
const result = spawnSync(process.execPath, [...process.execArgv, ...flags, cli, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (result.error) throw result.error;
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
