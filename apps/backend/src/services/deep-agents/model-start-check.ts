import { BaseCallbackHandler } from "@langchain/core/callbacks/base";

/**
 * Runs a backend check before each model call of a turn. The start callback
 * is the one point that every model call passes: the calls of the agent, of
 * delegated agents, and the summaries that the summarization middleware asks
 * from the model directly, outside the agent middleware. LangChain awaits
 * this handler and passes its error on (awaitHandlers, raiseError), so the
 * provider gets no request when the check throws.
 *
 * A turn with a spending reservation gives the check to ModelSpendingCallback
 * instead, which runs it before its ledger write.
 */
export class ModelStartCheck extends BaseCallbackHandler {
  name = "ModelStartCheck";
  raiseError = true;
  awaitHandlers = true;

  constructor(private readonly check: () => Promise<void>) { super(); }

  async handleChatModelStart(): Promise<void> {
    await this.check();
  }
}
