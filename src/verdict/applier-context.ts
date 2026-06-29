import type { OpenBoxLogger } from "../copilotkit/types.js";

/**
 * Gateway tag identifying the SDK boundary that observed/enforced the
 * verdict. Locked across SDKs: copilotkit-sdk uses `agui_event` (AG-UI
 * middleware seam) and `server_tool` (server-tool gateway, later gate);
 * mastra-sdk uses `llm` for its LLM-completion-span emission seam.
 */
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

/**
 * Per-call context passed to `applyVerdict`. The `auditEnvelope` callback is
 * the only side-effect channel — Phase 2 wires it to the in-flight span in
 * `SpanBuffer`; Phase 1 tests use an in-memory recorder.
 */
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
