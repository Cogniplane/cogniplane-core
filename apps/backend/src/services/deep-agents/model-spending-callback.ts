import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import type { BaseMessage } from "@langchain/core/messages";
import type { Serialized } from "@langchain/core/load/serializable";
import type { LLMResult } from "@langchain/core/outputs";
import { calculateCostUsd } from "../token-cost-calculator.js";
import { ModelSpendingError, toMicroUsd, type ModelSpendingStore, type SpendingReservation } from "../model-spending-store.js";

// Callbacks cover direct summarization calls as well as agent/subagent calls.
// Awaiting with raiseError is essential: background callbacks cannot admit work.
export class ModelSpendingCallback extends BaseCallbackHandler {
  name = "TenantModelSpending";
  raiseError = true;
  awaitHandlers = true;
  private tail: Promise<void> = Promise.resolve();
  private calls = new Map<string, { release: () => void; model: string }>();
  private spent = 0;
  private failed = false;
  private closed = false;
  // Model starts that reached this handler, refused or admitted.
  private handled = 0;
  // Model starts that the event stream reported.
  private streamed = 0;
  private finishPromise?: Promise<void>;
  // Ledger writes still in progress. Settlement waits for them.
  private writes = new Set<Promise<unknown>>();

  constructor(
    private readonly store: Pick<ModelSpendingStore, "startCall" | "completeCall" | "failCall" | "finish">,
    private readonly reservation: SpendingReservation,
    private readonly modelName: string,
    private readonly signal: AbortSignal
  ) { super(); }

  assertAllowance(): void {
    if (this.closed || this.failed || this.signal.aborted || this.spent >= this.reservation.reservedMicroUsd) {
      throw new ModelSpendingError("model_turn_allowance", "This turn's model allowance is exhausted or its usage is incomplete. Saved progress remains available.");
    }
  }

  observeEvent(event: Record<string, unknown>): void {
    if (event.event === "on_chat_model_start") this.streamed++;
  }

  async handleChatModelStart(_llm: Serialized, _messages: BaseMessage[][], runId: string,
    _parentRunId?: string, _extra?: Record<string, unknown>, _tags?: string[], metadata?: Record<string, unknown>): Promise<void> {
    // Count before any refusal. The stream reports a start even when this handler throws.
    this.handled++;
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>(resolve => { release = resolve; });
    try {
      await previous;
      this.assertAllowance();
      const model = typeof metadata?.ls_model_name === "string" ? metadata.ls_model_name : this.modelName;
      if (calculateCostUsd(model, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, totalTokens: 0 }) === null) {
        throw new ModelSpendingError("model_price_unknown", "This model has no cost estimate. Choose a priced model while spending limits are enabled.");
      }
      await this.track((async () => {
        await this.store.startCall(this.reservation, runId, model);
        // The ledger now records possible spend, even if cancellation races dispatch.
        this.calls.set(runId, { release, model });
      })());
      this.assertAllowance();
    } catch (error) {
      if (this.calls.has(runId)) await this.handleLLMError(error, runId);
      else release();
      throw error;
    }
  }

  async handleLLMEnd(output: LLMResult, runId: string): Promise<void> {
    const call = this.calls.get(runId);
    if (!call) return;
    let cost: number | null = 0;
    try {
      for (const generation of output.generations.flat()) {
        const usage = (generation as { message?: { usage_metadata?: {
          input_tokens: number; output_tokens: number; input_token_details?: { cache_read?: number }
        } } }).message?.usage_metadata;
        const input = usage?.input_tokens;
        const out = usage?.output_tokens;
        const cached = usage?.input_token_details?.cache_read ?? 0;
        if (typeof input !== "number" || typeof out !== "number" ||
          !Number.isFinite(input) || !Number.isFinite(out) || !Number.isFinite(cached) || input < 0 || out < 0 || cached < 0 || cached > input) {
          cost = null;
          break;
        }
        const value = calculateCostUsd(call.model, { inputTokens: input, outputTokens: out,
          cachedInputTokens: cached, reasoningOutputTokens: 0, totalTokens: input + out });
        if (value === null) { cost = null; break; }
        cost += toMicroUsd(value);
      }
      if (!output.generations.flat().length) cost = null;
      await this.track(this.store.completeCall(this.reservation, runId, cost));
      if (cost === null) {
        this.failed = true;
        throw new ModelSpendingError("model_usage_unknown", "The model did not report complete usage. Saved progress remains available; an administrator must reconcile the spending record.");
      }
      this.spent += cost;
    } catch (error) {
      this.failed = true;
      throw error;
    } finally {
      this.calls.delete(runId);
      call.release();
    }
  }

  async handleLLMError(_error: unknown, runId: string): Promise<void> {
    const call = this.calls.get(runId);
    if (!call) return;
    this.failed = true;
    try { await this.track(this.store.failCall(this.reservation, runId)); }
    finally { this.calls.delete(runId); call.release(); }
  }

  private async track<T>(write: Promise<T>): Promise<T> {
    this.writes.add(write);
    try { return await write; }
    finally { this.writes.delete(write); }
  }

  finish(): Promise<void> {
    this.closed = true;
    for (const call of this.calls.values()) call.release();
    return this.finishPromise ??= (async () => {
      while (this.writes.size) await Promise.allSettled([...this.writes]);
      // A call still open when the turn ends was cancelled or abandoned.
      const abandoned = [...this.calls.keys()];
      this.calls.clear();
      try {
        // A call that this write fails to close stays 'pending', so the turn settles as 'unknown'.
        for (const runId of abandoned) await this.store.failCall(this.reservation, runId);
      } finally {
        // Always settle, so a write error cannot leave the reservation 'reserved'.
        // A model started without this handler: fail closed, its usage is not known.
        if (this.streamed > this.handled) {
          await this.store.finish(this.reservation, { callId: "untracked-model-call", modelName: this.modelName });
        } else {
          await this.store.finish(this.reservation);
        }
      }
    })();
  }
}
