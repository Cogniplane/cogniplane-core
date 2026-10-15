// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { DragEndEvent } from "@dnd-kit/core";
import type { PolicyRule } from "@cogniplane/shared-types";
import type { ReactNode } from "react";

import { AdminPolicyRulesCard } from "./admin-policy-rules-card";

// dnd-kit cannot drag in jsdom, so capture the card's onDragEnd and call it as a drop would.
// A separate file keeps the real DndContext for the other card tests.
const dnd = vi.hoisted(() => ({ onDragEnd: undefined as ((event: DragEndEvent) => void) | undefined }));
vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: (props: { onDragEnd?: (event: DragEndEvent) => void; children: ReactNode }) => {
    dnd.onDragEnd = props.onDragEnd;
    return <>{props.children}</>;
  }
}));

afterEach(() => {
  cleanup();
  dnd.onDragEnd = undefined;
});

function policyRule(ruleId: string, name: string, priority: number): PolicyRule {
  return {
    ruleId, tenantId: "t", name, description: null, priority, enabled: true, effect: "block",
    conditions: { toolNames: ["github_write_file"] }, reason: null, createdBy: null,
    createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z"
  };
}

const rules = [policyRule("first", "First", 1), policyRule("second", "Second", 2), policyRule("third", "Third", 3)];

function drop(active: string, over: string | null) {
  dnd.onDragEnd!({ active: { id: active }, over: over === null ? null : { id: over } } as DragEndEvent);
}

it("moves the dragged rule to the place of the rule it was dropped on", () => {
  const onReorder = vi.fn();
  render(<AdminPolicyRulesCard rules={rules} lintWarnings={[]} busyKey={null} onSave={async () => true} onDelete={vi.fn()} onReorder={onReorder} />);

  drop("third", "first");
  drop("first", "third");

  expect(onReorder.mock.calls).toEqual([[["third", "first", "second"]], [["second", "third", "first"]]]);
});

it("ignores a drop outside the list or onto the same rule", () => {
  const onReorder = vi.fn();
  render(<AdminPolicyRulesCard rules={rules} lintWarnings={[]} busyKey={null} onSave={async () => true} onDelete={vi.fn()} onReorder={onReorder} />);

  drop("second", null);
  drop("second", "second");

  expect(onReorder).not.toHaveBeenCalled();
});
