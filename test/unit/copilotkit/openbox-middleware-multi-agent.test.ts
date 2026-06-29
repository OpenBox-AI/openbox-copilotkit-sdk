import { Buffer } from "node:buffer";

import { EventType, type BaseEvent } from "@ag-ui/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenBoxClient } from "../../../src/client/openbox-client.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";
import type { OpenBoxSubagentHandoffConfig } from "../../../src/copilotkit/types.js";
import { WorkflowEventType } from "../../../src/types/workflow-event-type.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

// Valid 32-byte base64 Ed25519 seed + uuid-shaped DIDs. The seed only needs to
// pass the constructor's length/round-trip check — signing is never exercised
// because the child client's evaluate is stubbed via the prototype spy.
const CHILD_SEED = Buffer.alloc(32, 7).toString("base64");
const CHILD_DID = "did:aip:11111111-1111-1111-1111-111111111111";
const PARENT_DID = "did:aip:22222222-2222-2222-2222-222222222222";

const handoffTools: Record<string, OpenBoxSubagentHandoffConfig> = {
  weatherTool: {
    childAgentDid: CHILD_DID,
    childAgentName: "mastra-weather-agent",
    childAgentPrivateKey: CHILD_SEED,
    childApiKey: "child-key",
    childTaskQueue: "mastra",
    childWorkflowType: "weather-agent"
  }
};

function weatherToolEvents(withResult = false): BaseEvent[] {
  const events: BaseEvent[] = [
    {
      toolCallId: "call-w",
      toolCallName: "weatherTool",
      type: EventType.TOOL_CALL_START
    } as BaseEvent,
    {
      delta: '{"city":"tokyo"}',
      toolCallId: "call-w",
      type: EventType.TOOL_CALL_ARGS
    } as BaseEvent,
    { toolCallId: "call-w", type: EventType.TOOL_CALL_END } as BaseEvent
  ];
  if (withResult) {
    events.push({
      content: '{"tempC":18}',
      toolCallId: "call-w",
      type: "TOOL_CALL_RESULT"
    } as BaseEvent);
  }
  events.push({ type: EventType.RUN_FINISHED } as BaseEvent);
  return events;
}

function payloadsOf(mock: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return mock.mock.calls.map(args => args[0] as Record<string, unknown>);
}

describe("OpenBoxMiddleware multi-agent", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not stamp multi_agent_session_id or emit Handoff when disabled (default)", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    for (const call of payloadsOf(evaluateMock)) {
      expect(call).not.toHaveProperty("multi_agent_session_id");
      expect(call.event_type).not.toBe(WorkflowEventType.HANDOFF);
    }
  });

  it("stamps a shared multi_agent_session_id on every parent event when enabled", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: { enabled: true, handoffTools, parentAgentDid: PARENT_DID }
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const calls = payloadsOf(evaluateMock);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.multi_agent_session_id).toBe("mas:run-1");
      // The CopilotKit stream IS the parent — it never carries parent_workflow_id.
      expect(call).not.toHaveProperty("parent_workflow_id");
    }
  });

  it("emits exactly one child-authenticated Handoff for a mapped delegation tool", async () => {
    const childEvaluate = vi
      .spyOn(OpenBoxClient.prototype, "evaluate")
      .mockResolvedValue(null);
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: { enabled: true, handoffTools, parentAgentDid: PARENT_DID }
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    // Parent stream never carries the Handoff (it is sent as the child).
    expect(
      payloadsOf(evaluateMock).filter(
        p => p.event_type === WorkflowEventType.HANDOFF
      )
    ).toHaveLength(0);

    const handoffs = childEvaluate.mock.calls
      .map(args => args[0] as Record<string, unknown>)
      .filter(p => p.event_type === WorkflowEventType.HANDOFF);
    expect(handoffs).toHaveLength(1);

    const handoff = handoffs[0]!;
    expect(handoff.from_agent_did).toBe(PARENT_DID);
    expect(handoff.multi_agent_session_id).toBe("mas:run-1");
    expect(handoff.workflow_type).toBe("copilotkit");
    expect(handoff.task_queue).toBe("copilotkit");

    const meta = handoff.metadata as Record<string, unknown>;
    expect(meta.delegate_tool_name).toBe("weatherTool");
    expect(meta.child_agent_name).toBe("mastra-weather-agent");
    expect(meta.child_workflow_type).toBe("weather-agent");
    expect(meta.child_task_queue).toBe("mastra");
    expect(meta.parent_activity_id).toBe("call-w");

    const ctx = meta.openbox_multi_agent_context as Record<string, unknown>;
    expect(ctx.multiAgentSessionId).toBe("mas:run-1");
    expect(ctx.parentAgentDid).toBe(PARENT_DID);
    expect(ctx.parentActivityId).toBe("call-w");
    expect(ctx.parentWorkflowId).toBe("thread-1");
  });

  it("does not emit a Handoff for an unmapped tool", async () => {
    const childEvaluate = vi
      .spyOn(OpenBoxClient.prototype, "evaluate")
      .mockResolvedValue(null);
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: { enabled: true, handoffTools, parentAgentDid: PARENT_DID }
    });
    const agent = new ScriptedAgent({
      events: [
        {
          toolCallId: "call-x",
          toolCallName: "setThemeColor",
          type: EventType.TOOL_CALL_START
        } as BaseEvent,
        {
          delta: '{"color":"blue"}',
          toolCallId: "call-x",
          type: EventType.TOOL_CALL_ARGS
        } as BaseEvent,
        { toolCallId: "call-x", type: EventType.TOOL_CALL_END } as BaseEvent,
        { type: EventType.RUN_FINISHED } as BaseEvent
      ]
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    expect(childEvaluate).not.toHaveBeenCalled();
    expect(
      payloadsOf(evaluateMock).filter(
        p => p.event_type === WorkflowEventType.HANDOFF
      )
    ).toHaveLength(0);
  });

  it("deduplicates the Handoff across TOOL_CALL_END, RESULT, and run-finished flush", async () => {
    const childEvaluate = vi
      .spyOn(OpenBoxClient.prototype, "evaluate")
      .mockResolvedValue(null);
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: { enabled: true, handoffTools, parentAgentDid: PARENT_DID }
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents(true) });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const handoffs = childEvaluate.mock.calls
      .map(args => args[0] as Record<string, unknown>)
      .filter(p => p.event_type === WorkflowEventType.HANDOFF);
    expect(handoffs).toHaveLength(1);
  });

  it("throws at construction when enabled without a resolvable parent DID", () => {
    const { controller } = buildController();
    expect(() =>
      createOpenBoxMiddleware(controller, { multiAgent: { enabled: true } })
    ).toThrow(/parent agent DID/i);
  });

  it("falls back to context-export (onEvent only) when child credentials are absent", async () => {
    const childEvaluate = vi
      .spyOn(OpenBoxClient.prototype, "evaluate")
      .mockResolvedValue(null);
    const onEvent = vi.fn();
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: {
        enabled: true,
        handoffTools: {
          weatherTool: {
            childAgentName: "mastra-weather-agent",
            childWorkflowType: "weather-agent"
          }
        },
        parentAgentDid: PARENT_DID
      },
      onEvent
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    // No child client was built, so nothing was sent to Core for the handoff.
    expect(childEvaluate).not.toHaveBeenCalled();
    expect(
      payloadsOf(evaluateMock).filter(
        p => p.event_type === WorkflowEventType.HANDOFF
      )
    ).toHaveLength(0);

    // But the prepared context IS surfaced for a remote child to emit.
    const handoffEmissions = onEvent.mock.calls
      .map(args => args[0] as { eventType: string; payload: Record<string, unknown> })
      .filter(e => e.eventType === (WorkflowEventType.HANDOFF as string));
    expect(handoffEmissions).toHaveLength(1);
    const meta = handoffEmissions[0]!.payload.metadata as Record<string, unknown>;
    const ctx = meta.openbox_multi_agent_context as Record<string, unknown>;
    expect(ctx.parentAgentDid).toBe(PARENT_DID);
    expect(ctx.multiAgentSessionId).toBe("mas:run-1");
  });

  it("supports a custom multiAgentSessionId resolver", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: {
        enabled: true,
        multiAgentSessionId: ctx => `session-${ctx.runId}`,
        parentAgentDid: PARENT_DID
      }
    });
    const agent = new ScriptedAgent({
      events: [{ type: EventType.RUN_FINISHED } as BaseEvent]
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    for (const call of payloadsOf(evaluateMock)) {
      expect(call.multi_agent_session_id).toBe("session-run-1");
    }
  });

  it("emits array-shaped timeline signals (backend-compatible) when enabled", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: { enabled: true, parentAgentDid: PARENT_DID }
    });
    const agent = new ScriptedAgent({
      events: [
        {
          messageId: "m1",
          role: "assistant",
          type: EventType.TEXT_MESSAGE_START
        } as BaseEvent,
        {
          delta: "Sunny",
          messageId: "m1",
          type: EventType.TEXT_MESSAGE_CONTENT
        } as BaseEvent,
        { messageId: "m1", type: EventType.TEXT_MESSAGE_END } as BaseEvent,
        { type: EventType.RUN_FINISHED } as BaseEvent
      ]
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const signals = payloadsOf(evaluateMock).filter(
      p => p.event_type === WorkflowEventType.SIGNAL_RECEIVED
    );
    const userInput = signals.find(s => s.signal_name === "user_input");
    const agentOutput = signals.find(s => s.signal_name === "agent_output");
    // user message text extracted to element 0 (not a JSON-stringified object)
    expect(userInput?.signal_args).toEqual(["Hi there"]);
    expect(agentOutput?.signal_args).toEqual(["Sunny"]);
  });

  it("keeps the legacy { value } signal shape when multi-agent is disabled", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({
      events: [{ type: EventType.RUN_FINISHED } as BaseEvent]
    });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const userInput = payloadsOf(evaluateMock).find(
      p => p.signal_name === "user_input"
    );
    expect(Array.isArray(userInput?.signal_args)).toBe(false);
    expect(userInput?.signal_args).toHaveProperty("value");
  });

  it("invokes forwardContext with the built context and merges its result into handoff metadata", async () => {
    vi.spyOn(OpenBoxClient.prototype, "evaluate").mockResolvedValue(null);
    const forwardContext = vi.fn().mockReturnValue({ stashed: true });
    const onEvent = vi.fn();
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: {
        enabled: true,
        forwardContext,
        handoffTools,
        parentAgentDid: PARENT_DID
      },
      onEvent
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    expect(forwardContext).toHaveBeenCalledTimes(1);
    const ctx = forwardContext.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(ctx.multiAgentSessionId).toBe("mas:run-1");
    expect(ctx.parentAgentDid).toBe(PARENT_DID);
    expect(ctx.parentActivityId).toBe("call-w");
    expect(ctx.parentRunId).toBe("run-1");
    expect(ctx.parentWorkflowId).toBe("thread-1");

    const handoff = onEvent.mock.calls
      .map(args => args[0] as { eventType: string; payload: Record<string, unknown> })
      .find(e => e.eventType === (WorkflowEventType.HANDOFF as string));
    const meta = handoff?.payload.metadata as Record<string, unknown>;
    expect(meta.forwarded_context).toEqual({ stashed: true });
  });

  it("isolates a throwing forwardContext adapter (run completes, handoff still emitted, no forwarded_context)", async () => {
    vi.spyOn(OpenBoxClient.prototype, "evaluate").mockResolvedValue(null);
    const onEvent = vi.fn();
    const { controller, logger } = buildController();
    const middleware = createOpenBoxMiddleware(controller, {
      multiAgent: {
        enabled: true,
        forwardContext: () => {
          throw new Error("boom");
        },
        handoffTools,
        parentAgentDid: PARENT_DID
      },
      onEvent
    });
    const agent = new ScriptedAgent({ events: weatherToolEvents() });

    const events = await collectEvents(middleware.run(buildRunAgentInput(), agent));

    // The run is unaffected: events flow through and the Handoff is still emitted.
    expect(events.length).toBeGreaterThan(0);
    const handoff = onEvent.mock.calls
      .map(args => args[0] as { eventType: string; payload: Record<string, unknown> })
      .find(e => e.eventType === (WorkflowEventType.HANDOFF as string));
    expect(handoff).toBeDefined();
    const meta = handoff?.payload.metadata as Record<string, unknown>;
    expect(meta).not.toHaveProperty("forwarded_context");
    expect(logger.warn).toHaveBeenCalled();
  });
});
