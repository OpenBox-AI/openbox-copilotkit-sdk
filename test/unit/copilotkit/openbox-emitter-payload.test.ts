import { describe, expect, it, vi } from "vitest";

import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";

import { OpenBoxCopilotKitEmitter } from "../../../src/copilotkit/openbox-emitter.js";
import { WorkflowEventType } from "../../../src/types/workflow-event-type.js";

import { buildController, flushMacrotask } from "./test-utils.js";

// Phase 3b (B4 fix): the six lifecycle/signal methods below are pure
// telemetry — they enqueue on the bounded, non-blocking queue and return
// before the send reaches `client.evaluate`. `flushMacrotask()` lets that
// background send settle before a test inspects `evaluateMock`; every
// PAYLOAD-SHAPE assertion (the actual thing these tests guard) is unchanged.
// `emitActivityCompletedHook` is unaffected (still a direct, unmigrated
// path — see openbox-emitter.ts) and needs no flush. `emitHandoff` (Phase 5)
// is also direct/unqueued, but its WIRE send is now the base `handoff()`
// factory's two-field envelope — see the dedicated tests below.

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
    await flushMacrotask();

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
    await flushMacrotask();

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
      activityArgs: { color: "blue" },
      activityId: "call-77",
      frontend: true,
      runId: "run-C",
      toolName: "setThemeColor",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-C"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.ACTIVITY_STARTED);
    expect(payload.activity_id).toBe("call-77");
    expect(payload.activity_input).toEqual({ color: "blue" });
    expect(payload.activity_type).toBe("setThemeColor");
    expect(payload.tool_origin).toBe("copilotkit-observed");
    expect(payload.frontend).toBe(true);
  });

  it("prepareActivityStartedForEnforcement builds the envelope + notifies onEvent WITHOUT calling evaluate (Phase 4b)", () => {
    const onEvent = vi.fn();
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, onEvent);

    const envelope = emitter.prepareActivityStartedForEnforcement({
      activityArgs: { amount: 100 },
      activityId: "call-enforce-1",
      frontend: true,
      runId: "run-G",
      toolName: "sendPayment",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-G"
    });

    // Never sends/evaluates itself — the caller hands the returned envelope
    // to `OpenBoxRuntime.evaluateLifecycle()`, the ONE place it reaches Core.
    expect(evaluateMock).not.toHaveBeenCalled();

    // The RAW envelope carries the ids `evaluateLifecycle`'s approval-poll
    // correlation and HALT-scoping both read (`activityId` top-level,
    // `workflow_id`/`run_id` in the flat payload).
    expect(envelope.activityId).toBe("call-enforce-1");
    expect(envelope.payload.workflow_id).toBe("thread-G");
    expect(envelope.payload.run_id).toBe("run-G");
    expect(envelope.payload.activity_input).toEqual({ amount: 100 });

    // `onEvent` still fires synchronously with the PREPARED (wire-shaped)
    // payload, for observability — same shape the other lifecycle methods use.
    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]?.[0] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(arg.eventType).toBe(WorkflowEventType.ACTIVITY_STARTED);
    expect(arg.payload.activity_id).toBe("call-enforce-1");
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
    await flushMacrotask();

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
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.WORKFLOW_COMPLETED);
    expect(payload.workflow_output).toBe("the answer is 42");
  });

  it("emitWorkflowFailed carries the error record, converted to base ErrorInfo", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowFailed({
      error: { code: "boom", message: "explosion" },
      runId: "run-E",
      workflowId: "thread-E"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    assertCanonicalEnvelope(payload);
    expect(payload.event_type).toBe(WorkflowEventType.WORKFLOW_FAILED);
    // Base ErrorInfo requires `type` (never a bare string) — `code` has no
    // dedicated ErrorInfo slot, so it falls back to `type` and is ALSO kept
    // verbatim (existing readers of `error.code` keep working).
    expect(payload.error).toEqual({
      code: "boom",
      message: "explosion",
      type: "boom"
    });
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
    await flushMacrotask();

    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe("OpenBoxCopilotKitEmitter multi-agent fields", () => {
  it("serializes WorkflowEventType.HANDOFF as 'Handoff'", () => {
    expect(WorkflowEventType.HANDOFF).toBe("Handoff");
  });

  it("emits array-shaped signal_args when multiAgentSessionId is set", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitSignalReceived({
      multiAgentSessionId: "mas:run-X",
      payload: "what is the weather in tokyo?",
      runId: "run-X",
      signalName: "user_input",
      workflowId: "thread-X"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.signal_args).toEqual(["what is the weather in tokyo?"]);
  });

  it("keeps { value } signal_args when multiAgentSessionId is absent", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitSignalReceived({
      payload: "hello",
      runId: "run-X",
      signalName: "user_input",
      workflowId: "thread-X"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.signal_args).toEqual({ value: "hello" });
  });

  it("stamps multi_agent_session_id on WorkflowStarted when provided", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowStarted({
      multiAgentSessionId: "mas:run-X",
      runId: "run-X",
      threadId: "thread-X",
      workflowId: "thread-X"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.multi_agent_session_id).toBe("mas:run-X");
  });

  it("omits multi_agent_session_id and parent_workflow_id when not provided", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowStarted({
      runId: "run-X",
      threadId: "thread-X",
      workflowId: "thread-X"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("multi_agent_session_id");
    expect(payload).not.toHaveProperty("parent_workflow_id");
  });

  it("stamps parent_workflow_id on WorkflowCompleted (child workflow semantics)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);

    await emitter.emitWorkflowCompleted({
      multiAgentSessionId: "mas:run-X",
      parentWorkflowId: "parent-wf",
      runId: "run-X",
      workflowId: "child-wf"
    });
    await flushMacrotask();

    const payload = evaluateMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.multi_agent_session_id).toBe("mas:run-X");
    expect(payload.parent_workflow_id).toBe("parent-wf");
  });

  it("emitHandoff sends the child-scoped client ONLY the base two-field envelope (D1)", async () => {
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, undefined);
    const childEvaluate = vi.fn().mockResolvedValue(null);
    const childClient = { evaluate: childEvaluate } as unknown as OpenBoxClient;

    await emitter.emitHandoff(
      {
        fromAgentDid: "did:aip:parent",
        metadata: { delegate_tool_name: "weatherTool" },
        multiAgentSessionId: "mas:run-X",
        runId: "run-X",
        workflowId: "thread-X"
      },
      childClient
    );

    // Authenticated as the child — NOT the parent controller client.
    expect(evaluateMock).not.toHaveBeenCalled();
    expect(childEvaluate).toHaveBeenCalledTimes(1);
    const payload = childEvaluate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(payload.event_type).toBe(WorkflowEventType.HANDOFF);
    expect(payload.from_agent_did).toBe("did:aip:parent");
    expect(payload.multi_agent_session_id).toBe("mas:run-X");
    // D1: the base `handoff()` factory carries ONLY the two required fields —
    // the rich adapter metadata this method historically sent no longer
    // rides the WIRE at all (it still reaches `onEvent`, see the next test).
    expect(payload).not.toHaveProperty("workflow_type");
    expect(payload).not.toHaveProperty("task_queue");
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("run_id");
    expect(payload).not.toHaveProperty("workflow_id");
  });

  it("emitHandoff still surfaces the rich adapter metadata via onEvent even when sent to a child", async () => {
    const onEvent = vi.fn();
    const { controller } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, onEvent);
    const childClient = {
      evaluate: vi.fn().mockResolvedValue(null)
    } as unknown as OpenBoxClient;

    await emitter.emitHandoff(
      {
        fromAgentDid: "did:aip:parent",
        metadata: { delegate_tool_name: "weatherTool" },
        multiAgentSessionId: "mas:run-X",
        runId: "run-X",
        workflowId: "thread-X"
      },
      childClient
    );

    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]?.[0] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(arg.eventType).toBe(WorkflowEventType.HANDOFF);
    expect(arg.payload.from_agent_did).toBe("did:aip:parent");
    expect(arg.payload.multi_agent_session_id).toBe("mas:run-X");
    expect(arg.payload.workflow_type).toBe("copilotkit");
    expect(arg.payload.task_queue).toBe("copilotkit");
    expect(
      (arg.payload.metadata as Record<string, unknown>).delegate_tool_name
    ).toBe("weatherTool");
  });

  it("emitHandoff without a client notifies onEvent but does not evaluate (context-export)", async () => {
    const onEvent = vi.fn();
    const { controller, evaluateMock } = buildController();
    const emitter = new OpenBoxCopilotKitEmitter(controller, onEvent);

    const result = await emitter.emitHandoff({
      fromAgentDid: "did:aip:parent",
      multiAgentSessionId: "mas:run-X",
      runId: "run-X",
      workflowId: "thread-X"
    });

    expect(result).toBeNull();
    expect(evaluateMock).not.toHaveBeenCalled();
    expect(onEvent).toHaveBeenCalledTimes(1);
    const arg = onEvent.mock.calls[0]?.[0] as {
      eventType: string;
      payload: Record<string, unknown>;
    };
    expect(arg.eventType).toBe(WorkflowEventType.HANDOFF);
    expect(arg.payload.from_agent_did).toBe("did:aip:parent");
  });
});
