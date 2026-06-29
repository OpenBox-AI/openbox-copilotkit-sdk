import { createHash } from "node:crypto";

export interface IdempotencyKeyInput {
  activityId: string;
  attempt: number;
  runId: string;
  workflowId: string;
}

/**
 * Per-event fingerprint stamped onto the audit envelope.
 *
 * Formula:
 *
 *     sha256(workflowId + ":" + runId + ":" + activityId + ":" + attempt)
 *
 * The string is hex-encoded and lower-case.
 */
export function idempotencyKey(input: IdempotencyKeyInput): string {
  const composed = `${input.workflowId}:${input.runId}:${input.activityId}:${input.attempt}`;
  return createHash("sha256").update(composed).digest("hex");
}
