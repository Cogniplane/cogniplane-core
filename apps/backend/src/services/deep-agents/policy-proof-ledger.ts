import {
  createPolicyApprovalProof,
  matchesPolicyApprovalAction,
  type PolicyApprovalProof
} from "../policy/policy-approval-proof.js";

/** A proposed MCP call as the HITL predicate, pending extraction or dispatch hook sees it. */
export type LedgerCall = { id?: string; name: string; serverId?: string; args: Record<string, unknown> };

// HITL action requests carry only name, args and description. The backend
// writes the description, so it carries the tool-call ID that keys the proof.
const PROOF_REF = "policy-proof:";

/**
 * Backend-held Policy Center proofs for one session runtime, keyed by tool-call
 * ID. Proofs never enter tool arguments. Model call IDs can repeat, so a held
 * proof belongs to a call only when it binds the same tool, server and arguments.
 */
export class PolicyProofLedger {
  private readonly proofs = new Map<string, PolicyApprovalProof>();
  // Calls interrupted for a proof and not yet resumed.
  private readonly pending = new Set<string>();

  /** Forget every proof: fresh stream input, approval settings or capabilities changed. */
  reset(): void {
    this.proofs.clear();
    this.pending.clear();
  }

  /** HITL description for an interrupted call. */
  description(toolCallId: string | undefined): string {
    return `${PROOF_REF}${toolCallId ?? ""}`;
  }

  /**
   * Start one predicate run for a call. Ownership of a held proof is fixed now,
   * before policy evaluation awaits, so a concurrent call with the same ID
   * cannot take over a proof that another interrupt creates meanwhile.
   */
  begin(call: LedgerCall): {
    /** The call needs no policy proof. Drop a proof it owns, never another call's. */
    release: () => void;
    /**
     * Decide whether a call that requires policy approval interrupts. On resume
     * the predicate runs again for the interrupted call and reuses its proof
     * once; a later call with the same ID gets a new proof. False means no proof
     * can bind the call, so the user is not asked and the gateway refuses it.
     */
    interrupt: (
      siblings: ReadonlyArray<{ id?: string }> | undefined,
      evaluated: { toolContextId: string; ruleId: string | null; explanation: string }
    ) => boolean;
  } {
    const owned = this.owns(call);
    const release = () => {
      if (call.id && owned) {
        this.proofs.delete(call.id);
        this.pending.delete(call.id);
      }
    };
    return {
      release,
      interrupt: (siblings, evaluated) => {
        const { id: toolCallId, serverId } = call;
        if (!toolCallId || !serverId) {
          release();
          return false;
        }
        // The dispatch hook sees only the model's call ID, so a duplicated ID
        // cannot bind one proof per call. Refuse instead of guessing.
        if (siblings && siblings.filter((sibling) => sibling.id === toolCallId).length > 1) return false;
        if (this.pending.has(toolCallId)) {
          // Another live interrupt holds this ID. Keep its proof.
          if (!owned) return false;
          this.pending.delete(toolCallId);
          return true;
        }
        this.proofs.set(toolCallId, createPolicyApprovalProof({
          ...evaluated, toolCallId, toolName: call.name, serverId, args: call.args
        }));
        this.pending.add(toolCallId);
        return true;
      }
    };
  }

  /** Proof for a pending HITL action request, found through its description. */
  forAction(action: LedgerCall & { description?: string }): PolicyApprovalProof | undefined {
    const id = action.description?.startsWith(PROOF_REF) ? action.description.slice(PROOF_REF.length) : undefined;
    return id && this.pending.has(id) && this.owns({ ...action, id }) ? this.proofs.get(id) : undefined;
  }

  /** Proof to inject at dispatch. The gateway checks the same tool, server and arguments. */
  forDispatch(toolCallId: string | undefined, call: LedgerCall): PolicyApprovalProof | undefined {
    return toolCallId && this.owns({ ...call, id: toolCallId }) ? this.proofs.get(toolCallId) : undefined;
  }

  private owns(call: LedgerCall): boolean {
    const held = call.id ? this.proofs.get(call.id) : undefined;
    return Boolean(held && call.serverId && held.toolCallId === call.id &&
      matchesPolicyApprovalAction(held, { toolName: call.name, serverId: call.serverId, args: call.args }));
  }
}
