import { OpenBoxError } from "../types/errors.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { Verdict } from "../types/verdict.js";

import {
  OpenBoxConstraintSchema,
  OpenBoxReplacementSchema,
  OpenBoxVerdictSchema,
  type OpenBoxConstraint,
  type OpenBoxReplacement,
  type OpenBoxVerdict
} from "./openbox-verdict.js";

/**
 * Thrown when Core returns a verdict whose shape cannot be mapped onto the
 * `OpenBoxVerdict` union (e.g., `verdict:"constrain"` without a `reason`).
 * Permissive on missing optional fields; strict on shape mismatch.
 */
export class VerdictMappingError extends OpenBoxError {}

export interface MapVerdictOptions {
  /**
   * When true, an unrecognized verdict string throws `VerdictMappingError`.
   * When false (default), maps to a safe `block` with reason
   * `"unknown_verdict_action:<raw>"` and logs at `error`.
   */
  strictMode?: boolean;

  /**
   * Logger surface for `warn`/`error` channels. Optional; if absent, the
   * mapper is silent (still throws on hard mismatch when strict).
   */
  logger?: {
    error?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
  };
}

/**
 * Map a Core `GovernanceVerdictResponse` instance onto the SDK-side
 * `OpenBoxVerdict` discriminated union. Single translation point: callers
 * downstream of this function never inspect the flat `Verdict` enum again.
 *
 * Field harvesting rules:
 *  - `constraints` (Record<string, unknown>[]): each entry passed through
 *    `OpenBoxConstraintSchema`. Items that don't validate fall back to
 *    `{type:"add-metadata", key:"raw_constraint", value:<entry>}` and emit
 *    one `warn` log.
 *  - `approval_id` (synthesized if Core didn't return one): `idempotency_key`
 *    of `(workflowId:runId:activityId:attempt)` is the SDK convention, but
 *    composing it requires per-call context. This mapper does NOT have that
 *    context — synthesis happens in `verdict-applier.ts` where the call site
 *    has the event details. The mapper just uses `response.approvalId` if
 *    present, else falls back to `"pending"` (a sentinel that the applier
 *    rewrites).
 *  - `replacement`: harvested from `response.metadata.replacement_content`
 *    if a `block` carries one; validated via `OpenBoxReplacementSchema`.
 *  - `halt_scope`: defaults to `"copilot_run"` because Core currently treats
 *    halt verdicts as scoped to the active CopilotKit run.
 */
export function mapVerdict(
  response: GovernanceVerdictResponse,
  options: MapVerdictOptions = {}
): OpenBoxVerdict {
  const verdict = response.verdict;
  const reason = response.reason ?? "";

  let mapped: OpenBoxVerdict;

  switch (verdict) {
    case Verdict.ALLOW:
      mapped = { type: "allow", ...(reason ? { reason } : {}) };
      break;

    case Verdict.CONSTRAIN: {
      if (!reason) {
        throw new VerdictMappingError(
          "constrain verdict missing required 'reason' field"
        );
      }
      const constraints = mapConstraints(response.constraints, options);
      mapped = { constraints, reason, type: "constrain" };
      break;
    }

    case Verdict.REQUIRE_APPROVAL: {
      if (!reason) {
        throw new VerdictMappingError(
          "require_approval verdict missing required 'reason' field"
        );
      }
      const constraints =
        response.constraints && response.constraints.length > 0
          ? mapConstraints(response.constraints, options)
          : undefined;
      mapped = {
        approval_id: response.approvalId ?? "pending",
        ...(constraints ? { constraints } : {}),
        mode: "polling",
        on_approved: "allow",
        on_expired: "block",
        on_failed: "block",
        on_rejected: "block",
        reason,
        type: "require_approval"
      };
      break;
    }

    case Verdict.BLOCK: {
      if (!reason) {
        throw new VerdictMappingError(
          "block verdict missing required 'reason' field"
        );
      }
      const replacement = extractReplacement(response.metadata, options);
      mapped = {
        reason,
        ...(replacement ? { replacement } : {}),
        type: "block"
      };
      break;
    }

    case Verdict.HALT: {
      if (!reason) {
        throw new VerdictMappingError(
          "halt verdict missing required 'reason' field"
        );
      }
      const code = readStringFromMetadata(response.metadata, "code");
      mapped = {
        ...(code ? { code } : {}),
        halt_scope: "copilot_run",
        reason,
        type: "halt"
      };
      break;
    }

    default: {
      const raw = String(verdict);
      options.logger?.error?.({
        note: "openbox verdict-mapper received unrecognized verdict",
        raw,
        response
      });
      if (options.strictMode) {
        throw new VerdictMappingError(
          `Unrecognized verdict action: ${raw}`
        );
      }
      mapped = {
        reason: `unknown_verdict_action:${raw}`,
        type: "block"
      };
    }
  }

  return OpenBoxVerdictSchema.parse(mapped) as OpenBoxVerdict;
}

function mapConstraints(
  raw: Record<string, unknown>[] | undefined,
  options: MapVerdictOptions
): OpenBoxConstraint[] {
  if (!raw || raw.length === 0) {
    return [];
  }

  const mapped: OpenBoxConstraint[] = [];
  for (const entry of raw) {
    const parsed = OpenBoxConstraintSchema.safeParse(entry);
    if (parsed.success) {
      mapped.push(parsed.data);
      continue;
    }

    options.logger?.warn?.({
      issues: parsed.error.issues,
      note: "openbox verdict-mapper fell back to raw_constraint metadata",
      raw_constraint: entry
    });
    mapped.push({
      key: "raw_constraint",
      type: "add-metadata",
      value: entry
    });
  }
  return mapped;
}

function extractReplacement(
  metadata: Record<string, unknown> | undefined,
  options: MapVerdictOptions
): OpenBoxReplacement | undefined {
  if (!metadata) {
    return undefined;
  }
  const candidate = metadata["replacement_content"];
  if (candidate === undefined || candidate === null) {
    return undefined;
  }

  const parsed = OpenBoxReplacementSchema.safeParse(candidate);
  if (parsed.success) {
    return parsed.data as OpenBoxReplacement;
  }

  options.logger?.warn?.({
    issues: parsed.error.issues,
    note: "openbox verdict-mapper dropped malformed replacement_content"
  });
  return undefined;
}

function readStringFromMetadata(
  metadata: Record<string, unknown> | undefined,
  key: string
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
