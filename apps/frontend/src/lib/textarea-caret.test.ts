// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { revealTextareaCaret } from "./textarea-caret";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

function fieldAt(top: number, bottom: number) {
  const field = document.createElement("textarea");
  field.style.padding = "8px 12px";
  field.value = "First line\nLast line";
  field.setSelectionRange(field.value.length, field.value.length);
  Object.defineProperties(field, { clientWidth: { value: 200 }, clientHeight: { value: 40 }, scrollHeight: { value: 304 } });
  document.body.append(field);
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([{ top, bottom, height: bottom - top }] as unknown as DOMRectList);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
  return field;
}

it("reveals a caret below the resized scrollport without changing selection or text", () => {
  const field = fieldAt(272, 291);
  field.scrollTop = 114;
  revealTextareaCaret(field);
  expect(field.scrollTop).toBe(259);
  expect(field.selectionStart).toBe(field.value.length);
  expect(field.value).toBe("First line\nLast line");
  expect(document.body.children).toHaveLength(1);
});

it("reveals the active start of a backward selection above the scrollport", () => {
  const field = fieldAt(8, 27);
  field.setSelectionRange(0, 5, "backward");
  field.scrollTop = 114;
  let measuredText = "";
  vi.mocked(HTMLElement.prototype.getClientRects).mockImplementation(function (this: HTMLElement) {
    measuredText = this.textContent || "";
    return [{ top: 8, height: 19 }] as unknown as DOMRectList;
  });
  revealTextareaCaret(field);
  expect(field.scrollTop).toBe(0);
  expect(measuredText).toBe(field.value);
  expect(field.selectionDirection).toBe("backward");
});

it("keeps an already visible caret and removes its measurement element", () => {
  const field = fieldAt(272, 291);
  field.scrollTop = 259;
  revealTextareaCaret(field);
  expect(field.scrollTop).toBe(259);
  expect(document.body.children).toHaveLength(1);
});
