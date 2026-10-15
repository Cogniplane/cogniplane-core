// @vitest-environment jsdom
import { runInNewContext } from "node:vm";
import { afterEach, expect, it, vi } from "vitest";

import { CSP_INTERSECTION_VECTORS, CSP_SOURCE_VECTORS, type CspLists } from "@cogniplane/shared-types/csp-source-vectors";
import { MCP_APP_CSP_DIRECTIVES } from "@cogniplane/shared-types";

import { buildMcpAppSandboxHtml, scriptSafeJson } from "./mcp-app-sandbox-html";

const PARENT_ORIGIN = "https://chat.example.test";
const READY = { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} };

afterEach(() => {
  document.head.querySelectorAll("meta[http-equiv]").forEach((element) => element.remove());
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

type ProxyEvent = { source: unknown; origin: string; data: unknown };

function proxyScript(parentOrigin: string | null) {
  const parsed = new DOMParser().parseFromString(buildMcpAppSandboxHtml(parentOrigin), "text/html");
  return parsed.querySelector("script")!.textContent!;
}

function sandbox(parentOrigin: string | null = PARENT_ORIGIN) {
  const parent = { postMessage: vi.fn() };
  let receive!: (event: ProxyEvent) => void;
  runInNewContext(proxyScript(parentOrigin), {
    window: { self: {}, top: {}, parent,
      addEventListener: (_type: string, listener: typeof receive) => { receive = listener; } },
    document, DOMParser
  });
  const inner = document.querySelector("iframe")!;
  // The inner frame has an opaque origin. A message to it needs the target "*".
  const innerPost = vi.spyOn(inner.contentWindow!, "postMessage");
  const load = (html: string, csp?: Record<string, unknown>, source: unknown = parent, origin = PARENT_ORIGIN) => receive({
    source, origin, data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-resource-ready", params: { html, csp } }
  });
  return { parent, inner, innerPost, load, receive };
}

/** The sources of each list in the policy that the page put into the widget. */
function policyLists(srcdoc: string): Record<(typeof MCP_APP_CSP_DIRECTIVES)[number], string[]> {
  const content = new DOMParser().parseFromString(srcdoc, "text/html").head.firstElementChild!.getAttribute("content")!;
  const tokens = (name: string, skip: string[]) => {
    const part = content.split("; ").find((entry) => entry.startsWith(`${name} `));
    return (part?.slice(name.length + 1).split(" ") ?? []).filter((token) => token && !skip.includes(token));
  };
  return {
    resourceDomains: tokens("img-src", ["'self'", "data:"]),
    connectDomains: tokens("connect-src", ["'none'"]),
    frameDomains: tokens("frame-src", ["'none'"]),
    baseUriDomains: tokens("base-uri", ["'self'"])
  };
}

function approvedAndDeclared(declared: CspLists, approved: CspLists) {
  return { ...declared, approvedDomains: Object.fromEntries(MCP_APP_CSP_DIRECTIVES.map((key) => [key, approved[key] ?? []])) };
}

it.each(CSP_SOURCE_VECTORS.filter((vector) => !vector.needsSuffixList).map((vector) => [vector.name, vector] as const))(
  "applies the shared source rules to %s",
  (_name, vector) => {
    const { inner, load } = sandbox();
    load("<p>Widget</p>", approvedAndDeclared({ [vector.directive]: [vector.source] }, { [vector.directive]: [vector.source] }));
    const lists = policyLists(inner.srcdoc);
    expect(lists[vector.directive]).toEqual(vector.reason === null ? [vector.normalized] : []);
    for (const other of MCP_APP_CSP_DIRECTIVES.filter((key) => key !== vector.directive)) {
      expect(lists[other]).toEqual([]);
    }
  }
);

it.each(CSP_INTERSECTION_VECTORS.filter((vector) => !vector.needsSuffixList).map((vector) => [vector.name, vector] as const))(
  "intersects with the approved sources: %s",
  (_name, vector) => {
    const { inner, load } = sandbox();
    load("<p>Widget</p>", approvedAndDeclared(vector.declared, vector.approved));
    const lists = policyLists(inner.srcdoc);
    for (const key of MCP_APP_CSP_DIRECTIVES) expect(lists[key]).toEqual(vector.allowed[key] ?? []);
  }
);

it("installs an outer deny policy before executing generated content", () => {
  const { inner, load } = sandbox();
  let policyAtAssignment: string | null | undefined;
  const descriptor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "srcdoc")!;
  vi.spyOn(HTMLIFrameElement.prototype, "srcdoc", "set").mockImplementation(function (this: HTMLIFrameElement, html: string) {
    policyAtAssignment = document.head.querySelector("meta[http-equiv]")?.getAttribute("content");
    descriptor.set!.call(this, html);
  });
  load('<a href="https://example.test/?data=dummy">Leave</a><script>location.assign("https://example.test");</script>');
  expect(policyAtAssignment).toBe("frame-src 'none'");
  expect(inner.getAttribute("sandbox")).toBe("allow-scripts");
  const doc = new DOMParser().parseFromString(inner.srcdoc, "text/html");
  expect(doc.head.firstElementChild?.getAttribute("content")).toContain("connect-src 'none'; frame-src 'none'");
  expect(doc.querySelector("a")?.getAttribute("href")).toBe("https://example.test/?data=dummy");
});

it("preserves the frame, connection, and resource permissions that the host approved", () => {
  const { inner, load } = sandbox();
  const declared = {
    frameDomains: ["https://frames.vendor.com", "https://*.widgets.vendor.com"],
    connectDomains: ["https://api.vendor.com"], resourceDomains: ["https://cdn.vendor.com"]
  };
  load('<iframe src="https://frames.vendor.com/view"></iframe>', { ...declared, approvedDomains: declared });
  expect(document.head.querySelector("meta[http-equiv]")?.getAttribute("content"))
    .toBe("frame-src https://frames.vendor.com https://*.widgets.vendor.com");
  const doc = new DOMParser().parseFromString(inner.srcdoc, "text/html");
  const policy = doc.head.firstElementChild?.getAttribute("content");
  expect(policy).toContain("frame-src https://frames.vendor.com https://*.widgets.vendor.com");
  expect(policy).toContain("connect-src https://api.vendor.com");
  expect(policy).toContain("script-src 'self' 'unsafe-inline' https://cdn.vendor.com");
});

it("gives a widget nothing outside when the host sent no approved domains", () => {
  const { inner, load } = sandbox();
  load("<p>Widget</p>", {
    frameDomains: ["https://frames.vendor.com"], connectDomains: ["https://api.vendor.com"],
    resourceDomains: ["https://cdn.vendor.com"], baseUriDomains: ["https://base.vendor.com"]
  });
  expect(document.head.querySelector("meta[http-equiv]")?.getAttribute("content")).toBe("frame-src 'none'");
  const policy = new DOMParser().parseFromString(inner.srcdoc, "text/html").head.firstElementChild?.getAttribute("content");
  expect(policy).toContain("connect-src 'none'; frame-src 'none'; base-uri 'self'");
  expect(policy).toContain("script-src 'self' 'unsafe-inline' ;");
  expect(policy).not.toContain("vendor.com");
});

it("drops a declared source that the host did not approve, even when the host sent the same list", () => {
  const { inner, load } = sandbox();
  load("<p>Widget</p>", {
    connectDomains: ["https://api.vendor.com", "https://attacker.example.net", "https://*.com"],
    approvedDomains: { connectDomains: ["https://api.vendor.com"], resourceDomains: ["https://attacker.example.net"] }
  });
  expect(policyLists(inner.srcdoc).connectDomains).toEqual(["https://api.vendor.com"]);
});

it("rejects untrusted sources and CSP injection in frame declarations", () => {
  const { inner, load } = sandbox();
  load("<p>Untrusted</p>", { frameDomains: ["https://example.test"] }, inner.contentWindow);
  expect(document.head.querySelector("meta[http-equiv]")).toBeNull();
  expect(inner.srcdoc).toBe("");
  load('<meta http-equiv="Content-Security-Policy" content="frame-src *"><p>Widget</p>', {
    frameDomains: ["*", "data:", "https://example.test; frame-src *", "https://example.test 'unsafe-inline'"]
  });
  expect(document.head.querySelector("meta[http-equiv]")?.getAttribute("content")).toBe("frame-src 'none'");
});

it("announces itself to the configured parent origin only", () => {
  const { parent } = sandbox();
  expect(parent.postMessage).toHaveBeenCalledTimes(1);
  expect(parent.postMessage).toHaveBeenCalledWith(READY, PARENT_ORIGIN);
});

it.each([
  ["another site", "https://evil.example.test"],
  ["an opaque origin", "null"],
  ["a longer host name", "https://chat.example.test.evil.test"],
  ["another scheme", "http://chat.example.test"],
  ["another port", "https://chat.example.test:8443"],
  ["an empty origin", ""]
])("ignores a message from the parent window with %s as its origin", (_name, origin) => {
  const { inner, innerPost, load, parent, receive } = sandbox();
  load("<p>Widget</p>", { frameDomains: ["https://frames.example.test"] }, parent, origin);
  receive({ source: parent, origin, data: { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: {} } });
  expect(document.head.querySelector("meta[http-equiv]")).toBeNull();
  expect(inner.srcdoc).toBe("");
  expect(innerPost).not.toHaveBeenCalled();
});

it("relays a host message from the configured origin to the opaque inner frame", () => {
  const { innerPost, parent, receive } = sandbox();
  const data = { jsonrpc: "2.0", method: "ui/notifications/tool-input", params: { arguments: { quantity: 3 } } };
  receive({ source: parent, origin: PARENT_ORIGIN, data });
  expect(innerPost).toHaveBeenCalledOnce();
  expect(innerPost).toHaveBeenCalledWith(data, "*");
});

it("relays a message from the opaque inner frame to the parent at its exact origin", () => {
  const { inner, parent, receive } = sandbox();
  parent.postMessage.mockClear();
  const data = { jsonrpc: "2.0", id: 1, method: "ui/message", params: { role: "user", content: [] } };
  receive({ source: inner.contentWindow, origin: "null", data });
  expect(parent.postMessage).toHaveBeenCalledOnce();
  expect(parent.postMessage).toHaveBeenCalledWith(data, PARENT_ORIGIN);
});

it("never sends to the parent with a wildcard target", () => {
  const { inner, parent, receive } = sandbox();
  receive({ source: inner.contentWindow, origin: "null", data: { jsonrpc: "2.0", method: "ui/notifications/size-changed", params: { height: 400 } } });
  expect(parent.postMessage.mock.calls.length).toBeGreaterThan(1);
  expect(parent.postMessage.mock.calls.map((call) => call[1])).toEqual(parent.postMessage.mock.calls.map(() => PARENT_ORIGIN));
});

it("keeps proxy control messages away from the parent and from the inner frame", () => {
  const { inner, innerPost, parent, receive } = sandbox();
  parent.postMessage.mockClear();
  receive({ source: inner.contentWindow, origin: "null", data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} } });
  receive({ source: parent, origin: PARENT_ORIGIN, data: { jsonrpc: "2.0", method: "ui/notifications/sandbox-proxy-ready", params: {} } });
  expect(parent.postMessage).not.toHaveBeenCalled();
  expect(innerPost).not.toHaveBeenCalled();
});

it("relays nothing for a window that is neither the parent nor the inner frame", () => {
  const { innerPost, parent, receive } = sandbox();
  parent.postMessage.mockClear();
  const stranger = document.createElement("iframe");
  document.body.append(stranger);
  receive({ source: stranger.contentWindow, origin: PARENT_ORIGIN, data: { jsonrpc: "2.0", method: "tools/call", params: {} } });
  receive({ source: null, origin: PARENT_ORIGIN, data: { jsonrpc: "2.0", method: "tools/call", params: {} } });
  expect(parent.postMessage).not.toHaveBeenCalled();
  expect(innerPost).not.toHaveBeenCalled();
});

it.each([
  ["no setting", null],
  ["a value with a path", "https://chat.example.test/app"],
  ["a script scheme", "javascript:alert(1)"],
  ["text that is not a URL", "chat.example.test"]
])("stops at start, and sends nothing, with %s as the parent origin", (_name, origin) => {
  const parent = { postMessage: vi.fn() };
  const addEventListener = vi.fn();
  expect(() => runInNewContext(proxyScript(origin), {
    window: { self: {}, top: {}, parent, addEventListener }, document, DOMParser
  })).toThrow("Parent origin required");
  expect(parent.postMessage).not.toHaveBeenCalled();
  expect(addEventListener).not.toHaveBeenCalled();
});

it("stops when the page is not in a frame", () => {
  const window = { self: {}, top: undefined as unknown, parent: { postMessage: vi.fn() }, addEventListener: vi.fn() };
  window.top = window.self;
  expect(() => runInNewContext(proxyScript(PARENT_ORIGIN), { window, document, DOMParser })).toThrow("Frame only");
  expect(window.parent.postMessage).not.toHaveBeenCalled();
});

it("puts the parent origin in the script as one escaped JSON string", () => {
  const html = buildMcpAppSandboxHtml(PARENT_ORIGIN);
  expect(html).toContain(`const parentOrigin = "${PARENT_ORIGIN}";`);
  expect(html.match(/<\/script>/g)).toHaveLength(1);
  const hostile = 'x</script><script>alert(1)</script>&"\u2028\u2029\\';
  const json = scriptSafeJson(hostile);
  expect(json).not.toMatch(/[<>&\u2028\u2029]/);
  expect(JSON.parse(json)).toBe(hostile);
  // A value that is not a bare origin never reaches the script.
  expect(buildMcpAppSandboxHtml("https://chat.example.test/</script><script>alert(1)</script>")).toContain("const parentOrigin = null;");
  expect(buildMcpAppSandboxHtml("https://chat.example.test/")).toContain("const parentOrigin = null;");
});
