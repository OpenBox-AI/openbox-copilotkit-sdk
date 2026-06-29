import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { idempotencyKey } from "../../../src/audit/idempotency-key.js";

describe("idempotencyKey", () => {
  it("is stable across repeated calls with the same input", () => {
    const a = idempotencyKey({
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    });
    const b = idempotencyKey({
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(a).toBe(b);
  });

  it("differs across attempt numbers", () => {
    const a = idempotencyKey({
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    });
    const b = idempotencyKey({
      activityId: "act-1",
      attempt: 1,
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(a).not.toBe(b);
  });

  it("returns lower-case hex sha256", () => {
    const key = idempotencyKey({
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("matches the cross-impl formula sha256(wf:run:act:attempt)", () => {
    // Golden parity test: this hash MUST match what mastra-sdk and Core's
    // `setApprovalCache` produce for the same inputs (parity by convention,
    // not shared code). When this fails, fix the formula here AND notify the
    // other SDK maintainers via CHANGELOG cross-link.
    const expected = createHash("sha256")
      .update("wf-1:run-1:act-1:0")
      .digest("hex");
    const actual = idempotencyKey({
      activityId: "act-1",
      attempt: 0,
      runId: "run-1",
      workflowId: "wf-1"
    });
    expect(actual).toBe(expected);
  });
});
