import { OpenBoxError } from "@openbox-ai/openbox-sdk-ts";

export {
  OpenBoxError,
  OpenBoxConfigError,
  OpenBoxAuthError,
  OpenBoxNetworkError,
  OpenBoxInsecureURLError,
  GovernanceAPIError,
  GovernanceHaltError,
  ApprovalRejectedError,
  ApprovalExpiredError
} from "@openbox-ai/openbox-sdk-ts";

/**
 * Verified value/shape-identical to base's own classes (empty subclasses,
 * same hierarchy, same `OpenBoxError` constructor behavior) — re-exported
 * above rather than duplicated (RT-F6/D3), one class instead of two.
 *
 * NOT re-exported (shape genuinely differs — kept local per the phase-06
 * facade decision rule "re-export only if identical, else keep the local
 * type"):
 * - `GuardrailsValidationError`: base's version takes a `reasons: string[]`
 *   array and derives the message from it; this package's has always taken a
 *   plain message string (standard `OpenBoxError` constructor). Re-exporting
 *   base's would silently change the constructor contract for any existing
 *   `new GuardrailsValidationError(someMessageString)` call site.
 * - `ApprovalPendingError`: base has no equivalent class at all (base's HITL
 *   error set is `ApprovalRejectedError` / `ApprovalExpiredError` /
 *   `ApprovalTimeoutError`, no "still pending" error).
 */
export class GuardrailsValidationError extends OpenBoxError {}

export class ApprovalPendingError extends OpenBoxError {}
