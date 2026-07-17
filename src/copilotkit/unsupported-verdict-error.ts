/**
 * Thrown by an ENFORCING caller — the frontend `TOOL_CALL_END` gate today
 * (`openbox-middleware.ts`), the Phase 5 server-tool wrapper later — when the
 * base runtime's `OpenBoxRuntime.evaluateLifecycle()` returns a verdict the
 * adapter takes no action on.
 *
 * `evaluateLifecycle` routes REQUIRE_APPROVAL through `adapter.handleApproval`
 * and BLOCK/HALT through `adapter.raiseLifecycleBlocked` — both throw a base
 * error type on a non-allow outcome. ALLOW *and* CONSTRAIN are both returned
 * normally, with no adapter call at all (verified: `openbox-runtime.ts`'s
 * `evaluateLifecycle`/`enforceLifecycle`, base SDK 1.0.1). CONSTRAIN has no
 * enforcement action defined yet (deferred to Phase 6), so the CALLER must
 * inspect the returned `result.verdict` itself and raise this error BEFORE
 * delivering the tool call to the frontend / running it — never a silent
 * allow.
 *
 * This is a plain control-error type, not a `FrameworkAdapter` method: it is
 * thrown by callers, then caught and translated (alongside the base control
 * errors) into a `CopilotKitGovernanceControlError` — the same redacted
 * `governance_blocked` frame a BLOCK/HALT/rejected approval produces.
 */
export class CopilotKitUnsupportedVerdictError extends Error {
  /**
   * Best-effort correlation id for the redacted `governance_blocked` frame
   * (`governanceEventId`/`approvalId` off the `EvaluationResult` that
   * produced this error, or `"unknown"` when neither is present).
   */
  readonly correlationId: string;
  /** The verdict the adapter has no enforcement action for (e.g. `"constrain"`). */
  readonly verdict: string;

  constructor(verdict: string, correlationId: string) {
    super(
      `Unsupported governance verdict at the CopilotKit enforcement boundary: ${verdict}`
    );
    this.name = new.target.name;
    this.correlationId = correlationId;
    this.verdict = verdict;
  }
}
