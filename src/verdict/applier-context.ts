import type { OpenBoxLogger } from "../copilotkit/types.js";

/** Gateway tag identifying the boundary that observed or enforced a verdict. */
export type ApplierGateway =
  | "agui_event"
  | "frontend"
  | "llm"
  | "mcp"
  | "runtime"
  | "server_tool"
  | "sub_agent_report";

/**
 * Subject of the verdict. Free-form because the call sites vary (tool call,
 * AG-UI event, HTTP request, sub-agent report). `type` keys the shape so
 * audits can be filtered; extra keys flow through.
 */
export interface ApplierSubject {
  [k: string]: unknown;
  type: string;
}

/**
 * Identifies the in-flight event the verdict applies to. Required for the
 * idempotency-key composition (`sha256(workflowId:runId:activityId:attempt)`)
 * that lands on every audit-envelope-tagged span.
 */
export interface ApplierEvent {
  activityId: string;
  attempt: number;
  runId: string;
  traceId?: string;
  workflowId: string;
}

/** Per-call context passed to `applyVerdict`. */
export interface ApplierContext {
  auditEnvelope: (attrs: Record<string, unknown>) => void;
  event?: ApplierEvent;
  gateway: ApplierGateway;
  logger: OpenBoxLogger;
  subject: ApplierSubject;
}

/**
 * Result of `applyVerdict`. `continue` ⇒ caller proceeds; `halt` ⇒ caller
 * aborts the current operation with the given reason. The deferred verdict
 * cases (`constrain` / `require_approval` / `halt`) throw
 * `VerdictNotImplementedError` instead of returning a result.
 */
export type ApplierResult =
  | { kind: "continue" }
  | { kind: "halt"; reason: string };
