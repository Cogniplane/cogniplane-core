// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { API_URL } from "../lib/api-client";
import { SafeMarkdown } from "./safe-markdown";

afterEach(cleanup);

describe("SafeMarkdown links", () => {
  it("opens external links safely and identifies non-allowlisted hosts", async () => {
    render(<SafeMarkdown>{"[Vendor docs](https://vendor.example/docs)"}</SafeMarkdown>);

    // react-markdown is lazy-loaded, so the link appears after the chunk resolves.
    const link = await screen.findByRole("link", { name: /Vendor docs/ }, { timeout: 5_000 });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("[external: vendor.example]");
  });

  it("does not warn for allowlisted API links", async () => {
    render(<SafeMarkdown>{`[Download](${API_URL}/downloads/file)`}</SafeMarkdown>);

    const link = await screen.findByRole("link", { name: "Download" });
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).not.toContain("external:");
  });

  it("keeps relative links in the current browsing context", async () => {
    render(<SafeMarkdown>{"[Settings](/settings)"}</SafeMarkdown>);

    const link = await screen.findByRole("link", { name: "Settings" });
    expect(link.hasAttribute("target")).toBe(false);
    expect(link.hasAttribute("rel")).toBe(false);
  });
});

describe("SafeMarkdown images", () => {
  it("routes markdown images through the shared renderer", async () => {
    render(<SafeMarkdown>{"![leak](https://attacker.example/pixel.png)"}</SafeMarkdown>);

    const link = await screen.findByRole("link");
    expect(link.getAttribute("href")).toBe("https://attacker.example/pixel.png");
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("SafeMarkdown reading syntax", () => {
  it("renders GFM tables, deleted text and read-only task lists", async () => {
    const { container } = render(<SafeMarkdown>{"## Evidence\n\nFirst paragraph.\n\nSecond paragraph with ~~old text~~.\n\n| Source | Result |\n| --- | --- |\n| File | Ready |\n\n- [x] Read source\n- [ ] Review draft"}</SafeMarkdown>);
    expect(await screen.findByRole("heading", { name: "Evidence", level: 2 })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Ready" })).toBeTruthy();
    expect(container.querySelector("del")?.textContent).toBe("old text");
    const tasks = screen.getAllByRole("checkbox") as HTMLInputElement[];
    expect(tasks.map(task => ({ checked: task.checked, disabled: task.disabled, readOnly: task.readOnly }))).toEqual([
      { checked: true, disabled: true, readOnly: true }, { checked: false, disabled: true, readOnly: true }
    ]);
    expect(screen.getByRole("region", { name: "Markdown table" }).tabIndex).toBe(0);
  });

  it("keeps nested numbered instructions and exact fenced source", async () => {
    const source = '  const text = "<value>";\n\n    keepIndentation();\n';
    const { container } = render(<SafeMarkdown>{`3. Read the source.\n   1. Check the date.\n      - Keep this note.\n4. Confirm the result.\n\n\`\`\`unknown-language\n${source}\`\`\``}</SafeMarkdown>);
    const region = await screen.findByRole("region", { name: "Code block" });
    expect(region.textContent).toBe(source);
    const ordered = container.querySelector("ol")!;
    expect(ordered.start).toBe(3);
    expect(ordered.querySelector("li ol li ul li")?.textContent).toBe("Keep this note.");
    expect(region.tabIndex).toBe(0);
  });

  it("keeps incomplete streamed content readable without accepting raw controls or active HTML", async () => {
    const { container, rerender } = render(<SafeMarkdown>{"## Incomplete\n\n- [ ] Review\n\n```ts\n  pending("}</SafeMarkdown>);
    expect((await screen.findByRole("region", { name: "Code block" })).textContent).toBe("  pending(\n");
    rerender(<SafeMarkdown>{'## Complete\n\n<script>window.bad=true</script>\n<iframe src="https://evil.example"></iframe>\n<input type="text" value="bad">\n\n[Unsafe](javascript:alert(1))'}</SafeMarkdown>);
    await screen.findByRole("heading", { name: "Complete" });
    expect(container.querySelector("script,iframe,input,form,style,object,embed")).toBeNull();
    expect(screen.getByText("Unsafe").getAttribute("href")).not.toMatch(/^javascript:/i);
  });
});
