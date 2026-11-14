import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const backendRoot = fileURLToPath(new URL("../..", import.meta.url));

// Functions that the child script can use:
// - importSource(path): imports a source file, relative to apps/backend.
// - timed(run): calls run() once and returns { ms, result }.
// - print(value): writes value as JSON; runIsolated returns the last print.
const PRELUDE = `
const { pathToFileURL } = await import("node:url");
const importSource = (path) => import(pathToFileURL(${JSON.stringify(backendRoot)} + path).href);
const timed = (run) => { const start = performance.now(); const result = run(); return { ms: performance.now() - start, result }; };
const print = (value) => console.log(JSON.stringify(value));
`;

/**
 * Runs an ES module script in a new Node process with the tsx loader and
 * returns the value of its last `print`.
 *
 * Use it for large-input performance tests. A Vitest timeout cannot stop
 * synchronous code, so a quadratic regression would block the test worker for
 * hours. The child gets SIGKILL after `killAfterMs` and the test fails.
 */
export function runIsolated<T>(script: string, killAfterMs = 30_000): T {
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", PRELUDE + script], {
    cwd: backendRoot,
    encoding: "utf8",
    killSignal: "SIGKILL",
    timeout: killAfterMs
  });
  if (child.error) {
    throw new Error(`The child process did not finish in ${killAfterMs} ms: ${child.error.message}`);
  }
  if (child.status !== 0) {
    throw new Error(`The child process failed (${child.signal ?? child.status}): ${child.stderr}`);
  }
  const lines = child.stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]!) as T;
}

/** A small deterministic generator, so a failing random case can be replayed. */
export function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) & 0x7fffffff;
    return state / 0x80000000;
  };
}

/** Joins up to `maxParts` random parts of `alphabet`. */
export function randomText(random: () => number, alphabet: readonly string[], maxParts: number): string {
  let text = "";
  const parts = Math.floor(random() * (maxParts + 1));
  for (let i = 0; i < parts; i += 1) text += alphabet[Math.floor(random() * alphabet.length)];
  return text;
}
