/**
 * Thrown by `server-tool.ts`'s wrapper when `enforcementOptions.mode ===
 * "enforce"` and it cannot resolve run correlation (per-run `workflowId`/
 * `runId` from `controller.runContext`, plus `activityId` from
 * `executionOptions.toolCallId`) BEFORE the real tool body runs. Fail-safe:
 * `execute` never runs for this call.
 *
 * Distinct from `CopilotKitGovernanceControlError` (which represents an
 * actual governance verdict/approval outcome returned by Core) — this is the
 * wrapper's OWN precondition check, raised before any evaluation call is
 * ever made. Split into its own module (rather than living inside
 * `server-tool.ts`) matching this directory's own convention of one small
 * file per caller-thrown error type (see `governance-control-error.ts`,
 * `unsupported-verdict-error.ts`).
 */
export class CopilotKitServerToolCorrelationError extends Error {
  constructor(toolName: string, missing: { runContext: boolean; toolCallId: boolean }) {
    const missingParts = [
      missing.runContext ? "the per-run workflowId/runId (controller.runContext)" : undefined,
      missing.toolCallId ? "executionOptions.toolCallId" : undefined
    ].filter((part): part is string => part !== undefined);
    super(
      `OpenBox server-tool enforcement for tool "${toolName}" is missing ${missingParts.join(" and ")}. ` +
        "Failing safe -- execute did NOT run. This usually means the tool executed outside an " +
        "OpenBox-bound AG-UI run, or the CopilotKit/AI SDK peer no longer supplies " +
        "executionOptions.toolCallId to a BuiltInAgent tool's execute (see " +
        "test/contract/copilotkit-execution-options.test.ts, which pins that seam)."
    );
    this.name = new.target.name;
  }
}
