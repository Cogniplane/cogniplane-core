import { execFileSync } from "node:child_process";

const requiredPorts = [
  { port: 3000, name: "frontend" },
  { port: 3001, name: "backend" }
];

function readListeners(port) {
  try {
    const output = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();

    const lines = output
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter(Boolean);

    return lines.map((line) => {
      const columns = line.split(/\s+/);
      return {
        command: columns[0] ?? "unknown",
        pid: columns[1] ?? "unknown",
        name: columns.at(-1) ?? `:${port}`
      };
    });
  } catch (error) {
    const stderr = error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
    if (stderr.includes("No such file or directory") || stderr.includes("not found")) {
      return [];
    }

    return [];
  }
}

const conflicts = requiredPorts
  .map((entry) => ({
    ...entry,
    listeners: readListeners(entry.port)
  }))
  .filter((entry) => entry.listeners.length > 0);

if (conflicts.length === 0) {
  process.exit(0);
}

console.error("Local dev preflight failed: required ports are already in use.\n");

for (const conflict of conflicts) {
  console.error(`${conflict.name} port ${conflict.port}:`);
  for (const listener of conflict.listeners) {
    console.error(`- ${listener.command} (pid ${listener.pid}) listening on ${listener.name}`);
  }
  console.error("");
}

console.error("Stop the conflicting process or free the port, then retry.");
console.error("If you still have the Docker stack running, use `make compose-down` first.");

process.exit(1);
