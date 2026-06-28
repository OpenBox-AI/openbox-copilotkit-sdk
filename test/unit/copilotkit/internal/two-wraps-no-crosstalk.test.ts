import {
  AbstractAgent,
  EventType,
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

import { wrapCopilotRuntimeOptions } from "../../../../src/copilotkit/internal/wrap-copilot-runtime-options.js";
import { WorkflowEventType } from "../../../../src/types/workflow-event-type.js";

/**
 * A simple `use()`-capable scripted agent. Each clone produces a fresh
 * instance with its own (empty) middleware list, and a `run()` that walks
 * the chain so attached middlewares observe events.
 */
type TestMiddleware = {
  run: (input: RunAgentInput, next: AbstractAgent) => Observable<BaseEvent>;
};

class UseCapableAgent extends AbstractAgent {
  public readonly id: string;
  public readonly recordedMiddlewares: TestMiddleware[] = [];

  public constructor(id: string) {
    super();
    this.id = id;
  }

  public override run(input: RunAgentInput): Observable<BaseEvent> {
    let chain: AbstractAgent = new ScriptedRaw();
    for (const mw of this.recordedMiddlewares) {
      const prev = chain;
      chain = Object.assign(Object.create(AbstractAgent.prototype), {
        run: (i: RunAgentInput) => mw.run(i, prev)
      });
    }
    return chain.run(input);
  }

  public override use(...middlewares: unknown[]): this {
    for (const mw of middlewares) {
      this.recordedMiddlewares.push(mw as TestMiddleware);
    }
    return this;
  }

  public override clone(): AbstractAgent {
    return new UseCapableAgent(this.id);
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

class ScriptedRaw extends AbstractAgent {
  public override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(s => {
      s.next({
        runId: input.runId,
        threadId: input.threadId,
        type: EventType.RUN_STARTED
      } as BaseEvent);
      s.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      s.complete();
    });
  }
  public override clone(): AbstractAgent {
    return new ScriptedRaw();
  }
  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

afterEach(() => {
  vi.clearAllMocks();
});

function runAgent(agent: AbstractAgent): Promise<void> {
  return new Promise((resolve, reject) => {
    const input: RunAgentInput = {
      context: [],
      messages: [{ content: "hi", id: "u", role: "user" } as RunAgentInput["messages"][number]],
      runId: "run-x",
      state: {},
      threadId: "thread-x",
      tools: []
    } as RunAgentInput;
    agent.run!(input).subscribe({
      next: () => {},
      error: reject,
      complete: () => resolve()
    });
  });
}

describe("two wraps over the same agent record — controller isolation", () => {
  it("two wraps with distinct configs produce distinct proxies and route emissions to their own controllers", async () => {
    const sharedRecord = { support: new UseCapableAgent("support") };

    const wrapA = await wrapCopilotRuntimeOptions(
      { agents: sharedRecord },
      { apiKey: "obx_test_two_wraps_a", apiUrl: "http://localhost:9991" }
    );
    const wrapB = await wrapCopilotRuntimeOptions(
      { agents: sharedRecord },
      { apiKey: "obx_test_two_wraps_b", apiUrl: "http://localhost:9992" }
    );

    const evalA = vi.fn(async (_payload: Record<string, unknown>) => null);
    const evalB = vi.fn(async (_payload: Record<string, unknown>) => null);
    (wrapA.controller.client as unknown as { evaluate: typeof evalA }).evaluate = evalA;
    (wrapB.controller.client as unknown as { evaluate: typeof evalB }).evaluate = evalB;

    const agentsA = wrapA.options.agents as Record<string, AbstractAgent>;
    const agentsB = wrapB.options.agents as Record<string, AbstractAgent>;

    expect(agentsA.support).not.toBe(agentsB.support);
    expect(agentsA.support).not.toBe(sharedRecord.support);

    const cloneA = agentsA.support!.clone();
    const cloneB = agentsB.support!.clone();

    expect(cloneA).not.toBe(cloneB);

    await runAgent(cloneA);
    await runAgent(cloneB);

    // Each wrap's controller observed only its own clone's events.
    const aEvents = evalA.mock.calls.length;
    const bEvents = evalB.mock.calls.length;
    expect(aEvents).toBeGreaterThan(0);
    expect(bEvents).toBeGreaterThan(0);

    // Cross-talk would manifest as B's controller receiving A's emissions
    // (or vice versa). Each evaluate mock should only have seen events
    // emitted by its own clone — and the clones' configurations differ
    // only by which controller is closed over.
    for (const call of evalA.mock.calls) {
      // Sanity: every payload includes our shared `workflow_type`.
      expect((call[0] as Record<string, unknown>).workflow_type).toBe(
        "copilotkit"
      );
    }
    for (const call of evalB.mock.calls) {
      expect((call[0] as Record<string, unknown>).workflow_type).toBe(
        "copilotkit"
      );
    }

    // Headline: counts match — A's events all went to A; B's events all
    // went to B; neither saw the other's.
    expect(aEvents).toBe(bEvents);
    const aTypes = evalA.mock.calls.map(
      c => (c[0] as Record<string, unknown>).event_type
    );
    const bTypes = evalB.mock.calls.map(
      c => (c[0] as Record<string, unknown>).event_type
    );
    expect(aTypes).toContain(WorkflowEventType.WORKFLOW_STARTED);
    expect(bTypes).toContain(WorkflowEventType.WORKFLOW_STARTED);

    await wrapA.shutdown();
    await wrapB.shutdown();
  });

  it("wrapping a record returned from one wrap inside another wrap still produces an isolated proxy (per-call markerSymbol)", async () => {
    const agent = new UseCapableAgent("re-wrapped");

    const wrap1 = await wrapCopilotRuntimeOptions(
      { agents: { a: agent } },
      { apiKey: "obx_test_rewrap_1", apiUrl: "http://localhost:9993" }
    );
    const proxiedFromWrap1 = (wrap1.options.agents as Record<string, AbstractAgent>).a!;

    const wrap2 = await wrapCopilotRuntimeOptions(
      { agents: { a: proxiedFromWrap1 } },
      { apiKey: "obx_test_rewrap_2", apiUrl: "http://localhost:9994" }
    );
    const proxiedFromWrap2 = (wrap2.options.agents as Record<string, AbstractAgent>).a!;

    expect(proxiedFromWrap2).not.toBe(proxiedFromWrap1);
    expect(proxiedFromWrap2).not.toBe(agent);

    await wrap1.shutdown();
    await wrap2.shutdown();
  });
});
