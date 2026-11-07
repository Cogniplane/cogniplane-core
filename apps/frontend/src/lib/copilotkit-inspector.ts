// The app gate of the CopilotKit Inspector, a development tool that shows the
// messages, state, and AG-UI events of the chat agent. See "Development
// Inspector" in docs/ARCHITECTURE.md.
//
// CopilotKit 1.85.0 enables the Inspector by default in development: only an
// explicit `enableInspector={false}` turns it off. So the chat host always
// passes this gate as a boolean. The gate opens only when all are true:
//   - the developer set NEXT_PUBLIC_COPILOTKIT_INSPECTOR to exactly "1";
//   - the build is a development build (NODE_ENV "development");
//   - the page is in a browser on a loopback hostname.
// The server render and a test environment get false. CopilotKit then does
// its own checks (development, browser, loopback hostname) before it loads
// the Inspector package.

import { useSyncExternalStore } from "react";

export const INSPECTOR_OPT_IN_VALUE = "1";

// The hostnames that CopilotKit 1.85.0 also accepts. `window.location.hostname`
// keeps the brackets of an IPv6 address.
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type InspectorGateInput = {
  /** The value of NEXT_PUBLIC_COPILOTKIT_INSPECTOR. */
  optIn: string | undefined;
  nodeEnv: string | undefined;
  /** The page hostname, or null outside a browser. */
  hostname: string | null;
};

export function isInspectorAllowed({ optIn, nodeEnv, hostname }: InspectorGateInput): boolean {
  return optIn === INSPECTOR_OPT_IN_VALUE
    && nodeEnv === "development"
    && hostname !== null
    && LOOPBACK_HOSTNAMES.has(hostname);
}

function readInspectorGate(): boolean {
  return isInspectorAllowed({
    // Next.js puts NEXT_PUBLIC_ values in the browser bundle only for a
    // literal `process.env.NAME` read.
    optIn: process.env.NEXT_PUBLIC_COPILOTKIT_INSPECTOR,
    nodeEnv: process.env.NODE_ENV,
    hostname: typeof window === "undefined" ? null : window.location.hostname
  });
}

const serverGate = () => false;
const noChanges = () => () => {};

/** True when this page may show the Inspector. The server render, and the
 *  first browser render that hydrates it, get false. */
export function useInspectorOptIn(): boolean {
  return useSyncExternalStore(noChanges, readInspectorGate, serverGate);
}
