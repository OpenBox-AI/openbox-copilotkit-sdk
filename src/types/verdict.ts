import {
  Verdict as BaseVerdictValues,
  highestPriorityVerdict,
  verdictFromString,
  verdictPriority,
  verdictRequiresApproval,
  verdictShouldStop,
  type Verdict as BaseVerdict
} from "@openbox-ai/openbox-sdk-ts";

/**
 * Verdict values are byte-identical to base's `Verdict` (`contracts/results.js`)
 * — verified: `allow` | `constrain` | `require_approval` | `block` | `halt`,
 * same priority ordering. Base exposes the VALUES and the priority/parse
 * helpers as separate top-level functions rather than attached to the value
 * object, so this package's historical method-bearing `Verdict.fromString(...)`
 * / `.priorityOf(...)` / `.highestPriority(...)` / `.shouldStop(...)` /
 * `.requiresApproval(...)` public shape is preserved here as a thin wrapper —
 * every method below delegates to base's own logic (no local re-implementation).
 */
export type Verdict = BaseVerdict;

export const Verdict = Object.freeze({
  ...BaseVerdictValues,
  fromString(value?: string | null): Verdict {
    return verdictFromString(value);
  },
  highestPriority(verdicts: Verdict[]): Verdict {
    return highestPriorityVerdict(verdicts);
  },
  priorityOf(verdict: Verdict): number {
    return verdictPriority(verdict);
  },
  requiresApproval(verdict: Verdict): boolean {
    return verdictRequiresApproval(verdict);
  },
  shouldStop(verdict: Verdict): boolean {
    return verdictShouldStop(verdict);
  }
});
