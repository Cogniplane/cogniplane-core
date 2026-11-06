// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { PolicyDecisionDetail } from "@cogniplane/shared-types";
import { AdminPolicyDecisionsCard } from "./admin-policy-decisions-card";
import { getPolicyDecision } from "../../../lib/admin-api";

vi.mock("../../../lib/admin-api", () => ({ getPolicyDecision: vi.fn() }));
const decision: PolicyDecisionDetail = {
  decisionId: "fictional-decision", tenantId: "fictional-tenant", sessionId: "fictional-session",
  userId: "fictional-user", runtimeId: "fictional-runtime", toolName: "fictional_write",
  serverId: "fictional-server", toolCategory: null, severity: null, matchedRuleId: "fictional-rule",
  outcome: "block", enforced: false, explanation: null, createdAt: "2026-11-04T12:00:00.123456Z",
  actionSnapshot: { arguments: { document: "[REDACTED]" } }
};
const clients: QueryClient[] = [];
function mount(overrides: Partial<ComponentProps<typeof AdminPolicyDecisionsCard>> = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  clients.push(client);
  return render(<QueryClientProvider client={client}><AdminPolicyDecisionsCard
    decisions={[]} total={0} page={0} pageCount={0} offset={0} hasMore={false}
    loading={false} fetching={false} error={null} filters={{ matchedRuleId: "fictional-rule" }}
    onApply={vi.fn()} onNext={vi.fn()} onPrev={vi.fn()} onRefresh={vi.fn()} {...overrides}
  /></QueryClientProvider>);
}
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.resetAllMocks(); });

it.each([
  { loading: true, fetching: true },
  { fetching: true },
  { error: "Fictional read failed." }
])("does not turn an unsettled or failed scoped read into a zero count: %j", state => {
  mount(state);
  expect(screen.queryByText("0 rule matches in this scope.")).toBeNull();
  if (state.loading) expect(screen.getByRole("status").textContent).toContain("Loading rule matches");
  if (state.error) {
    expect(screen.getByRole("alert").textContent).toBe(state.error);
    expect(screen.queryByText("No rule matches for these filters.")).toBeNull();
  }
});

it("reports zero matches only after a successful empty read", () => {
  mount();
  expect(screen.getByText("0 rule matches in this scope.")).toBeTruthy();
  expect(screen.getByText("No rule matches for these filters.")).toBeTruthy();
});

it("identifies retained rows while a later page loads instead of assigning them the new range", () => {
  mount({ decisions: [decision], total: 26, page: 1, pageCount: 2, offset: 25, fetching: true });
  expect(screen.getByRole("status").textContent).toBe("Loading rule matches. Previous rows remain visible.");
  expect(screen.queryByText(/Showing/)).toBeNull();
  expect(screen.getByText("fictional_write")).toBeTruthy();
});

it("shows detail loading, the redacted snapshot, and keyboard-close recovery", async () => {
  let resolve!: (value: PolicyDecisionDetail) => void;
  vi.mocked(getPolicyDecision).mockReturnValueOnce(new Promise(done => { resolve = done; }));
  mount({ decisions: [decision], total: 1 });
  fireEvent.click(screen.getByRole("button", { name: /^Details for/ }));
  const dialog = screen.getByRole("dialog");
  expect(within(dialog).getByRole("status").textContent).toBe("Loading rule match detail…");
  expect(within(dialog).queryByText("Action snapshot (redacted)")).toBeNull();
  await act(async () => { resolve(decision); });
  expect(await within(dialog).findByText("Action snapshot (redacted)")).toBeTruthy();
  expect(dialog.querySelector("pre")?.textContent).toBe(JSON.stringify(decision.actionSnapshot, null, 2));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("announces a failed detail read without presenting a successful snapshot, then recovers on reopen", async () => {
  vi.mocked(getPolicyDecision).mockRejectedValueOnce(new Error("Fictional detail read failed."));
  mount({ decisions: [decision], total: 1 });
  fireEvent.click(screen.getByRole("button", { name: /^Details for/ }));
  const dialog = screen.getByRole("dialog");
  expect((await within(dialog).findByRole("alert")).textContent).toBe("Fictional detail read failed.");
  expect(dialog.querySelector("pre")).toBeNull();
  fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
  vi.mocked(getPolicyDecision).mockResolvedValueOnce(decision);
  fireEvent.click(screen.getByRole("button", { name: /^Details for/ }));
  expect(await within(screen.getByRole("dialog")).findByText("Action snapshot (redacted)")).toBeTruthy();
  expect(getPolicyDecision).toHaveBeenCalledTimes(2);
});
