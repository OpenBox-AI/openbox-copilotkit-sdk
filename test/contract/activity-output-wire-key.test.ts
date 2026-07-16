import { describe, expect, it } from "vitest";

import { OpenBoxCopilotKitEmitter } from "../../src/copilotkit/openbox-emitter.js";
import { WorkflowEventType } from "../../src/types/workflow-event-type.js";

import { buildController } from "../unit/copilotkit/test-utils.js";

/**
 * FREEZE (Phase 1 / Decision D6 / Prerequisite P0a).
 *
 * Core reads a completed activity's output under the wire key `activity_output`
 * (openbox-core `governance.go` `ActivityOutput json:"activity_output"`;
 * `docs/sdk-integration-guide.md`). The CURRENT hand-assembled adapter emitter
 * emits it correctly (`openbox-emitter.ts` `emitActivityCompleted`), symmetric
 * with `activity_input`. This is a *correctness asset* (RT-F15d): the base SDK
 * `1.0.0` `activityCompleted()` factory emits it under `result` instead, which
 * Core silently drops — fixed only in base `1.0.1` (P0a).
 *
 * This test is the regression guard Phase 3 must keep green when it stops
 * hand-assembling the payload and delegates to the base `1.0.1` factory.
 */
describe("wire contract: ActivityCompleted output key (activity_output, not result)", () => {
  it("emitActivityCompleted writes tool output under `activity_output` and never `result`", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitActivityCompleted({
      activityId: "call-1",
      activityOutput: { amount: 42, charged: true },
      runId: "run-1",
      status: "completed",
      toolName: "chargeCard",
      workflowId: "thread-1"
    });

    expect(evaluateMock).toHaveBeenCalledTimes(1);
    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;

    // Core-required key present and carrying the output verbatim.
    expect(payload).toHaveProperty("activity_output");
    expect(payload["activity_output"]).toEqual({ amount: 42, charged: true });

    // The base-1.0.0 defect key MUST NOT appear on the adapter's wire payload.
    expect(payload).not.toHaveProperty("result");

    // Symmetry with the started side (which already emits activity_input).
    expect(payload).toHaveProperty("activity_input");
    expect(payload["event_type"]).toBe(WorkflowEventType.ACTIVITY_COMPLETED);
  });

  it("serializes a structured output value (structuredClone path) unchanged on the wire", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    const output = { nested: { items: [1, 2, 3] }, ok: true };
    await emitter.emitActivityCompleted({
      activityId: "call-2",
      activityOutput: output,
      runId: "run-1",
      status: "completed",
      toolName: "lookup",
      workflowId: "thread-1"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload["activity_output"]).toEqual(output);
    expect(payload["activity_output"]).not.toBe(output); // cloned, not aliased
  });
});
