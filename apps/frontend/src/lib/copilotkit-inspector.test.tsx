// @vitest-environment jsdom
//
// The app gate of the CopilotKit Inspector. The chat host test covers the
// gate with the real provider and the real Inspector package.

import { shouldEnableInspector } from "@copilotkit/shared";
import { cleanup, render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isInspectorAllowed, useInspectorOptIn } from "./copilotkit-inspector";

type JsdomInstance = { reconfigure(options: { url: string }): void };
const jsdom = (globalThis as unknown as { jsdom: JsdomInstance }).jsdom;

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  jsdom.reconfigure({ url: "http://localhost:3000/" });
});

const LOCAL = { optIn: "1", nodeEnv: "development", hostname: "localhost" };

describe("isInspectorAllowed", () => {
  it.each(["localhost", "127.0.0.1", "[::1]"])("opens for the opt-in in a development build on %s", (hostname) => {
    expect(isInspectorAllowed({ ...LOCAL, hostname })).toBe(true);
  });

  it.each([undefined, "", "0", "true", "yes", "on", " 1", "1 ", "01"])("stays closed for the opt-in value %j", (optIn) => {
    expect(isInspectorAllowed({ ...LOCAL, optIn })).toBe(false);
  });

  it.each([undefined, "production", "test", "Development"])("stays closed for NODE_ENV %j", (nodeEnv) => {
    expect(isInspectorAllowed({ ...LOCAL, nodeEnv })).toBe(false);
  });

  it.each([null, "", "0.0.0.0", "::1", "127.0.0.2", "localhost.example", "cogniplane.example", "192.168.1.37"])(
    "stays closed on the hostname %j",
    (hostname) => {
      expect(isInspectorAllowed({ ...LOCAL, hostname })).toBe(false);
    }
  );
});

function GateProbe() {
  return <span data-testid="gate">{String(useInspectorOptIn())}</span>;
}

const renderedGate = () => render(<GateProbe />).getByTestId("gate").textContent;

describe("useInspectorOptIn", () => {
  it("reads the opt-in, the build, and the page hostname in the browser", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(renderedGate()).toBe("true");
  });

  it("is false without the opt-in", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", undefined);
    vi.stubEnv("NODE_ENV", "development");
    expect(renderedGate()).toBe("false");
  });

  it("is false in a production build and in tests", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(renderedGate()).toBe("false");
    cleanup();
    vi.stubEnv("NODE_ENV", "test");
    expect(renderedGate()).toBe("false");
  });

  it("is false on a host that is not loopback", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
    vi.stubEnv("NODE_ENV", "development");
    jsdom.reconfigure({ url: "https://cogniplane.example/chat" });
    expect(renderedGate()).toBe("false");
  });

  it("is false in the server render, even when the browser gate is open", () => {
    vi.stubEnv("NEXT_PUBLIC_COPILOTKIT_INSPECTOR", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(renderToString(<GateProbe />)).toContain(">false<");
  });
});

// The app gate depends on these facts of the pinned CopilotKit gate. An
// upgrade that changes them fails here.
describe("CopilotKit 1.85.0 Inspector gate", () => {
  it("is on by default in a development browser, so the host must pass false", () => {
    expect(shouldEnableInspector({ enableInspector: undefined, isBrowser: true, isDevelopment: true })).toBe(true);
    expect(shouldEnableInspector({ enableInspector: false, isBrowser: true, isDevelopment: true })).toBe(false);
  });

  it("keeps an explicit true off in production and outside a browser", () => {
    expect(shouldEnableInspector({ enableInspector: true, isBrowser: true, isDevelopment: false })).toBe(false);
    expect(shouldEnableInspector({ enableInspector: true, isBrowser: false, isDevelopment: true })).toBe(false);
  });
});
