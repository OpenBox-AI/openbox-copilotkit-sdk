import { createHash } from "node:crypto";

export interface IdempotencyKeyInput {
  activityId: string;
  attempt: number;
  runId: string;
  workflowId: string;
}

/**
 * Per-event fingerprint used by both `@openbox-ai/openbox-copilotkit` (tool
 * spans) and `@openbox-ai/openbox-mastra-sdk` (LLM completion spans) when
 * stamping `openbox.idempotency_key` on the audit envelope.
 *
 * Formula locked across SDKs by convention (NOT by shared code — the
 * independence rule forbids a `@openbox-ai/*` runtime dep here):
 *
 *     sha256(workflowId + ":" + runId + ":" + activityId + ":" + attempt)
 *
 * The string is hex-encoded (lower-case). Matches Core's de-facto
 * fingerprint key used in `setApprovalCache` (`internal/services/governance.go:316-319`).
 * Cross-impl parity is verified by the golden test in this file's spec.
 */
export function idempotencyKey(input: IdempotencyKeyInput): string {
  const composed = `${input.workflowId}:${input.runId}:${input.activityId}:${input.attempt}`;
  return createHash("sha256").update(composed).digest("hex");
}
