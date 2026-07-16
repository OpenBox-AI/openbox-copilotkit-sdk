import { describe, expect, it } from "vitest";

import {
  buildActivityCompletedEnvelope,
  buildActivityStartedEnvelope,
  buildInterruptSignalEnvelope,
  buildSignalReceivedEnvelope,
  buildWorkflowCompletedEnvelope,
  buildWorkflowFailedEnvelope,
  buildWorkflowStartedEnvelope,
  toErrorInfo
} from "../../../src/copilotkit/lifecycle-events.js";

describe("lifecycle-events builders — WorkflowStarted", () => {
  it("carries every optional field through `extra` and the multi-agent fields natively", () => {
    const envelope = buildWorkflowStartedEnvelope({
      agentId: "agent-1",
      goal: "help the user",
      metadata: { tenant: "acme" },
      multiAgentSessionId: "mas:run-1",
      parentWorkflowId: "parent-wf",
      runId: "run-1",
      threadId: "thread-1",
      userInput: { content: "hi", role: "user" },
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.source).toBe("copilotkit-middleware");
    expect(payload.event_type).toBe("WorkflowStarted");
    expect(payload.workflow_id).toBe("thread-1");
    expect(payload.run_id).toBe("run-1");
    expect(payload.workflow_type).toBe("copilotkit");
    expect(payload.task_queue).toBe("copilotkit");
    expect(payload.multi_agent_session_id).toBe("mas:run-1");
    expect(payload.parent_workflow_id).toBe("parent-wf");
    expect(payload.thread_id).toBe("thread-1");
    expect(payload.agent_id).toBe("agent-1");
    expect(payload.goal).toBe("help the user");
    expect(payload.metadata).toEqual({ tenant: "acme" });
    expect(payload.workflow_input).toEqual({ content: "hi", role: "user" });
  });

  it("omits every optional key and stamps workflow_input: null when userInput is absent", () => {
    const envelope = buildWorkflowStartedEnvelope({
      runId: "run-2",
      threadId: "thread-2",
      workflowId: "thread-2"
    });

    const payload = envelope.toPayloadDict();
    expect(payload).not.toHaveProperty("agent_id");
    expect(payload).not.toHaveProperty("goal");
    expect(payload).not.toHaveProperty("metadata");
    expect(payload).not.toHaveProperty("multi_agent_session_id");
    expect(payload).not.toHaveProperty("parent_workflow_id");
    expect(payload.workflow_input).toBeNull();
  });
});

describe("lifecycle-events builders — SignalReceived", () => {
  it("wraps payload in { value } when standalone (no multiAgentSessionId)", () => {
    const envelope = buildSignalReceivedEnvelope({
      payload: "hello",
      runId: "run-1",
      signalName: "user_input",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().signal_args).toEqual({ value: "hello" });
  });

  it("array-wraps payload when multiAgentSessionId is set", () => {
    const envelope = buildSignalReceivedEnvelope({
      multiAgentSessionId: "mas:run-1",
      payload: "hello",
      runId: "run-1",
      signalName: "user_input",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().signal_args).toEqual(["hello"]);
  });

  it("nulls the signal_args value when payload is undefined", () => {
    const envelope = buildSignalReceivedEnvelope({
      payload: undefined,
      runId: "run-1",
      signalName: "agent_output",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().signal_args).toEqual({ value: null });
  });
});

describe("lifecycle-events builders — copilotkit_interrupt (fixes B3)", () => {
  it("carries every interrupt array as its own named extra field (not nested under signal_args)", () => {
    const envelope = buildInterruptSignalEnvelope({
      interruptIds: ["call-approve-1"],
      messages: ["Approve deleteAccount for u1?"],
      reasons: ["approval_required"],
      responseSchemas: [{ type: "object" }],
      runId: "run-1",
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.signal_name).toBe("copilotkit_interrupt");
    expect(payload.interrupt_ids).toEqual(["call-approve-1"]);
    expect(payload.reasons).toEqual(["approval_required"]);
    expect(payload.messages).toEqual(["Approve deleteAccount for u1?"]);
    expect(payload.response_schemas).toEqual([{ type: "object" }]);
    expect(payload).not.toHaveProperty("signal_args");
  });

  it("supports multiple parallel interrupts and null-safes a missing message/schema", () => {
    const envelope = buildInterruptSignalEnvelope({
      interruptIds: ["int-1", "int-2"],
      messages: [undefined, "second reason's message"],
      reasons: ["approval_required", "manual_review"],
      responseSchemas: [undefined, { type: "string" }],
      runId: "run-1",
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.interrupt_ids).toEqual(["int-1", "int-2"]);
    expect(payload.messages).toEqual([null, "second reason's message"]);
    expect(payload.response_schemas).toEqual([null, { type: "string" }]);
  });

  it("array-wraps under multiAgentSessionId like the other builders (base-native field)", () => {
    const envelope = buildInterruptSignalEnvelope({
      interruptIds: ["int-1"],
      messages: [undefined],
      multiAgentSessionId: "mas:run-1",
      reasons: ["approval_required"],
      responseSchemas: [undefined],
      runId: "run-1",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().multi_agent_session_id).toBe("mas:run-1");
  });
});

describe("lifecycle-events builders — ActivityStarted", () => {
  it("keeps frontend: false (a falsy-but-required boolean is never dropped)", () => {
    const envelope = buildActivityStartedEnvelope({
      activityArgs: { color: "blue" },
      activityId: "call-1",
      frontend: false,
      runId: "run-1",
      toolName: "setThemeColor",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.frontend).toBe(false);
    expect(payload.tool_origin).toBe("copilotkit-observed");
    expect(payload.activity_id).toBe("call-1");
    expect(payload.activity_type).toBe("setThemeColor");
    expect(payload.activity_input).toEqual({ color: "blue" });
  });

  it("omits activity_input entirely when activityArgs is absent (base-native omission)", () => {
    const envelope = buildActivityStartedEnvelope({
      activityId: "call-2",
      frontend: true,
      runId: "run-1",
      toolName: "noArgsTool",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict()).not.toHaveProperty("activity_input");
  });

  it("clones activityArgs rather than aliasing the input object", () => {
    const args = { nested: { color: "blue" } };
    const envelope = buildActivityStartedEnvelope({
      activityArgs: args,
      activityId: "call-3",
      frontend: false,
      runId: "run-1",
      toolName: "setThemeColor",
      toolOrigin: "copilotkit-observed",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().activity_input).toEqual(args);
    expect(envelope.toPayloadDict().activity_input).not.toBe(args);
  });
});

describe("lifecycle-events builders — ActivityCompleted", () => {
  it("wires activity_output (never result) and keeps activity_input in extra as null when absent", () => {
    const envelope = buildActivityCompletedEnvelope({
      activityId: "call-1",
      activityOutput: { ok: true },
      durationMs: 0,
      endTime: 2000,
      runId: "run-1",
      startTime: 1000,
      status: "completed",
      toolName: "setThemeColor",
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.activity_output).toEqual({ ok: true });
    expect(payload).not.toHaveProperty("result");
    expect(payload.activity_input).toBeNull();
    expect(payload.status).toBe("completed");
    // duration_ms: 0 is a legitimate value, not "unset" — must survive the
    // `typeof === "number"` guard rather than a truthy check.
    expect(payload.duration_ms).toBe(0);
    expect(payload.start_time).toBe(1000);
    expect(payload.end_time).toBe(2000);
  });

  it("omits activity_output entirely when activityOutput is absent (base-native omission)", () => {
    const envelope = buildActivityCompletedEnvelope({
      activityId: "call-2",
      runId: "run-1",
      status: "completed",
      toolName: "setThemeColor",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict()).not.toHaveProperty("activity_output");
  });

  it("converts a provided error to base ErrorInfo", () => {
    const envelope = buildActivityCompletedEnvelope({
      activityId: "call-3",
      error: { message: "boom", name: "ToolError" },
      runId: "run-1",
      status: "failed",
      toolName: "flakyTool",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().error).toEqual({
      message: "boom",
      name: "ToolError",
      type: "ToolError"
    });
  });
});

describe("lifecycle-events builders — WorkflowCompleted", () => {
  it("nulls workflow_output when agentOutput is absent and omits parent_workflow_id when unset", () => {
    const envelope = buildWorkflowCompletedEnvelope({
      runId: "run-1",
      workflowId: "thread-1"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.workflow_output).toBeNull();
    expect(payload).not.toHaveProperty("parent_workflow_id");
  });

  it("stamps parent_workflow_id when a child-workflow link is provided", () => {
    const envelope = buildWorkflowCompletedEnvelope({
      agentOutput: "done",
      multiAgentSessionId: "mas:run-1",
      parentWorkflowId: "parent-wf",
      runId: "run-1",
      workflowId: "child-wf"
    });

    const payload = envelope.toPayloadDict();
    expect(payload.workflow_output).toBe("done");
    expect(payload.parent_workflow_id).toBe("parent-wf");
    expect(payload.multi_agent_session_id).toBe("mas:run-1");
  });
});

describe("lifecycle-events builders — WorkflowFailed", () => {
  it("always converts the required error field to base ErrorInfo", () => {
    const envelope = buildWorkflowFailedEnvelope({
      error: { code: "boom", message: "explosion" },
      runId: "run-1",
      workflowId: "thread-1"
    });

    expect(envelope.toPayloadDict().error).toEqual({
      code: "boom",
      message: "explosion",
      type: "boom"
    });
  });
});

describe("toErrorInfo", () => {
  it("prefers an explicit type over name/code", () => {
    expect(
      toErrorInfo({ code: "C", message: "m", name: "N", type: "T" })
    ).toMatchObject({ message: "m", type: "T" });
  });

  it("falls back to Error#name when type is absent", () => {
    expect(toErrorInfo({ message: "m", name: "ToolError" })).toMatchObject({
      message: "m",
      type: "ToolError"
    });
  });

  it("falls back to a string code when neither type nor name is present", () => {
    expect(toErrorInfo({ code: "boom", message: "m" })).toMatchObject({
      message: "m",
      type: "boom"
    });
  });

  it("falls back to generic type/message when nothing usable is present", () => {
    expect(toErrorInfo({})).toEqual({ message: "Unknown error", type: "Error" });
  });

  it("treats an empty-string type/name/code as absent", () => {
    expect(
      toErrorInfo({ code: "", message: "m", name: "", type: "" })
    ).toMatchObject({ message: "m", type: "Error" });
  });

  it("ignores a non-string code", () => {
    expect(toErrorInfo({ code: 500, message: "m" })).toMatchObject({
      message: "m",
      type: "Error"
    });
  });
});
