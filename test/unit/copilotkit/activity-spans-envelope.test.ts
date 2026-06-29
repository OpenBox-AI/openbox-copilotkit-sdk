import { EventType, type BaseEvent } from "@ag-ui/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SpanBuffer } from "../../../src/spans/span-buffer.js";
import * as toolSpanSynthesizerModule from "../../../src/spans/tool-span-synthesizer.js";
import { createOpenBoxMiddleware } from "../../../src/copilotkit/openbox-middleware.js";

import {
  ScriptedAgent,
  buildController,
  buildRunAgentInput,
  collectEvents
} from "./test-utils.js";

const scriptedToolCall: BaseEvent[] = [
  {
    toolCallId: "call-1",
    toolCallName: "weatherTool",
    type: EventType.TOOL_CALL_START
  } as BaseEvent,
  {
    delta: '{"city":"SF"}',
    toolCallId: "call-1",
    type: EventType.TOOL_CALL_ARGS
  } as BaseEvent,
  { toolCallId: "call-1", type: EventType.TOOL_CALL_END } as BaseEvent,
  {
    content: '{"temp":68}',
    toolCallId: "call-1",
    type: "TOOL_CALL_RESULT"
  } as BaseEvent,
  { type: EventType.RUN_FINISHED } as BaseEvent
];

function findPayload(
  calls: readonly unknown[][],
  predicate: (payload: Record<string, unknown>) => boolean
): Record<string, unknown> | undefined {
  for (const call of calls) {
    const payload = call[0] as Record<string, unknown> | undefined;
    if (payload && predicate(payload)) {
      return payload;
    }
  }
  return undefined;
}

describe("OpenBoxMiddleware — function_call span hook event", () => {
  const savedDisableEnv = process.env.OPENBOX_DISABLE_SPAN_BUFFER;

  beforeEach(() => {
    delete process.env.OPENBOX_DISABLE_SPAN_BUFFER;
  });

  afterEach(() => {
    if (savedDisableEnv === undefined) {
      delete process.env.OPENBOX_DISABLE_SPAN_BUFFER;
    } else {
      process.env.OPENBOX_DISABLE_SPAN_BUFFER = savedDisableEnv;
    }
  });

  it("emits a sibling ActivityStarted hook event carrying the synthesized span (buffer wired)", async () => {
    const { controller, evaluateMock } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    // The completion event itself stays clean — no spans, no hook_trigger.
    const completed = findPayload(
      evaluateMock.mock.calls,
      p => p.event_type === "ActivityCompleted"
    );
    expect(completed).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(completed!, "spans")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(completed!, "hook_trigger")).toBe(
      false
    );

    // The hook event ships as a separate ActivityStarted with the function_call span.
    const hook = findPayload(
      evaluateMock.mock.calls,
      p =>
        p.event_type === "ActivityStarted" &&
        p.activity_type === "function_call"
    );
    expect(hook).toBeDefined();
    expect(hook?.hook_trigger).toBe(true);
    expect(hook?.activity_id).toBe("call-1");

    // openbox-core rejects ActivityStarted events that carry activity_output
    // or unknown top-level fields like tool_name (validated empirically).
    expect(Object.prototype.hasOwnProperty.call(hook!, "activity_output")).toBe(
      false
    );
    expect(Object.prototype.hasOwnProperty.call(hook!, "tool_name")).toBe(false);

    const spans = hook?.spans as unknown[] | undefined;
    expect(Array.isArray(spans)).toBe(true);
    expect(spans?.length).toBe(1);
    const span = spans?.[0] as Record<string, unknown>;
    expect(span.name).toBe("tool:weatherTool");
    // openbox-core derives `hook_stage` from `span.stage` (matches mastra-sdk).
    expect(span.stage).toBe("completed");
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs["tool.name"]).toBe("weatherTool");
    expect(attrs["tool.call_id"]).toBe("call-1");
    expect(attrs["openbox.enforcement_owner"]).toBe("openbox-copilotkit");
    expect(attrs["openbox.gateway"]).toBe("agui_event");
    expect(attrs["openbox.enforcement_status"]).toBe("pre_execution_allowed");
    expect(typeof attrs["openbox.idempotency_key"]).toBe("string");

    // Wire-format bigint fields coerced to decimal strings.
    expect(typeof span.start_time_unix_nano).toBe("string");
    expect(typeof span.end_time_unix_nano).toBe("string");
    expect(span.start_time_unix_nano as string).toMatch(/^\d+$/);

    // Full payload must JSON-stringify without throwing on bigint.
    expect(() => JSON.stringify(hook)).not.toThrow();

    // Buffer still receives the local-debug copy (raw bigint shape preserved).
    const drained = spanBuffer.drain().get("thread-1");
    expect(drained?.length).toBe(1);
    expect(typeof drained?.[0]?.start_time_unix_nano).toBe("bigint");
  });

  it("emits NO hook event and a clean ActivityCompleted when no SpanBuffer is wired", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const hook = findPayload(
      evaluateMock.mock.calls,
      p =>
        p.event_type === "ActivityStarted" &&
        p.activity_type === "function_call"
    );
    expect(hook).toBeUndefined();

    const completed = findPayload(
      evaluateMock.mock.calls,
      p => p.event_type === "ActivityCompleted"
    );
    expect(completed).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(completed!, "spans")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(completed!, "hook_trigger")).toBe(
      false
    );
  });

  it("emits NO hook event when OPENBOX_DISABLE_SPAN_BUFFER=1 (envelope unchanged)", async () => {
    process.env.OPENBOX_DISABLE_SPAN_BUFFER = "1";

    const { controller, evaluateMock } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const hook = findPayload(
      evaluateMock.mock.calls,
      p =>
        p.event_type === "ActivityStarted" &&
        p.activity_type === "function_call"
    );
    expect(hook).toBeUndefined();
    expect(spanBuffer.workflowCount()).toBe(0);
  });

  it("skips the hook emit and logs a warn when synthesis throws", async () => {
    const { controller, evaluateMock, logger } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    const spy = vi.spyOn(toolSpanSynthesizerModule, "synthesizeToolSpan");
    spy.mockImplementation(() => {
      throw new Error("forced synth failure");
    });

    try {
      const events = await collectEvents(
        middleware.run(buildRunAgentInput(), agent)
      );
      expect(events.length).toBeGreaterThan(0);

      const hook = findPayload(
        evaluateMock.mock.calls,
        p =>
          p.event_type === "ActivityStarted" &&
          p.activity_type === "function_call"
      );
      expect(hook).toBeUndefined();

      const warnCalls = logger.warn.mock.calls.filter(args => {
        const entry = args[0] as { note?: string } | undefined;
        return entry?.note === "openbox tool-span synthesis failed";
      });
      expect(warnCalls.length).toBe(1);
      expect(spanBuffer.workflowCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
