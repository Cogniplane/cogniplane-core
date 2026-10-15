import { spawnSync } from "node:child_process";

const requiredPorts = [
  { port: 3000, name: "frontend" },
  { port: 3001, name: "backend" }
];

// The preflight cannot tell if a port is free. This is not the same as a port conflict.
class PortInspectionError extends Error {}

function lsofArgs(port) {
  // -w stops lsof warnings, for example about unreadable mounts, on the diagnostic channel.
  return ["-nP", "-w", `-iTCP:${port}`, "-sTCP:LISTEN"];
}

function readListeners({ port, name }) {
  const result = spawnSync("lsof", lsofArgs(port), {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdout = (result.stdout ?? "").trim();
  const stderr = (result.stderr ?? "").trim();

  if (result.error?.code === "ENOENT") {
    throw new PortInspectionError(
      [
        "lsof is not installed or is not on PATH. The preflight uses lsof to find listeners on ports 3000 and 3001.",
        "Install lsof, then retry:",
        "- Debian, Ubuntu or WSL: sudo apt-get install lsof",
        "- Fedora or RHEL: sudo dnf install lsof",
        "- macOS: lsof is in /usr/sbin. Add /usr/sbin to PATH."
      ].join("\n")
    );
  }

  // lsof exits with status 1 and writes nothing when no process listens on the port.
  const noListeners = result.status === 1 && stdout === "" && stderr === "";
  if (result.error || result.signal || (result.status !== 0 && !noListeners)) {
    const reason = result.error
      ? `lsof did not start: ${result.error.message}`
      : result.signal
        ? `lsof stopped on signal ${result.signal}.`
        : `lsof exited with status ${result.status}.`;
    throw new PortInspectionError(
      [
        `Cannot inspect ${name} port ${port}. ${reason}`,
        ...(stderr ? [`lsof stderr: ${stderr}`] : []),
        `Run \`lsof ${lsofArgs(port).join(" ")}\` to examine the problem, correct it, then retry.`
      ].join("\n")
    );
  }
  if (noListeners) {
    return [];
  }

  const lines = stdout
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => {
    // Columns: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME, and NAME can contain spaces.
    const columns = line.split(/\s+/);
    return {
      command: columns[0] ?? "unknown",
      pid: columns[1] ?? "unknown",
      name: columns.slice(8).join(" ") || `:${port}`
    };
  });
}

let conflicts;
try {
  conflicts = requiredPorts
    .map((entry) => ({
      ...entry,
      listeners: readListeners(entry)
    }))
    .filter((entry) => entry.listeners.length > 0);
} catch (error) {
  if (!(error instanceof PortInspectionError)) {
    throw error;
  }
  console.error("Local dev preflight failed: cannot check if the required ports are free.\n");
  console.error(error.message);
  process.exit(2);
}

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
