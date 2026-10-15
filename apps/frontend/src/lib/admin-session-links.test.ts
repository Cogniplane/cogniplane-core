import { expect, it } from "vitest";

import { sessionDetailHref, sessionListHref } from "./admin-session-links";

const BASE = "http://localhost";

it.each(["a&b", "a+b", "a%41", "x#y", "ana@example.com", "naïve user"])(
  "returns to the same list filters through the detail page for %j",
  (userId) => {
    const listQuery = new URLSearchParams({ userId, status: "errored" }).toString();

    const detail = new URL(sessionDetailHref("s/1", listQuery), BASE);
    // The detail page reads `from` the way Next's useSearchParams does.
    const back = new URL(sessionListHref(detail.searchParams.get("from")), BASE);

    expect(detail.pathname).toBe("/admin/sessions/s%2F1");
    expect(back.pathname).toBe("/admin/sessions");
    expect(back.searchParams.get("userId")).toBe(userId);
    expect(back.searchParams.get("status")).toBe("errored");
  }
);

it("links without `from` when the list has no filters", () => {
  expect(sessionDetailHref("s1", "")).toBe("/admin/sessions/s1");
  expect(sessionListHref(null)).toBe("/admin/sessions");
  expect(sessionListHref("")).toBe("/admin/sessions");
});
