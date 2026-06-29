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

function findActivityCompletedPayload(
  calls: readonly unknown[][]
): Record<string, unknown> | undefined {
  for (const call of calls) {
    const payload = call[0] as Record<string, unknown> | undefined;
    if (payload?.event_type === "ActivityCompleted") {
      return payload;
    }
  }
  return undefined;
}

describe("OpenBoxMiddleware — ActivityCompleted span envelope", () => {
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

  it("ships the synthesized span inline on ActivityCompleted when a buffer is wired", async () => {
    const { controller, evaluateMock } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const payload = findActivityCompletedPayload(evaluateMock.mock.calls);
    expect(payload).toBeDefined();
    expect(payload?.hook_trigger).toBe(true);
    const spans = payload?.spans as unknown[] | undefined;
    expect(Array.isArray(spans)).toBe(true);
    expect(spans?.length).toBe(1);
    const span = spans?.[0] as Record<string, unknown>;
    expect(span.name).toBe("tool:weatherTool");
    const attrs = span.attributes as Record<string, unknown>;
    expect(attrs["tool.name"]).toBe("weatherTool");
    expect(attrs["tool.call_id"]).toBe("call-1");
    expect(attrs["openbox.enforcement_owner"]).toBe("openbox-copilotkit");
    expect(attrs["openbox.gateway"]).toBe("agui_event");
    expect(attrs["openbox.enforcement_status"]).toBe("pre_execution_allowed");
    expect(typeof attrs["openbox.idempotency_key"]).toBe("string");

    // Wire format: bigint nano-time fields are coerced to decimal strings so
    // the payload is JSON-serializable. The buffer copy below still holds the
    // raw bigint shape.
    expect(typeof span.start_time_unix_nano).toBe("string");
    expect(typeof span.end_time_unix_nano).toBe("string");
    expect(span.start_time_unix_nano as string).toMatch(/^\d+$/);
    expect(span.end_time_unix_nano as string).toMatch(/^\d+$/);

    // The full payload must JSON-stringify without throwing on bigint —
    // OpenBoxClient.evaluate serializes the payload before POSTing.
    expect(() => JSON.stringify(payload)).not.toThrow();

    // buffer still receives the local-debug copy (raw bigint shape)
    const drained = spanBuffer.drain().get("thread-1");
    expect(drained?.length).toBe(1);
    expect(typeof drained?.[0]?.start_time_unix_nano).toBe("bigint");
  });

  it("omits spans + hook_trigger when no SpanBuffer is wired (byte-identical to 0.3.0-beta.0)", async () => {
    const { controller, evaluateMock } = buildController();
    const middleware = createOpenBoxMiddleware(controller);
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const payload = findActivityCompletedPayload(evaluateMock.mock.calls);
    expect(payload).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(payload!, "spans")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload!, "hook_trigger")).toBe(
      false
    );
  });

  it("omits spans + hook_trigger when OPENBOX_DISABLE_SPAN_BUFFER=1", async () => {
    process.env.OPENBOX_DISABLE_SPAN_BUFFER = "1";

    const { controller, evaluateMock } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    await collectEvents(middleware.run(buildRunAgentInput(), agent));

    const payload = findActivityCompletedPayload(evaluateMock.mock.calls);
    expect(payload).toBeDefined();
    expect(Object.prototype.hasOwnProperty.call(payload!, "spans")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(payload!, "hook_trigger")).toBe(
      false
    );
    // buffer also untouched
    expect(spanBuffer.workflowCount()).toBe(0);
  });

  it("emits without spans and logs a warn when synthesis throws", async () => {
    const { controller, evaluateMock, logger } = buildController();
    const spanBuffer = new SpanBuffer();
    const middleware = createOpenBoxMiddleware(controller, { spanBuffer });
    const agent = new ScriptedAgent({ events: scriptedToolCall });

    const spy = vi.spyOn(toolSpanSynthesizerModule, "synthesizeToolSpan");
    spy.mockImplementation(() => {
      throw new Error("forced synth failure");
    });

    try {
      const events = await collectEvents(middleware.run(buildRunAgentInput(), agent));
      expect(events.length).toBeGreaterThan(0);

      const payload = findActivityCompletedPayload(evaluateMock.mock.calls);
      expect(payload).toBeDefined();
      expect(Object.prototype.hasOwnProperty.call(payload!, "spans")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(payload!, "hook_trigger")).toBe(
        false
      );

      const warnCalls = logger.warn.mock.calls.filter(args => {
        const entry = args[0] as { note?: string } | undefined;
        return entry?.note === "openbox tool-span synthesis failed";
      });
      expect(warnCalls.length).toBe(1);
      // buffer never appended on synthesis failure
      expect(spanBuffer.workflowCount()).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});
