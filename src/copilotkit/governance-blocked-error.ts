/**
 * Wire-format error envelope emitted into the AG-UI observable when a tool
 * call is denied under `enforceApprovals: true`. The envelope is intentionally
 * fixed-shape so it CANNOT carry tool name, tenant id, agent id, or verdict
 * reason to the client. The full reason resolves only via OpenBox UI by
 * `correlationId`.
 *
 * This module is the single constructor for the wire envelope — every
 * enforcement path MUST go through `createGovernanceBlockedErrorEvent`. The
 * redaction test (`governance-blocked-redaction.test.ts`) asserts byte-for-byte
 * payload equality, so adding fields here is a public-surface change.
 */

import type { BaseEvent } from "@ag-ui/client";
import { EventType } from "@ag-ui/client";

export const GOVERNANCE_BLOCKED_ERROR_CODE = "governance_blocked";

export interface GovernanceBlockedErrorEvent extends BaseEvent {
  code: typeof GOVERNANCE_BLOCKED_ERROR_CODE;
  correlationId: string;
}

/**
 * Construct the redacted error event. `correlationId` is the only carried
 * field beyond the AG-UI `type`/`code` discriminators. The caller MUST source
 * `correlationId` from the governance verdict (e.g. `governanceEventId`) so
 * the OpenBox UI can resolve it back to the unredacted record.
 */
export function createGovernanceBlockedErrorEvent(
  correlationId: string
): GovernanceBlockedErrorEvent {
  return {
    code: GOVERNANCE_BLOCKED_ERROR_CODE,
    correlationId,
    type: EventType.RUN_ERROR
  };
}
