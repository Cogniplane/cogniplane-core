"use client";
// Where the decision controls of a pending approval show. An approval that
// names a tool call (`toolCallId`, the server ID of the proposed call) shows
// its controls in that call's card while the card is mounted. Every other
// pending approval shows them in the notification list: one with no link, one
// whose call is not in the loaded history, and one whose card the transcript's
// virtual list unmounted. So each pending approval has exactly one set of
// controls, and it moves when its card mounts or unmounts.
//
// The link is the server's. The browser never matches an approval to a call by
// tool name, arguments, position or itemId.

import { createContext, useContext, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";

import type { ApprovalDecision, ApprovalRow } from "./chat-cards.types";

/** The tool cards that are mounted now. The first card of a call owns its controls. */
export class MountedToolCards {
  private readonly cards = new Map<string, symbol[]>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  /** Adds a mounted card. Call the returned function when it unmounts. */
  register(toolCallId: string, card: symbol): () => void {
    this.cards.set(toolCallId, [...(this.cards.get(toolCallId) ?? []), card]);
    this.changed();
    return () => {
      const rest = (this.cards.get(toolCallId) ?? []).filter((entry) => entry !== card);
      if (rest.length > 0) this.cards.set(toolCallId, rest);
      else this.cards.delete(toolCallId);
      this.changed();
    };
  }

  has(toolCallId: string): boolean {
    return this.cards.has(toolCallId);
  }

  owns(toolCallId: string, card: symbol): boolean {
    return this.cards.get(toolCallId)?.[0] === card;
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getRevision = (): number => this.revision;

  private changed(): void {
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
  }
}

export type ToolApprovals = {
  cards: MountedToolCards;
  /** Pending approvals by the tool call that they name. */
  byCall: ReadonlyMap<string, ApprovalRow>;
  onDecision: (approvalId: string, decision: ApprovalDecision) => void;
};

/** Provided by the chat host around the transcript. */
export const ToolApprovalContext = createContext<ToolApprovals | null>(null);

/** Pending approvals by the tool call that they name. If two name one call, the first keeps the link. */
export function approvalsByCall(rows: readonly ApprovalRow[]): ReadonlyMap<string, ApprovalRow> {
  const byCall = new Map<string, ApprovalRow>();
  for (const row of rows) {
    if (row.toolCallId && !byCall.has(row.toolCallId)) byCall.set(row.toolCallId, row);
  }
  return byCall;
}

/** The approvals whose controls no mounted card shows. */
export function listedApprovals(
  rows: readonly ApprovalRow[],
  byCall: ReadonlyMap<string, ApprovalRow>,
  cards: MountedToolCards
): ApprovalRow[] {
  return rows.filter((row) => !row.toolCallId || !cards.has(row.toolCallId) || byCall.get(row.toolCallId) !== row);
}

/** {@link listedApprovals}, again each time a card mounts or unmounts. */
export function useListedApprovals(rows: readonly ApprovalRow[], approvals: ToolApprovals): ApprovalRow[] {
  const { cards, byCall } = approvals;
  const revision = useSyncExternalStore(cards.subscribe, cards.getRevision, cards.getRevision);
  return useMemo(() => {
    void revision;
    return listedApprovals(rows, byCall, cards);
  }, [rows, byCall, cards, revision]);
}

const NO_SUBSCRIPTION = () => () => {};

/**
 * Registers a mounted card of a call that can take a decision, and returns the
 * pending approval that the card shows: present only for the card that owns
 * the call's controls. A card whose call already has a result or an outcome
 * does not register, so a pending approval of it stays in the list.
 */
export function useCardApproval(
  toolCallId: string,
  canDecide: boolean
): { row: ApprovalRow; onDecision: ToolApprovals["onDecision"] } | null {
  const approvals = useContext(ToolApprovalContext);
  const cards = approvals?.cards;
  const [card] = useState(() => Symbol("tool card"));
  // Before paint, so the list and the card never both show the controls.
  useLayoutEffect(() => (canDecide ? cards?.register(toolCallId, card) : undefined), [cards, toolCallId, card, canDecide]);
  const owner = useSyncExternalStore(
    cards?.subscribe ?? NO_SUBSCRIPTION,
    () => cards?.owns(toolCallId, card) ?? false,
    () => false
  );
  const row = owner ? approvals?.byCall.get(toolCallId) : undefined;
  return row && approvals ? { row, onDecision: approvals.onDecision } : null;
}
