import { describe, expect, it } from "vitest";

import {
  attachAuditEnvelope,
  ENFORCEMENT_OWNER
} from "../../../src/audit/audit-envelope.js";
import { idempotencyKey } from "../../../src/audit/idempotency-key.js";
import type { SpanData } from "../../../src/spans/span-data.js";

function blankSpan(): SpanData {
  return {
    attributes: {},
    end_time_unix_nano: 100n,
    name: "tool:setTheme",
    span_id: "span-1",
    start_time_unix_nano: 1n,
    status: "ok",
    trace_id: "trace-1"
  };
}

describe("attachAuditEnvelope", () => {
  it("stamps the locked attribute set on the span", () => {
    const span = attachAuditEnvelope(blankSpan(), {
      activityId: "act-1",
      attempt: 0,
      enforcementStatus: "pre_execution_allowed",
      gateway: "agui_event",
      runId: "run-1",
      workflowId: "wf-1"
    });

    expect(span.attributes["openbox.enforcement_owner"]).toBe(ENFORCEMENT_OWNER);
    expect(span.attributes["openbox.gateway"]).toBe("agui_event");
    expect(span.attributes["openbox.enforcement_status"]).toBe(
      "pre_execution_allowed"
    );
    expect(span.attributes["openbox.idempotency_key"]).toBe(
      idempotencyKey({
        activityId: "act-1",
        attempt: 0,
        runId: "run-1",
        workflowId: "wf-1"
      })
    );
    expect(span.attributes["openbox.policy_version"]).toBeUndefined();
    expect(span.attributes["openbox.trace_id"]).toBeUndefined();
  });

  it("adds optional policy_version and trace_id when provided", () => {
    const span = attachAuditEnvelope(blankSpan(), {
      activityId: "act-1",
      attempt: 1,
      enforcementStatus: "pre_execution_blocked",
      gateway: "server_tool",
      policyVersion: "policy-v2",
      runId: "run-1",
      traceId: "trace-xyz",
      workflowId: "wf-1"
    });
    expect(span.attributes["openbox.policy_version"]).toBe("policy-v2");
    expect(span.attributes["openbox.trace_id"]).toBe("trace-xyz");
  });

  it("accepts a custom enforcement_owner override", () => {
    const span = attachAuditEnvelope(blankSpan(), {
      activityId: "act-1",
      attempt: 0,
      enforcementOwner: "custom-owner",
      enforcementStatus: "late_detection",
      gateway: "frontend",
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(span.attributes["openbox.enforcement_owner"]).toBe("custom-owner");
  });

  it("produces distinct idempotency keys for distinct attempts", () => {
    const a = attachAuditEnvelope(blankSpan(), {
      activityId: "act-1",
      attempt: 0,
      enforcementStatus: "pre_execution_allowed",
      gateway: "agui_event",
      runId: "run-1",
      workflowId: "wf-1"
    });
    const b = attachAuditEnvelope(blankSpan(), {
      activityId: "act-1",
      attempt: 1,
      enforcementStatus: "pre_execution_allowed",
      gateway: "agui_event",
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(a.attributes["openbox.idempotency_key"]).not.toBe(
      b.attributes["openbox.idempotency_key"]
    );
  });
});
