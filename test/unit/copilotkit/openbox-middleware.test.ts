import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it, vi } from "vitest";

import { GovernanceVerdictResponse } from "../../../src/types/governance-verdict-response.js";
import { WorkflowEventType } from "../../../src/types/workflow-event-type.js";
import { GOVERNANCE_BLOCKED_ERROR_CODE } from "../../../src/copilotkit/governance-blocked-error.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

const scriptedTextEvents: BaseEvent[] = [
  {
    messageId: "msg-out-1",
    role: "assistant",
    type: EventType.TEXT_MESSAGE_START
  } as BaseEvent,
  {
    delta: "Hello",
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_CONTENT
  } as BaseEvent,
  {
    delta: " world",
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_CONTENT
  } as BaseEvent,
  {
    messageId: "msg-out-1",
    type: EventType.TEXT_MESSAGE_END
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

const scriptedToolCallEvents: BaseEvent[] = [
  {
    toolCallId: "call-1",
    toolCallName: "setThemeColor",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    delta: '{"color":"blue"}',
    toolCallId: "call-1",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  { toolCallId: "call-1", type: EventType.TOOL_CALL_END } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

const scriptedToolCallEventsWithResult: BaseEvent[] = [
  {
    toolCallId: "call-1",
    toolCallName: "setThemeColor",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    delta: '{"color":"blue"}',
    toolCallId: "call-1",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  { toolCallId: "call-1", type: EventType.TOOL_CALL_END } as BaseEvent,
  {
    content: '{"ok":true}',
    toolCallId: "call-1",
    type: "TOOL_CALL_RESULT"
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

describe("OpenBoxMiddleware.run", () => {
  it("emits WorkflowStarted, user_input signal, agent_output signal, and WorkflowCompleted for a text-only run", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedTextEvents });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), agent)
    );

    const calls = evaluateMock.mock.calls.map(
      args => args[0] as Record<string, unknown>
    );

    expect(calls.map(c => c.event_type)).toEqual([
      WorkflowEventType.WORKFLOW_STARTED,
      WorkflowEventType.SIGNAL_RECEIVED,
      WorkflowEventType.SIGNAL_RECEIVED,
      WorkflowEventType.WORKFLOW_COMPLETED
    ]);
    for (const call of calls) {
      expect(call.workflow_type).toBe("copilotkit");
      expect(call.task_queue).toBe("copilotkit");
      expect(call.source).toBe("copilotkit-middleware");
      expect(call.workflow_id).toBe("thread-1");
      expect(call.run_id).toBe("run-1");
    }

    expect(events.map(e => e.type)).toEqual([
      EventType.RUN_STARTED,
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.RUN_FINISHED
    ]);

    const completed = calls[3]!;
    expect(completed.workflow_output).toBe("Hello world");
  });

  it("emits ActivityStarted and ActivityCompleted around TOOL_CALL_START/END", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedToolCallEvents });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const types = evaluateMock.mock.calls.map(
      args => (args[0] as Record<string, unknown>).event_type
    );
    expect(types).toContain(WorkflowEventType.ACTIVITY_STARTED);
    expect(types).toContain(WorkflowEventType.ACTIVITY_COMPLETED);

    const startedCall = evaluateMock.mock.calls.find(
      args =>
        (args[0] as Record<string, unknown>).event_type ===
        WorkflowEventType.ACTIVITY_STARTED
    )?.[0] as Record<string, unknown>;
    const completedCall = evaluateMock.mock.calls.find(
      args =>
        (args[0] as Record<string, unknown>).event_type ===
        WorkflowEventType.ACTIVITY_COMPLETED
    )?.[0] as Record<string, unknown>;

    expect(startedCall.activity_id).toBe("call-1");
    expect(startedCall.activity_type).toBe("setThemeColor");
    expect(startedCall.activity_input).toEqual({ color: "blue" });
    expect(startedCall.tool_origin).toBe("copilotkit-observed");
    expect(startedCall.frontend).toBe(false);

    expect(completedCall.activity_id).toBe("call-1");
    expect(completedCall.activity_input).toEqual({ color: "blue" });
    expect(completedCall.status).toBe("completed");
    expect(typeof completedCall.duration_ms).toBe("number");
  });

  it("emits ActivityCompleted activity_output from TOOL_CALL_RESULT", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedToolCallEventsWithResult });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const calls = evaluateMock.mock.calls.map(
      args => args[0] as Record<string, unknown>
    );
    const startedCall = calls.find(
      payload => payload.event_type === WorkflowEventType.ACTIVITY_STARTED
    );
    const completedCall = calls.find(
      payload => payload.event_type === WorkflowEventType.ACTIVITY_COMPLETED
    );

    expect(startedCall?.activity_input).toEqual({ color: "blue" });
    expect(completedCall?.activity_input).toEqual({ color: "blue" });
    expect(completedCall?.activity_output).toEqual({ ok: true });
  });

  it("emits WorkflowFailed on RUN_ERROR", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({
      events: [
        {
          code: "boom",
          message: "explosion",
          type: EventType.RUN_ERROR
        } as BaseEvent
      ]
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const failed = evaluateMock.mock.calls.find(
      args =>
        (args[0] as Record<string, unknown>).event_type ===
        WorkflowEventType.WORKFLOW_FAILED
    )?.[0] as Record<string, unknown>;
    expect(failed).toBeDefined();
    expect(failed.error).toMatchObject({ code: "boom", message: "explosion" });
  });

  it("does NOT inject error envelope when enforceApprovals is false even on block verdict", async () => {
    const blockingVerdict = GovernanceVerdictResponse.fromObject({
      governance_event_id: "evt-block-1",
      verdict: "block"
    });
    const evaluateMock = vi.fn().mockResolvedValue(blockingVerdict);
    const { controller } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedToolCallEvents });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), agent)
    );

    expect(
      events.find(
        e =>
          e.type === EventType.RUN_ERROR &&
          (e as { code?: string }).code === GOVERNANCE_BLOCKED_ERROR_CODE
      )
    ).toBeUndefined();
  });

  it("injects a redacted governance_blocked RUN_ERROR when enforceApprovals: true and verdict is block", async () => {
    const blockingVerdict = GovernanceVerdictResponse.fromObject({
      governance_event_id: "evt-block-42",
      reason: "tool denied for tenant acme",
      verdict: "block"
    });
    const evaluateMock = vi.fn().mockResolvedValue(blockingVerdict);
    const { controller } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller, {
      enforceApprovals: true
    });
    const agent = new ScriptedAgent({ events: scriptedToolCallEvents });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), agent)
    );

    const errorEvents = events.filter(
      e =>
        e.type === EventType.RUN_ERROR &&
        (e as { code?: string }).code === GOVERNANCE_BLOCKED_ERROR_CODE
    );
    expect(errorEvents).toHaveLength(1);
    const err = errorEvents[0] as {
      code: string;
      correlationId: string;
      type: string;
    };
    expect(err.code).toBe(GOVERNANCE_BLOCKED_ERROR_CODE);
    expect(err.correlationId).toBe("evt-block-42");
    const serialized = JSON.stringify(err);
    expect(serialized).not.toContain("setThemeColor");
    expect(serialized).not.toContain("acme");
    expect(serialized).not.toContain("denied");
  });

  it("continues the stream when client.evaluate throws (fail-open)", async () => {
    const evaluateMock = vi.fn().mockRejectedValue(new Error("network down"));
    const { controller, logger } = buildController({ evaluateMock });
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedTextEvents });

    const events = await collectEvents(
      middleware.run(buildRunAgentInput(), agent)
    );

    expect(events.length).toBeGreaterThan(0);
    expect(logger.warn).toHaveBeenCalled();
  });

  it("isolates per-run state across 50 concurrent runs", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);

    const promises = Array.from({ length: 50 }, (_, i) => {
      const agent = new ScriptedAgent({
        events: [
          {
            messageId: `msg-${i}`,
            role: "assistant",
            type: EventType.TEXT_MESSAGE_START
          } as BaseEvent,
          {
            delta: `output-${i}`,
            messageId: `msg-${i}`,
            type: EventType.TEXT_MESSAGE_CONTENT
          } as BaseEvent,
          {
            messageId: `msg-${i}`,
            type: EventType.TEXT_MESSAGE_END
          } as BaseEvent,
          { type: EventType.RUN_FINISHED } as BaseEvent
        ]
      });
      const input = buildRunAgentInput({
        runId: `run-${i}`,
        threadId: `thread-${i}`
      });
      return collectEvents(middleware.run(input, agent));
    });

    await Promise.all(promises);

    const completedCalls = evaluateMock.mock.calls
      .map(args => args[0] as Record<string, unknown>)
      .filter(c => c.event_type === WorkflowEventType.WORKFLOW_COMPLETED);

    expect(completedCalls).toHaveLength(50);
    for (const call of completedCalls) {
      const workflowId = call.workflow_id as string;
      const output = call.workflow_output as string;
      const expected = `output-${workflowId.split("-")[1]!}`;
      expect(output).toBe(expected);
    }
  });

  it("emits WorkflowFailed when the upstream observable errors", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({
      events: [],
      runError: new Error("stream broke")
    });

    await expect(
      collectEvents(middleware.run(buildRunAgentInput(), agent))
    ).rejects.toThrow("stream broke");

    const failed = evaluateMock.mock.calls.find(
      args =>
        (args[0] as Record<string, unknown>).event_type ===
        WorkflowEventType.WORKFLOW_FAILED
    );
    expect(failed).toBeDefined();
  });
});
