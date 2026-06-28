import { describe, expect, it, vi } from "vitest";

import { OpenBoxCopilotKitEmitter } from "../../../src/copilotkit/openbox-emitter.js";
import { WorkflowEventType } from "../../../src/types/workflow-event-type.js";

import { buildController } from "./test-utils.js";

const FROZEN_REQUIRED_KEYS = [
  "source",
  "task_queue",
  "timestamp",
  "event_type",
  "workflow_id",
  "workflow_type",
  "run_id"
] as const;

function assertCanonicalEnvelope(payload: Record<string, unknown>): void {
  for (const key of FROZEN_REQUIRED_KEYS) {
    expect(payload).toHaveProperty(key);
  }
  expect(payload.source).toBe("copilotkit-middleware");
  expect(payload.task_queue).toBe("copilotkit");
  expect(payload.workflow_type).toBe("copilotkit");
  expect(typeof payload.timestamp).toBe("string");
}

describe("OpenBoxCopilotKitEmitter payload shape", () => {
  it("emitWorkflowStarted produces the canonical envelope + workflow input", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowStarted({
      agentId: "test-agent",
      goal: "complete the task",
      runId: "run-A",
      threadId: "thread-A",
      userInput: { content: "Hi", role: "user" },
      workflowId: "thread-A"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.WORKFLOW_STARTED);
    expect(payload.workflow_id).toBe("thread-A");
    expect(payload.agent_id).toBe("test-agent");
    expect(payload.goal).toBe("complete the task");
    expect(payload.workflow_input).toEqual({ content: "Hi", role: "user" });
  });

  it("emitSignalReceived wraps the payload in signal_args.value", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitSignalReceived({
      payload: "Hello world",
      runId: "run-B",
      signalName: "agent_output",
      workflowId: "thread-B"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.SIGNAL_RECEIVED);
    expect(payload.signal_name).toBe("agent_output");
    expect(payload.signal_args).toEqual({ value: "Hello world" });
  });

  it("emitActivityStarted carries activity_id, activity_type, tool_origin, frontend flag", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitActivityStarted({
      activityId: "call-77",
      frontend: true,
      runId: "run-C",
      toolName: "setThemeColor",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-C"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.ACTIVITY_STARTED);
    expect(payload.activity_id).toBe("call-77");
    expect(payload.activity_type).toBe("setThemeColor");
    expect(payload.tool_origin).toBe("copilotkit-observed");
    expect(payload.frontend).toBe(true);
  });

  it("emitActivityCompleted includes status, duration_ms, start_time, end_time", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitActivityCompleted({
      activityArgs: { color: "blue" },
      activityId: "call-77",
      activityOutput: { ok: true },
      durationMs: 42,
      endTime: 2000,
      runId: "run-C",
      startTime: 1000,
      status: "completed",
      toolName: "setThemeColor",
      workflowId: "thread-C"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.ACTIVITY_COMPLETED);
    expect(payload.status).toBe("completed");
    expect(payload.duration_ms).toBe(42);
    expect(payload.start_time).toBe(1000);
    expect(payload.end_time).toBe(2000);
    expect(payload.activity_input).toEqual({ color: "blue" });
    expect(payload.activity_output).toEqual({ ok: true });
  });

  it("emitWorkflowCompleted carries workflow_output", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowCompleted({
      agentOutput: "the answer is 42",
      runId: "run-D",
      workflowId: "thread-D"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.WORKFLOW_COMPLETED);
    expect(payload.workflow_output).toBe("the answer is 42");
  });

  it("emitWorkflowFailed carries the error record", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowFailed({
      error: { code: "boom", message: "explosion" },
      runId: "run-E",
      workflowId: "thread-E"
    });

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.WORKFLOW_FAILED);
    expect(payload.error).toEqual({ code: "boom", message: "explosion" });
  });

  it("notifies the onEvent observer with eventType and payload", async () => {
    const onEvent = vi.fn();
    const { controller } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, onEvent);

    await emitter.emitWorkflowStarted({
      runId: "run-O",
      threadId: "thread-O",
      workflowId: "thread-O"
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]?.[0] as {
      eventType: string;
      payload: Record<string, unknown>;
      workflowId: string;
    };
    expect(arg.eventType).toBe(WorkflowEventType.WORKFLOW_STARTED);
    expect(arg.workflowId).toBe("thread-O");
    expect(arg.payload.event_type).toBe(WorkflowEventType.WORKFLOW_STARTED);
  });

  it("logger.warn is called and value swallowed when client.evaluate rejects", async () => {
    const evaluateMock = vi.fn().mockRejectedValue(new Error("api down"));
    const { controller, logger } = buildController({ evaluateMock });
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    const result = await emitter.emitWorkflowStarted({
      runId: "run-F",
      threadId: "thread-F",
      workflowId: "thread-F"
    });

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});
