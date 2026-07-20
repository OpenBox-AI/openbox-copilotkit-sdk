import type { OpenBoxLogger } from "../types.js";

/**
 * One-time-per-field-name deprecation-warning dedupe for `config-translator.ts`
 * (D3 -- "deprecated fields keep working but warn once", not once per
 * `buildBaseRuntime` call). Split into its own module purely so the dedupe
 * `Set` + reset-for-tests hook have one obvious home.
 *
 * Deliberately module-level, process-lifetime state: a caller that builds
 * several controllers in one process with the same deprecated field must see
 * exactly ONE warning total. vitest gives each test FILE its own module
 * registry by default, so this only ever needs resetting WITHIN one file's
 * `it()` blocks -- see `resetConfigTranslatorDeprecationWarningsForTests`.
 */
const warnedFields = new Set<string>();

/** Test-only. Not exported from any public barrel -- internal module, direct-imported by tests like every other `internal/*` helper. */
export function resetConfigTranslatorDeprecationWarningsForTests(): void {
  warnedFields.clear();
}

/** Logs (once per `field`) via the caller's logger; a repeat call for the same field is a no-op. */
export function warnDeprecatedOnce(
  logger: OpenBoxLogger | undefined,
  field: string,
  reason: string,
  note: string
): void {
  if (warnedFields.has(field)) {
    return;
  }
  warnedFields.add(field);
  logger?.warn?.({ field, note, reason });
}
