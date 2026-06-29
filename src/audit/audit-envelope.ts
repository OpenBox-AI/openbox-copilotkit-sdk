import type { ApplierGateway } from "../verdict/applier-context.js";

import { idempotencyKey } from "./idempotency-key.js";

import type { SpanData } from "../spans/span-data.js";

/**
 * Enforcement-status vocabulary attached to OpenBox audit spans.
 * Each value carries a distinct semantic meaning for UI rendering and
 * post-hoc analysis.
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

/** Audit-envelope owner tag for spans emitted by this SDK. */
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
 * Mutate `span.attributes` in place to attach the OpenBox audit-envelope
 * attribute set. Returns the same span for ergonomic chaining.
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
