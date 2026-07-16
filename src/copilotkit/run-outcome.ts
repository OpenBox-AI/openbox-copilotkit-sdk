import type {
  Interrupt,
  ResumeStatus,
  RunAgentInput,
  RunFinishedEvent
} from "@ag-ui/client";
import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";

import { redactAndBoundRawField } from "./lifecycle-redaction.js";

/**
 * PURE parse/model of `RUN_FINISHED.outcome` + resume-run `forwardedProps`
 * (no network I/O, no client, no controller — safe to unit-test in
 * isolation against the phase-1 interrupt fixtures).
 *
 * RT-F11: `outcome` is OPTIONAL (and, per the AG-UI zod schema, nullable) —
 * a plain successful run omits it entirely. Every caller MUST go through
 * `parseRunOutcome` rather than reading `event.outcome.type` directly, so a
 * missing/`null` outcome is never misread as a thrown error or a silent
 * `undefined.type` crash.
 *
 * RT-F5: an interrupt's identity is its own `id` (the resume run's
 * `interruptId`), NEVER `toolCallId` — a non-BuiltInAgent interrupt may omit
 * `toolCallId` entirely, or carry one that differs from `id`. `id` is what
 * `parseRunOutcome`'s callers must persist/correlate on.
 */

/** One interrupt entry, redaction-safe for downstream signal/telemetry use. */
export interface ParsedInterrupt {
  readonly expiresAt?: string | undefined;
  readonly id: string;
  readonly message?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
  readonly reason: string;
  /** Redacted + size-bounded via the shared `lifecycle-redaction.ts` util — never the raw AG-UI value. */
  readonly responseSchema?: JsonValue | undefined;
  readonly toolCallId?: string | undefined;
}

export type RunOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "interrupt"; readonly interrupts: readonly ParsedInterrupt[] };

/** One resume entry from a resumed run's `forwardedProps.resume` (RT-F5 — keyed on `interruptId`, i.e. the original interrupt's `id`). */
export interface ParsedResumeEntry {
  readonly interruptId: string;
  readonly payload?: unknown;
  readonly status: ResumeStatus;
}

/**
 * Parse `RUN_FINISHED.outcome`. `undefined`/`null` and `{type:"success"}`
 * both resolve to `{kind:"success"}` — the caller must never branch on
 * `event.outcome.type` without going through this guard first (RT-F11).
 *
 * `redactPaths` threads through to the SAME raw-field redaction util the
 * emitter applies to every other activity/signal field, so an interrupt's
 * `responseSchema` — which rides straight off the AG-UI stream — never
 * reaches telemetry unredacted/unbounded.
 */
export function parseRunOutcome(
  event: Pick<RunFinishedEvent, "outcome">,
  redactPaths?: readonly string[]
): RunOutcome {
  const outcome = event.outcome;
  if (outcome == null || outcome.type === "success") {
    return { kind: "success" };
  }
  return {
    interrupts: outcome.interrupts.map(interrupt => parseInterrupt(interrupt, redactPaths)),
    kind: "interrupt"
  };
}

function parseInterrupt(
  interrupt: Interrupt,
  redactPaths: readonly string[] | undefined
): ParsedInterrupt {
  const redactedSchema = redactAndBoundRawField(interrupt.responseSchema, redactPaths);
  return {
    ...(interrupt.expiresAt !== undefined ? { expiresAt: interrupt.expiresAt } : {}),
    id: interrupt.id,
    ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
    ...(interrupt.metadata !== undefined ? { metadata: interrupt.metadata } : {}),
    reason: interrupt.reason,
    ...(redactedSchema !== undefined ? { responseSchema: redactedSchema } : {}),
    ...(interrupt.toolCallId !== undefined ? { toolCallId: interrupt.toolCallId } : {})
  };
}

/**
 * Model resume entries off a resumed run's `forwardedProps.resume` (RT-F5).
 * `forwardedProps` is untyped `any` on the AG-UI wire (`RunAgentInputSchema`),
 * so every field is defensively narrowed here; a malformed entry is DROPPED
 * rather than thrown — the caller's "no matching pending interrupt" branch
 * (RT-F9) already turns a missing/unresolvable correlation into a typed
 * failure, so silently dropping a malformed entry (as opposed to crashing
 * the whole run) is the fail-safe choice.
 */
export function parseResumeEntries(
  runInput: Pick<RunAgentInput, "forwardedProps">
): ParsedResumeEntry[] {
  const forwardedProps = runInput.forwardedProps as { resume?: unknown } | null | undefined;
  const resume = forwardedProps?.resume;
  if (!Array.isArray(resume)) {
    return [];
  }
  const parsed: ParsedResumeEntry[] = [];
  for (const candidate of resume) {
    const entry = parseResumeEntry(candidate);
    if (entry) {
      parsed.push(entry);
    }
  }
  return parsed;
}

function parseResumeEntry(candidate: unknown): ParsedResumeEntry | undefined {
  if (typeof candidate !== "object" || candidate === null) {
    return undefined;
  }
  const record = candidate as Record<string, unknown>;
  const interruptId = record["interruptId"];
  const status = record["status"];
  if (
    typeof interruptId !== "string" ||
    (status !== "resolved" && status !== "cancelled")
  ) {
    return undefined;
  }
  return {
    interruptId,
    ...(Object.prototype.hasOwnProperty.call(record, "payload")
      ? { payload: record["payload"] }
      : {}),
    status
  };
}
