/**
 * Kept local (NOT re-exported from base) — phase-06 facade decision rule:
 * base's equivalent (`GuardrailsResult` in `contracts/results.js`) uses a
 * DIFFERENT name and a no-arg-constructor + static-`fromDict` pattern (fields
 * default-initialized, never built via `new GuardrailsResult({...})`), while
 * this package's `GuardrailsCheckResult` has always taken an init object
 * through its constructor (`new GuardrailsCheckResult({inputType, ...})` —
 * see `test/unit/types.test.ts`). Re-exporting base's class under this name
 * would silently break that constructor contract for existing callers.
 */
export interface GuardrailReason {
  field?: string;
  reason?: string;
  type?: string;
}

export interface GuardrailsCheckResultInit {
  inputType: string;
  rawLogs?: Record<string, unknown> | undefined;
  reasons?: GuardrailReason[] | undefined;
  redactedInput: unknown;
  validationPassed?: boolean | undefined;
}

export class GuardrailsCheckResult {
  public readonly inputType: string;
  public readonly rawLogs: Record<string, unknown> | undefined;
  public readonly reasons: GuardrailReason[];
  public readonly redactedInput: unknown;
  public readonly validationPassed: boolean;

  public constructor({
    inputType,
    rawLogs,
    reasons = [],
    redactedInput,
    validationPassed = true
  }: GuardrailsCheckResultInit) {
    this.inputType = inputType;
    this.rawLogs = rawLogs;
    this.reasons = reasons;
    this.redactedInput = redactedInput;
    this.validationPassed = validationPassed;
  }

  public getReasonStrings(): string[] {
    return this.reasons
      .map(reason => reason.reason)
      .filter((reason): reason is string => Boolean(reason));
  }
}
