import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type Middleware,
  type RunAgentInput
} from "@ag-ui/client";
import { EMPTY, Observable, type Subscriber } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { wrapCopilotRuntimeOptions } from "../../../../src/copilotkit/internal/wrap-copilot-runtime-options.js";
import { WorkflowEventType } from "../../../../src/types/workflow-event-type.js";

/**
 * Reference agent: a real `.use()` chain that mirrors AG-UI's "first .use is
 * innermost / sees raw events" contract. `.run()` emits a scripted event
 * sequence; `.clone()` returns a fresh instance with an empty middleware list.
 */
class ScriptedRecordingAgent extends AbstractAgent {
  public readonly attachedMiddlewares: Middleware[] = [];
  public readonly originalClone: typeof ScriptedRecordingAgent.prototype.clone;

  public constructor() {
    super();
    this.originalClone = this.clone.bind(this);
  }

  public override run(input: RunAgentInput): Observable<BaseEvent> {
    return this.#composeChain(input);
  }

  public override clone(): AbstractAgent {
    return new ScriptedRecordingAgent();
  }

  public override use(...mws: unknown[]): this {
    for (const mw of mws) {
      this.attachedMiddlewares.push(mw as Middleware);
    }
    return this;
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }

  #composeChain(input: RunAgentInput): Observable<BaseEvent> {
    const baseAgent = new RawEmittingAgent();
    let chain: AbstractAgent = baseAgent;
    for (const mw of this.attachedMiddlewares) {
      const prev = chain;
      chain = wrapMiddlewareAsAgent(mw, prev);
    }
    return chain.run(input);
  }
}

class RawEmittingAgent extends AbstractAgent {
  public override run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      subscriber.next({
        runId: input.runId,
        threadId: input.threadId,
        type: EventType.RUN_STARTED
      } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      subscriber.complete();
    });
  }

  public override clone(): AbstractAgent {
    return new RawEmittingAgent();
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

function wrapMiddlewareAsAgent(
  mw: Middleware,
  next: AbstractAgent
): AbstractAgent {
  const proxy = Object.create(AbstractAgent.prototype) as AbstractAgent;
  (proxy as unknown as { run(input: RunAgentInput): Observable<BaseEvent> }).run =
    (input: RunAgentInput) => mw.run(input, next);
  return proxy;
}

const CONFIG = {
  apiKey: "obx_test_clone_safety",
  apiUrl: "http://localhost:9999"
};

function runAgent(agent: AbstractAgent): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    const input: RunAgentInput = {
      context: [],
      messages: [{ content: "hi", id: "u1", role: "user" } as RunAgentInput["messages"][number]],
      runId: "run-clone",
      state: {},
      threadId: "thread-clone",
      tools: []
    } as RunAgentInput;
    agent.run!(input).subscribe({
      next: e => events.push(e),
      error: reject,
      complete: () => resolve(events)
    });
  });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("clone-safety regression — Proxy isolation, not in-place mutation", () => {
  it("per-request clone emits OpenBox events via the proxy chain (no in-place .clone patch on the original)", async () => {
    const originalAgent = new ScriptedRecordingAgent();
    // Capture by descriptor — comparing methods directly trips the
    // `@typescript-eslint/unbound-method` rule. The descriptor.value
    // is the function reference; an unchanged value proves the original
    // agent's `clone` slot was never reassigned (no in-place patch).
    const originalCloneDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(originalAgent) as object,
      "clone"
    );

    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { support: originalAgent } },
      CONFIG
    );

    const evaluateMock = vi.fn(async (_payload: Record<string, unknown>) => null);
    (controller.runtime.client as unknown as { evaluate: typeof evaluateMock }).evaluate =
      evaluateMock;

    const afterDescriptor = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(originalAgent) as object,
      "clone"
    );
    expect(afterDescriptor?.value).toBe(originalCloneDescriptor?.value);
    expect(Object.prototype.hasOwnProperty.call(originalAgent, "clone")).toBe(
      false
    );

    const agents = options.agents as Record<string, AbstractAgent>;
    const proxiedSupport = agents.support!;

    // Per-request: v2's cloneAgentForRequest calls proxiedAgent.clone().
    const requestClone = proxiedSupport.clone();
    expect(requestClone).not.toBe(proxiedSupport);

    const events = await runAgent(requestClone);
    expect(events.map(e => e.type)).toContain(EventType.RUN_STARTED);
    expect(events.map(e => e.type)).toContain(EventType.RUN_FINISHED);

    const emitted = evaluateMock.mock.calls.map(
      c => (c[0] as Record<string, unknown>).event_type
    );
    expect(emitted).toContain(WorkflowEventType.WORKFLOW_STARTED);
    expect(emitted).toContain(WorkflowEventType.WORKFLOW_COMPLETED);

    await shutdown();
  });

  it("clone-of-clone also emits OpenBox events (each clone level wrapped independently)", async () => {
    const { options, controller, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { support: new ScriptedRecordingAgent() } },
      CONFIG
    );

    const evaluateMock = vi.fn(async (_payload: Record<string, unknown>) => null);
    (controller.runtime.client as unknown as { evaluate: typeof evaluateMock }).evaluate =
      evaluateMock;

    const agents = options.agents as Record<string, AbstractAgent>;
    const firstClone: AbstractAgent = agents.support!.clone();
    const doubleCloned: AbstractAgent = firstClone.clone();
    await runAgent(doubleCloned);

    const emitted = evaluateMock.mock.calls.map(
      c => (c[0] as Record<string, unknown>).event_type
    );
    expect(emitted).toContain(WorkflowEventType.WORKFLOW_STARTED);
    expect(emitted).toContain(WorkflowEventType.WORKFLOW_COMPLETED);

    await shutdown();
  });

  it("does NOT attach OpenBox middleware to the ORIGINAL agent (original middleware list stays empty)", async () => {
    const original = new ScriptedRecordingAgent();
    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: { support: original } },
      CONFIG
    );

    // Touch the proxy so any lazy attachment would fire.
    const agents = options.agents as Record<string, AbstractAgent>;
    void agents.support!;

    expect(original.attachedMiddlewares).toHaveLength(0);

    await shutdown();
  });
});
