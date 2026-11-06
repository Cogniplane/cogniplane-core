// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({ toast: { warning: vi.fn() } }));
import { toast } from "sonner";
import { setTheme, THEME_STORAGE_KEY } from "./theme";

beforeEach(() => {
  document.documentElement.removeAttribute("data-theme");
  localStorage.clear();
});
afterEach(() => vi.restoreAllMocks());

it("applies and saves the chosen theme", () => {
  setTheme("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  setTheme("light");
  expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  expect(localStorage.getItem(THEME_STORAGE_KEY)).toBe("light");
  expect(toast.warning).not.toHaveBeenCalled();
});

it("still applies the theme when the browser blocks storage, and says it will not be kept", () => {
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new DOMException("Blocked", "SecurityError");
  });
  setTheme("dark");
  expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  expect(toast.warning).toHaveBeenCalledWith("Theme changed for this page only", expect.objectContaining({ id: "theme-not-saved" }));
});
