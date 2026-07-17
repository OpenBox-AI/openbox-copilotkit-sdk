/**
 * Caller-side control error for CopilotKit governance/approval outcomes.
 *
 * The base `CoreAdapter` (wired in `base-runtime-builder.ts`) throws its own
 * typed errors directly — `ApprovalRejectedError`, `ApprovalExpiredError`,
 * `ApprovalTimeoutError`, `GovernanceBlockedError`, `GovernanceHaltError` —
 * and this SDK does not reimplement that logic (RT-F12). CopilotKit-specific
 * translation happens at the CALLER boundary (the frontend `TOOL_CALL_END`
 * gate today, the Phase 5 `serverTool()` wrapper later): those callers catch
 * a base error (or the caller-thrown `CopilotKitUnsupportedVerdictError`),
 * map it to one of the reasons below, and construct this error to drive the
 * redacted `governance_blocked` frame.
 *
 * Constructed in `openbox-middleware.ts`'s enforce gate (Phase 4b).
 */

/** Discriminant naming which governance/approval outcome produced the error. */
export type CopilotKitGovernanceControlReason =
  | "blocked"
  | "halt"
  | "approval_rejected"
  | "approval_expired"
  | "approval_timeout"
  | "unsupported_verdict"
  /**
   * The governance evaluation call itself failed for a reason that is not a
   * recognized control/approval/verdict outcome — auth/signing rejection,
   * network/API failure (`GovernanceAPIError`), or any other unexpected
   * throw from `evaluateLifecycle`. The enforcement boundary still fails
   * CLOSED on this reason — it is never converted to an allow.
   */
  | "evaluation_error";

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
