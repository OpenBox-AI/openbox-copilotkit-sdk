/**
 * Verified value-identical to base's `EventType` (`contracts/events.js`) — all
 * 7 backend wire event types match byte-for-byte (`WorkflowStarted`,
 * `WorkflowCompleted`, `WorkflowFailed`, `SignalReceived`, `ActivityStarted`,
 * `ActivityCompleted`, `Handoff`). This package's `WorkflowEventType` was a TS
 * string `enum`; string enums have no reverse mapping, so their runtime shape
 * (a plain object of the 7 forward key→value pairs) is identical to base's
 * const-object + union-type pattern. Re-exported under this package's
 * historical name (RT-F6/D3) rather than duplicated.
 */
export { EventType as WorkflowEventType } from "@openbox-ai/openbox-sdk-ts";
