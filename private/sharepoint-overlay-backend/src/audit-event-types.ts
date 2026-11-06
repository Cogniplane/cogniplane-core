// Audit event types that only this overlay emits. Core names no Microsoft
// event; this augmentation adds them to core's `AuditEventType`. Do not change
// the strings: stored audit rows and log monitoring use them.
declare module "../../../apps/backend/src/services/audit-event-types.js" {
  interface OverlayAuditEventTypes {
    "user.microsoft.connected": true;
    "user.microsoft.disconnected": true;
    "user.microsoft.confirmed": true;
  }
}

export {};
