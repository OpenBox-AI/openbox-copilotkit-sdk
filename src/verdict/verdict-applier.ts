import { OpenBoxError } from "../types/errors.js";

import type { ApplierContext, ApplierResult } from "./applier-context.js";
import type { OpenBoxVerdict } from "./openbox-verdict.js";

/**
 * Thrown by `applyVerdict` for verdict cases that have not yet been wired in
 * this ship gate. Audit attrs are emitted via `ctx.auditEnvelope` BEFORE the
 * throw so the observation survives even when the caller bubbles the error.
 *
 * Cases deferred at 0.3.0-beta.0:
 *  - `constrain` (constrain enforcement is 0.4.0)
 *  - `require_approval` (approval polling is 0.5.0)
 *  - `halt` (halt routing is 0.4.0)
 */
export class VerdictNotImplementedError extends OpenBoxError {}

/**
 * Apply an `OpenBoxVerdict` at the call site. This is the only place that
 * distinguishes the union cases; the verdict-mapper produces the union and
 * the applier enforces it.
 *
 * Status emitted via `ctx.auditEnvelope`:
 *  - `allow`            → `pre_execution_allowed`
 *  - `block`            → `pre_execution_blocked` + `openbox.block_reason`
 *  - `constrain`        → `late_detection` + `openbox.deferred_verdict_type`
 *  - `require_approval` → `late_detection` + `openbox.deferred_verdict_type`
 *  - `halt`             → `halt_requested` + `openbox.deferred_verdict_type`
 *
 * The audit attrs MUST be emitted before the result is returned (or the
 * error is thrown) so consumers of the SpanBuffer see the verdict outcome
 * regardless of how the caller handles the throw.
 */
export function applyVerdict(
  verdict: OpenBoxVerdict,
  ctx: ApplierContext
): ApplierResult {
  switch (verdict.type) {
    case "allow": {
      ctx.auditEnvelope({
        "openbox.enforcement_status": "pre_execution_allowed",
        ...(verdict.reason
          ? { "openbox.allow_reason": verdict.reason }
          : {})
      });
      return { kind: "continue" };
    }

    case "block": {
      ctx.auditEnvelope({
        "openbox.block_reason": verdict.reason,
        "openbox.enforcement_status": "pre_execution_blocked"
      });
      return { kind: "halt", reason: verdict.reason };
    }

    case "constrain": {
      ctx.auditEnvelope({
        "openbox.constraint_count": verdict.constraints.length,
        "openbox.deferred_verdict_type": "constrain",
        "openbox.enforcement_status": "late_detection"
      });
      throw new VerdictNotImplementedError(
        "constrain enforcement is a later ship gate / 0.4.0"
      );
    }

    case "require_approval": {
      ctx.auditEnvelope({
        "openbox.approval_id": verdict.approval_id,
        "openbox.deferred_verdict_type": "require_approval",
        "openbox.enforcement_status": "late_detection"
      });
      throw new VerdictNotImplementedError(
        "approval polling is a later ship gate / 0.5.0"
      );
    }

    case "halt": {
      ctx.auditEnvelope({
        "openbox.deferred_verdict_type": "halt",
        "openbox.enforcement_status": "halt_requested",
        ...(verdict.code ? { "openbox.halt_code": verdict.code } : {}),
        ...(verdict.halt_scope
          ? { "openbox.halt_scope": verdict.halt_scope }
          : {})
      });
      throw new VerdictNotImplementedError(
        "halt routing is a later ship gate / 0.4.0"
      );
    }

    default: {
      assertNever(verdict);
    }
  }
}

function assertNever(value: never): never {
  throw new VerdictNotImplementedError(
    `Unhandled OpenBoxVerdict case: ${JSON.stringify(value)}`
  );
}
