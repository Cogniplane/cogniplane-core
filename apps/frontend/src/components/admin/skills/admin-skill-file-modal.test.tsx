// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { SkillRevisionFilePreview } from "@cogniplane/shared-types";

import { getSkillRevisionFile } from "../../../lib/admin-api";
import { AdminSkillFileModal } from "./admin-skill-file-modal";

vi.mock("../../../lib/admin-api", () => ({ getSkillRevisionFile: vi.fn() }));
// The real code block pulls in a syntax highlighter; a stub shows what it receives.
vi.mock("next/dynamic", () => ({
  default: () => (props: { language: string; code: string }) => <pre data-language={props.language}>{props.code}</pre>
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function file(overrides: Partial<SkillRevisionFilePreview>): SkillRevisionFilePreview {
  return { path: "scripts/run.py", sizeBytes: 12, encoding: "utf8", contentType: "text/x-python", content: "print('hi')", ...overrides };
}

function renderModal(preview: SkillRevisionFilePreview, path = preview.path) {
  vi.mocked(getSkillRevisionFile).mockResolvedValue({ file: preview, limitBytes: 1_000_000 });
  const onClose = vi.fn();
  const view = render(<AdminSkillFileModal skillId="pdf" skillRevisionId={7} path={path} onClose={onClose} />);
  return { ...view, onClose };
}

it("loads the requested file and shows code with its language", async () => {
  renderModal(file({}));

  expect(screen.getByText("Loading…")).toBeTruthy();
  const code = await screen.findByText("print('hi')");
  expect(code.getAttribute("data-language")).toBe("python");
  expect(getSkillRevisionFile).toHaveBeenCalledWith({ skillId: "pdf", skillRevisionId: 7, path: "scripts/run.py" });
  expect(screen.getByRole("dialog", { name: "scripts/run.py" })).toBeTruthy();
});

it.each([
  ["the server's message", new Error("File is too large."), "File is too large."],
  ["a fallback", "offline", "Failed to load file."]
])("shows %s when the file fails to load", async (_case, failure, message) => {
  vi.mocked(getSkillRevisionFile).mockRejectedValue(failure);
  render(<AdminSkillFileModal skillId="pdf" skillRevisionId={7} path="a.txt" onClose={vi.fn()} />);

  expect(await screen.findByText(message)).toBeTruthy();
});

it("inlines a base64 image", async () => {
  renderModal(file({ path: "assets/logo.png", encoding: "base64", contentType: "image/png", content: "iVBOR" }));

  const image = await screen.findByRole("img", { name: "assets/logo.png" });
  expect(image.getAttribute("src")).toBe("data:image/png;base64,iVBOR");
});

it("shows a text-encoded image, such as SVG, as code rather than as a broken base64 image", async () => {
  renderModal(file({ path: "icon.svg", encoding: "utf8", contentType: "image/svg+xml", content: "<svg/>" }));

  expect(await screen.findByText("<svg/>")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("does not preview other binary files", async () => {
  renderModal(file({ path: "model.bin", encoding: "base64", contentType: "application/octet-stream", sizeBytes: 2048, content: "AAAA" }));

  expect(await screen.findByText("Binary file (application/octet-stream, 2048 bytes). Preview not available.")).toBeTruthy();
  expect(screen.queryByRole("img")).toBeNull();
});

it("renders markdown", async () => {
  renderModal(file({ path: "SKILL.md", contentType: "text/markdown", content: "**Read me**" }));

  // SafeMarkdown loads its renderer lazily.
  expect((await screen.findByText("Read me", {}, { timeout: 3_000 })).tagName).toBe("STRONG");
});

it("shows a CSV as a table, pads short headers, and switches to the raw text", async () => {
  const csv = "name,score\nana,3,extra\nbo,5";
  renderModal(file({ path: "data.csv", contentType: "text/csv", content: csv }));

  await screen.findByRole("table");
  expect(screen.getAllByRole("columnheader").map((cell) => cell.textContent)).toEqual(["name", "score", "col3"]);
  expect(screen.getAllByRole("row").slice(1).map((row) => row.textContent)).toEqual(["ana3extra", "bo5"]);
  expect(screen.getByText("2 rows")).toBeTruthy();
  expect(screen.getByText("3 columns")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Show raw" }));
  expect(screen.queryByRole("table")).toBeNull();
  expect(document.querySelector("pre")!.textContent).toBe(csv);

  fireEvent.click(screen.getByRole("button", { name: "Show table" }));
  expect(screen.getByRole("table")).toBeTruthy();
});

it("says when a CSV is cut to its first 100 rows", async () => {
  const rows = Array.from({ length: 150 }, (_, i) => `row${i},${i}`);
  renderModal(file({ path: "big.csv", contentType: "text/csv", content: ["name,value", ...rows].join("\n") }));

  expect(await screen.findByText("Showing first 100 of 150 rows")).toBeTruthy();
});

it("offers no CSV toggle for other files", async () => {
  renderModal(file({}));

  await screen.findByText("print('hi')");
  expect(screen.queryByRole("button", { name: "Show raw" })).toBeNull();
});

it("ignores a late response for a file it no longer shows", async () => {
  let resolveFirst!: (value: { file: SkillRevisionFilePreview; limitBytes: number }) => void;
  vi.mocked(getSkillRevisionFile)
    .mockReturnValueOnce(new Promise((resolve) => { resolveFirst = resolve; }))
    .mockResolvedValueOnce({ file: file({ path: "b.txt", contentType: "text/plain", content: "second file" }), limitBytes: 1 });
  const { rerender } = render(<AdminSkillFileModal skillId="pdf" skillRevisionId={7} path="a.txt" onClose={vi.fn()} />);

  rerender(<AdminSkillFileModal skillId="pdf" skillRevisionId={7} path="b.txt" onClose={vi.fn()} />);
  await screen.findByText("second file");
  await act(async () => { resolveFirst({ file: file({ path: "a.txt", contentType: "text/plain", content: "first file" }), limitBytes: 1 }); });

  expect(screen.queryByText("first file")).toBeNull();
  expect(screen.getByText("second file")).toBeTruthy();
});

it("closes on Escape", async () => {
  const { onClose } = renderModal(file({}));
  await screen.findByText("print('hi')");

  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

  expect(onClose).toHaveBeenCalledTimes(1);
});
