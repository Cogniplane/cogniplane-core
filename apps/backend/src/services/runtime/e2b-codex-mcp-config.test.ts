import { describe, expect, test } from "vitest";

import { buildSandboxCodexConfig, extractMcpServersToml } from "./e2b-codex-mcp-config.js";

describe("buildSandboxCodexConfig", () => {
  test("omits model_providers when no proxy is configured (local-style)", () => {
    const toml = buildSandboxCodexConfig({
      model: "gpt-5.4-mini",
      workspaceRoot: "/home/user/workspace"
    });

    expect(toml).toContain('model = "gpt-5.4-mini"');
    expect(toml).toContain("[features]");
    expect(toml).not.toContain("model_providers");
    expect(toml).not.toContain("cogniplane_proxy");
  });

  test("emits model_providers + model_provider selector when proxy is set", () => {
    const toml = buildSandboxCodexConfig({
      model: "gpt-5.4-mini",
      workspaceRoot: "/home/user/workspace",
      proxy: { baseUrl: "https://backend.example/llm/openai/v1" }
    });

    expect(toml).toContain("[model_providers.cogniplane_proxy]");
    expect(toml).toContain('base_url = "https://backend.example/llm/openai/v1"');
    expect(toml).toContain('env_key = "OPENAI_API_KEY"');
    expect(toml).toContain('wire_api = "responses"');
    expect(toml).toContain('model_provider = "cogniplane_proxy"');
  });

  test("model_provider selector is at TOML root, not under [model_providers.*]", () => {
    // TOML tables extend until the next [section] header. If `model_provider =`
    // is emitted after `[model_providers.cogniplane_proxy]` (even after a blank
    // line) it becomes `model_providers.cogniplane_proxy.model_provider` and
    // Codex never sees the top-level selector — model calls then bypass the
    // Cogniplane proxy. This test pins the ordering: the selector must appear
    // BEFORE the first section header.
    const toml = buildSandboxCodexConfig({
      model: "gpt-5.4-mini",
      workspaceRoot: "/home/user/workspace",
      proxy: { baseUrl: "https://backend.example/llm/openai/v1" }
    });
    const selectorIdx = toml.indexOf('model_provider = "cogniplane_proxy"');
    const firstSectionIdx = toml.search(/^\[/m);
    expect(selectorIdx).toBeGreaterThan(-1);
    expect(firstSectionIdx).toBeGreaterThan(-1);
    expect(selectorIdx).toBeLessThan(firstSectionIdx);
  });

  test("appends caller-supplied mcp_servers TOML at the end so it isn't re-bracketed", () => {
    const mcpToml = '[mcp_servers.demo]\nurl = "https://x"\n\n[mcp_servers.demo.headers]\nAuthorization = "Bearer rt_x"';
    const toml = buildSandboxCodexConfig({
      model: "gpt-5.4",
      workspaceRoot: "/home/user/workspace",
      mcpServersToml: mcpToml,
      proxy: { baseUrl: "https://x/llm/openai/v1" }
    });

    // model_providers must appear before [projects.*] / [features] etc.
    expect(toml.indexOf("model_providers.cogniplane_proxy")).toBeLessThan(toml.indexOf("[features]"));
    // mcp_servers must come last so the [projects."…"] block isn't accidentally
    // absorbed by a trailing [mcp_servers.*] section.
    expect(toml.indexOf("mcp_servers.demo")).toBeGreaterThan(toml.indexOf("[features]"));
  });
});

describe("extractMcpServersToml", () => {
  test("returns just the mcp_servers sections from a workspace codex.toml", () => {
    const input = `# header
[mcp_servers.foo]
url = "https://x"

[mcp_servers.foo.headers]
Authorization = "Bearer rt_x"

[some.other.section]
key = "value"
`;
    const out = extractMcpServersToml(input);
    expect(out).toContain("[mcp_servers.foo]");
    expect(out).toContain("[mcp_servers.foo.headers]");
    expect(out).not.toContain("some.other.section");
  });
});
