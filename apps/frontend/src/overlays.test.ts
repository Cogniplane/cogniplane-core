// @vitest-environment jsdom
import { expect, it } from "vitest";

import { withSectionComponents } from "./app/settings/settings-section-components";
import { listSettingsLiveSections } from "./app/settings/settings-sections";

// It uses the real overlay registration, with no mock. The generic page must
// find the overlay section when a browser opens /settings/microsoft directly.
it("registers the Microsoft section with its page and account row when the generic settings page loads", async () => {
  await import("./app/settings/[integrationId]/page");

  const section = listSettingsLiveSections().find((item) => item.id === "microsoft");
  expect(section?.kind).toBe("integration");
  // The page loads on demand, so `detail` is a lazy component object.
  expect(section && withSectionComponents(section).detail).toBeTruthy();
  expect(section && withSectionComponents(section).accountRow).toBeTypeOf("function");
});
