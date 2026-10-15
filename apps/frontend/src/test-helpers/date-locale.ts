import { afterEach, beforeEach, vi } from "vitest";

/** Keep native date formatting while fixing the test host's locale and zone. */
export function withUtcDateLocale() {
  const DateTimeFormat = Intl.DateTimeFormat;
  const toLocaleString = Date.prototype.toLocaleString;
  const toLocaleDateString = Date.prototype.toLocaleDateString;
  const toLocaleTimeString = Date.prototype.toLocaleTimeString;

  beforeEach(() => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new DateTimeFormat(locales ?? "en-US", { ...options, timeZone: "UTC" });
    } as typeof Intl.DateTimeFormat);
    vi.spyOn(Date.prototype, "toLocaleString").mockImplementation(function (this: Date, locales, options) {
      return toLocaleString.call(this, locales ?? "en-US", { ...options, timeZone: "UTC" });
    });
    vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, locales, options) {
      return toLocaleDateString.call(this, locales ?? "en-US", { ...options, timeZone: "UTC" });
    });
    vi.spyOn(Date.prototype, "toLocaleTimeString").mockImplementation(function (this: Date, locales, options) {
      return toLocaleTimeString.call(this, locales ?? "en-US", { ...options, timeZone: "UTC" });
    });
  });
  afterEach(() => vi.restoreAllMocks());
}
