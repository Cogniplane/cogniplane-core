// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { PolicyEnforcementReviewDialog } from "./policy-enforcement-review-dialog";
import { makeTenantSettings } from "../../../test-helpers/tenant-settings";

afterEach(cleanup);
const props = () => ({
  review: {
    phase: "ready" as const,
    snapshot: {
      settingsVersion: 7, readAt: "2026-11-05T12:00:00Z",
      summary: { windowStart: "2026-10-29T12:00:00Z", windowEnd: "2026-11-05T12:00:00Z", totals: { block: 0, approvalInteractive: 0, approvalScheduled: 0, approvalUnknownContext: 0, total: 0 }, rules: [], excluded: { resourceChecks: 0, unrecognized: 0 } }
    }, failure: null
  },
  settings: makeTenantSettings({ version: 7 }), saving: false, reloading: false, reloadFailed: false,
  onClose: vi.fn(), onEnable: vi.fn(), onReread: vi.fn(), onReloadSettings: vi.fn(), onRestoreFocus: vi.fn()
});

it("recovers focus when the current settings remove the Enable action after an unconfirmed save", async () => {
  const initial = props();
  const view = render(<PolicyEnforcementReviewDialog {...initial} />);
  screen.getByRole("button", { name: "Enable enforcement" }).focus();
  view.rerender(<PolicyEnforcementReviewDialog {...initial} saving reloading />);
  view.rerender(<PolicyEnforcementReviewDialog {...initial} settings={makeTenantSettings({ version: 8, policyEnforcementMode: "enforce" })} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" })));
  expect(screen.queryByRole("button", { name: "Enable enforcement" })).toBeNull();
});

it("keeps focus on a selected recovery control when a reload ends", () => {
  const initial = { ...props(), reloadFailed: true };
  const view = render(<PolicyEnforcementReviewDialog {...initial} reloading />);
  const reload = screen.getByRole("button", { name: "Load current settings" });
  reload.focus();
  view.rerender(<PolicyEnforcementReviewDialog {...initial} />);
  expect(document.activeElement).toBe(reload);
});

it("moves focus from Enable when a new settings version disables it", () => {
  const initial = props();
  const view = render(<PolicyEnforcementReviewDialog {...initial} />);
  screen.getByRole("button", { name: "Enable enforcement" }).focus();
  view.rerender(<PolicyEnforcementReviewDialog {...initial} settings={makeTenantSettings({ version: 9 })} />);
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Keep Monitor" }));
});
