import type { ApplierGateway } from "../verdict/applier-context.js";

import { idempotencyKey } from "./idempotency-key.js";

import type { SpanData } from "../spans/span-data.js";

/**
 * Enforcement-status vocabulary locked at brainstorm validation (2026-06-29).
 * Each value carries a distinct semantic meaning when read off a span by the
 * OpenBox UI or by post-hoc analysis.
 */
export type EnforcementStatus =
  | "approval_pending"
  | "halt_acknowledged"
  | "halt_failed"
  | "halt_requested"
  | "late_detection"
  | "pre_execution_allowed"
  | "pre_execution_blocked"
  | "pre_execution_constrained";

/**
 * Audit-envelope owner tag — locked for this SDK. Cross-checked by the
 * adapter coverage matrix in mastra-sdk's CHANGELOG ("openbox-mastra").
 */
export const ENFORCEMENT_OWNER = "openbox-copilotkit" as const;

export interface AuditEnvelopeInput {
  activityId: string;
  attempt: number;
  enforcementOwner?: string;
  enforcementStatus: EnforcementStatus;
  gateway: ApplierGateway;
  policyVersion?: string;
  runId: string;
  traceId?: string;
  workflowId: string;
}

/**
 * Mutate `span.attributes` in place to attach the locked audit-envelope
 * attribute set. Returns the same span for ergonomic chaining.
 *
 * Locked attribute keys (do not rename — these cross repo boundaries by
 * convention with `@openbox-ai/openbox-mastra-sdk` and Core's indexers):
 *  - `openbox.enforcement_owner` (constant for this SDK)
 *  - `openbox.gateway`
 *  - `openbox.enforcement_status`
 *  - `openbox.idempotency_key`
 *  - `openbox.policy_version` (optional — only when verdict was consulted)
 *  - `openbox.trace_id` (optional — only when call site has it)
 */
export function attachAuditEnvelope(
  span: SpanData,
  envelope: AuditEnvelopeInput
): SpanData {
  const key = idempotencyKey({
    activityId: envelope.activityId,
    attempt: envelope.attempt,
    runId: envelope.runId,
    workflowId: envelope.workflowId
  });

  span.attributes["openbox.enforcement_owner"] =
    envelope.enforcementOwner ?? ENFORCEMENT_OWNER;
  span.attributes["openbox.gateway"] = envelope.gateway;
  span.attributes["openbox.enforcement_status"] = envelope.enforcementStatus;
  span.attributes["openbox.idempotency_key"] = key;
  if (envelope.policyVersion) {
    span.attributes["openbox.policy_version"] = envelope.policyVersion;
  }
  if (envelope.traceId) {
    span.attributes["openbox.trace_id"] = envelope.traceId;
  }
  return span;
}
