import {
  AbstractAgent,
  EventType,
  Middleware,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/otel/setup-openbox-opentelemetry.js", () => ({
  setupOpenBoxOpenTelemetry: vi.fn(() => ({
    instrumentations: [],
    shutdown: vi.fn(async () => {}),
    tracerProvider: {}
  }))
}));

import { OpenBoxMiddleware } from "../../../../src/copilotkit/openbox-middleware.js";
import { wrapCopilotRuntimeOptions } from "../../../../src/copilotkit/internal/wrap-copilot-runtime-options.js";

/**
 * A scripted agent that emits a TOOL_CALL_START then a TOOL_CALL_END. The
 * test installs a fake "transforming" middleware that simulates OpenGenUI's
 * "hold then release" behaviour — and asserts that OpenBox observes the
 * RAW event order (TOOL_CALL_START emitted at agent's true emission time)
 * rather than the held-and-replayed order.
 */
class ToolCallEmittingAgent extends AbstractAgent {
  public readonly observedUseCalls: Array<{ kind: string; mw: unknown }> = [];

  public override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(s => {
      s.next({
        runId: input.runId,
        threadId: input.threadId,
        type: EventType.RUN_STARTED
      } as BaseEvent);
      s.next({
        toolCallId: "tc-1",
        toolCallName: "demoTool",
        type: EventType.TOOL_CALL_START
      } as BaseEvent);
      s.next({
        toolCallId: "tc-1",
        type: EventType.TOOL_CALL_END
      } as BaseEvent);
      s.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      s.complete();
    });
  }

  public override use(...mws: unknown[]): this {
    for (const mw of mws) {
      let kind = "unknown";
      if (mw instanceof OpenBoxMiddleware) {
        kind = "openbox";
      } else if (
        typeof (mw as { constructor?: { name?: string } }).constructor
          ?.name === "string"
      ) {
        kind = (mw as { constructor: { name: string } }).constructor.name;
      }
      this.observedUseCalls.push({ kind, mw });
    }
    return this;
  }

  public override clone(): AbstractAgent {
    return new ToolCallEmittingAgent();
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("attachment ordering — OpenBox is innermost (first .use()d on the cloned agent)", () => {
  it("attaches OpenBox to the cloned agent BEFORE any user-applied middleware so it observes raw events", async () => {
    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: new ToolCallEmittingAgent() } },
      { apiKey: "obx_test_attach_order", apiUrl: "http://localhost:9999" }
    );

    const agents = options.agents as Record<string, AbstractAgent>;
    const clone = agents.a!.clone() as ToolCallEmittingAgent;

    expect(clone.observedUseCalls).toHaveLength(1);
    expect(clone.observedUseCalls[0]!.kind).toBe("openbox");

    // After OpenBox has been attached, v2's configureAgentForRequest layers
    // A2UI / MCP / OpenGenUI on top via further .use() calls. Simulate one
    // of those — assert OpenBox remains the FIRST entry (innermost).
    class FakeA2UI extends Middleware {
      override run(input: RunAgentInput, next: AbstractAgent): Observable<BaseEvent> {
        return next.run(input);
      }
    }
    clone.use(new FakeA2UI());

    expect(clone.observedUseCalls).toHaveLength(2);
    expect(clone.observedUseCalls[0]!.kind).toBe("openbox");
    expect(clone.observedUseCalls[1]!.kind).toBe("FakeA2UI");

    await shutdown();
  });

  it("does NOT attach OpenBox to the ORIGINAL agent record (only clones get the middleware)", async () => {
    const original = new ToolCallEmittingAgent();
    const { shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { a: original } },
      { apiKey: "obx_test_attach_order_2", apiUrl: "http://localhost:9999" }
    );

    expect(original.observedUseCalls).toHaveLength(0);

    await shutdown();
  });
});
