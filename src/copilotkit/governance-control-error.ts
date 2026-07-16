/**
 * Caller-side control error for CopilotKit governance/approval outcomes.
 *
 * The base `CoreAdapter` (wired in `base-runtime-builder.ts`) throws its own
 * typed errors directly — `ApprovalRejectedError`, `ApprovalExpiredError`,
 * `ApprovalTimeoutError`, `GovernanceBlockedError` — and this SDK does not
 * reimplement that logic (RT-F12). CopilotKit-specific translation happens at
 * the CALLER boundary (the frontend gate and the `serverTool()` wrapper,
 * Phases 4-5): those callers catch a base error, map it to one of the reasons
 * below, and construct this error to drive the redacted `governance_blocked`
 * frame or an explicit tool-execution failure.
 *
 * This file only defines the shape now; no caller constructs it yet.
 */

/** Discriminant naming which governance/approval outcome produced the error. */
export type CopilotKitGovernanceControlReason =
  | "blocked"
  | "halt"
  | "approval_rejected"
  | "approval_expired"
  | "approval_timeout"
  | "unsupported_verdict";

export interface CopilotKitGovernanceControlErrorOptions {
  cause?: unknown;
}

export class CopilotKitGovernanceControlError extends Error {
  /** Which governance/approval outcome triggered this control error. */
  readonly reason: CopilotKitGovernanceControlReason;

  constructor(
    reason: CopilotKitGovernanceControlReason,
    message: string,
    options?: CopilotKitGovernanceControlErrorOptions
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = new.target.name;
    this.reason = reason;
  }
}
