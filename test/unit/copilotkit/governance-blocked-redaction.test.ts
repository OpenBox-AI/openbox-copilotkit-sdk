import { EventType } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import {
  GOVERNANCE_BLOCKED_ERROR_CODE,
  createGovernanceBlockedErrorEvent
} from "../../../src/copilotkit/governance-blocked-error.js";

describe("createGovernanceBlockedErrorEvent", () => {
  it("returns a byte-for-byte fixed envelope with only type, code, correlationId", () => {
    const event = createGovernanceBlockedErrorEvent("corr-123");

    expect(Object.keys(event).sort()).toEqual(
      ["code", "correlationId", "type"].sort()
    );
    expect(event.type).toBe(EventType.RUN_ERROR);
    expect(event.code).toBe(GOVERNANCE_BLOCKED_ERROR_CODE);
    expect(event.correlationId).toBe("corr-123");
  });

  it("does not leak tool name, tenant id, or verdict reason when fed into the wire shape", () => {
    const event = createGovernanceBlockedErrorEvent("corr-secret-456");
    const serialized = JSON.stringify(event);

    expect(serialized).not.toContain("internal_admin_set_role");
    expect(serialized).not.toContain("acme-corp");
    expect(serialized).not.toContain("denied by policy");
    expect(serialized).not.toContain("toolName");
    expect(serialized).not.toContain("tenantId");
    expect(serialized).not.toContain("reason");
  });

  it("returns distinct objects per call so callers cannot mutate a shared singleton", () => {
    const a = createGovernanceBlockedErrorEvent("corr-A");
    const b = createGovernanceBlockedErrorEvent("corr-B");

    expect(a).not.toBe(b);
    (a as { correlationId: string }).correlationId = "mutated";
    expect(b.correlationId).toBe("corr-B");
  });
});
