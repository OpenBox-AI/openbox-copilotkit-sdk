import { EventType, type BaseEvent } from "@ag-ui/client";
import { describe, expect, it } from "vitest";

import {
  SEMANTIC_TYPE_ATTR,
  SEMANTIC_TYPE_FUNCTION_CALL,
  TOOL_SPAN_SYNTHESIZER_NAME,
  SYNTHESIZER_ATTR
} from "../../../src/spans/semantic-types.js";
import { SpanBuffer } from "../../../src/spans/span-buffer.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

const scriptedSingleToolCall: BaseEvent[] = [
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

const scriptedParallelToolCalls: BaseEvent[] = [
  {
    toolCallId: "call-a",
    toolCallName: "setThemeColor",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    toolCallId: "call-b",
    toolCallName: "searchDocs",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    delta: '{"color":"blue"}',
    toolCallId: "call-a",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  {
    delta: '{"q":"openbox"}',
    toolCallId: "call-b",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  { toolCallId: "call-a", type: EventType.TOOL_CALL_END } as BaseEvent,
  { toolCallId: "call-b", type: EventType.TOOL_CALL_END } as BaseEvent,
  {
    content: '{"ok":true}',
    toolCallId: "call-a",
    type: "TOOL_CALL_RESULT"
  } as BaseEvent,
  {
    content: '{"hits":3}',
    toolCallId: "call-b",
    type: "TOOL_CALL_RESULT"
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

const scriptedNoToolText: BaseEvent[] = [
  {
    messageId: "msg-1",
    role: "assistant",
    type: EventType.TEXT_MESSAGE_START
  } as BaseEvent,
  {
    delta: "Hello",
    messageId: "msg-1",
    type: EventType.TEXT_MESSAGE_CONTENT
  } as BaseEvent,
  { messageId: "msg-1", type: EventType.TEXT_MESSAGE_END } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

describe("OpenBoxMiddleware — SpanBuffer integration", () => {
  it("synthesizes one function_call span per tool call into the provided buffer", async () => {
    const { controller } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedSingleToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const drained = spanBuffer.drain();
    const spans = drained.get("thread-1");
    expect(spans).toBeDefined();
    expect(spans?.length).toBe(1);
    const span = spans?.[0];
    expect(span?.name).toBe("tool:setThemeColor");
    expect(span?.attributes[SEMANTIC_TYPE_ATTR]).toBe(SEMANTIC_TYPE_FUNCTION_CALL);
    expect(span?.attributes[SYNTHESIZER_ATTR]).toBe(TOOL_SPAN_SYNTHESIZER_NAME);
    expect(span?.attributes["tool.name"]).toBe("setThemeColor");
    expect(span?.attributes["openbox.enforcement_owner"]).toBe(
      "openbox-copilotkit"
    );
    expect(span?.attributes["openbox.gateway"]).toBe("agui_event");
    expect(span?.attributes["openbox.enforcement_status"]).toBe(
      "pre_execution_allowed"
    );
    expect(span?.attributes["openbox.idempotency_key"]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces distinct spans for parallel tool calls with distinct call_ids", async () => {
    const { controller } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedParallelToolCalls });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const spans = spanBuffer.drain().get("thread-1") ?? [];
    expect(spans.length).toBe(2);
    const callIds = spans.map(s => s.attributes["tool.call_id"]);
    expect(callIds).toEqual(["call-a", "call-b"]);
    expect(spans[0]?.span_id).not.toBe(spans[1]?.span_id);
  });

  it("emits no spans for a text-only run", async () => {
    const { controller } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedNoToolText });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    expect(spanBuffer.workflowCount()).toBe(0);
  });

  it("skips synthesis when no buffer is provided (no behavior change)", async () => {
    const { controller } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedSingleToolCall });

    // Should not throw or alter event flow; just verify completion.
    const events = await collectEvents(middleware.run(buildRunAgentInput(), agent));
    expect(events.length).toBeGreaterThan(0);
  });
});
