export class InMemoryAuditEventStore {
  readonly events: Array<{
    sessionId: string | null;
    userId: string;
    approvalId: string | null;
    type: string;
    payload: Record<string, unknown>;
  }> = [];

  async create(input: {
    sessionId?: string | null;
    userId?: string;
    approvalId?: string | null;
    type: string;
    payload: Record<string, unknown>;
  }) {
    this.events.push({
      sessionId: input.sessionId ?? null,
      userId: input.userId ?? "unknown",
      approvalId: input.approvalId ?? null,
      type: input.type,
      payload: input.payload
    });
  }
}
