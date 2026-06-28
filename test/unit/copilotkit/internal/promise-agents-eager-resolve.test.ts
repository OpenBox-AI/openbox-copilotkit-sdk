import {
  AbstractAgent,
  EventType,
  type BaseEvent
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

class FakeAgent extends AbstractAgent {
  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(s => {
      s.next({ type: EventType.RUN_STARTED } as BaseEvent);
      s.complete();
    });
  }
  public override clone(): AbstractAgent {
    return new FakeAgent();
  }
  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

const CONFIG = {
  apiKey: "obx_test_promise_eager",
  apiUrl: "http://localhost:9999"
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("promise-shape agents — eager resolution at wrap time", () => {
  it("awaits the agents Promise before returning, so the returned `agents` is a plain record (no race window)", async () => {
    let resolveAgents!: (record: Record<string, AbstractAgent>) => void;
    const agentsPromise = new Promise<Record<string, AbstractAgent>>(res => {
      resolveAgents = res;
    });

    const wrapPromise = wrapCopilotRuntimeOptions(
      { agents: agentsPromise },
      CONFIG
    );

    // wrapPromise must not resolve until the agents promise has resolved.
    let wrapResolved = false;
    void wrapPromise.then(() => {
      wrapResolved = true;
    });

    await new Promise(r => setTimeout(r, 20));
    expect(wrapResolved).toBe(false);

    resolveAgents({ support: new FakeAgent() });

    const { options, shutdown } = await wrapPromise;
    expect(wrapResolved).toBe(true);
    // Returned agents value must be the resolved record, not a Promise.
    expect((options.agents as { then?: unknown }).then).toBeUndefined();
    const agents = options.agents as Record<string, AbstractAgent>;
    expect(agents.support).toBeInstanceOf(AbstractAgent);

    await shutdown();
  });

  it("two parallel first-requests after wrap both see the same proxied record (no concurrent-first-request race)", async () => {
    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      {
        agents: new Promise<Record<string, AbstractAgent>>(res => {
          setTimeout(() => res({ support: new FakeAgent() }), 30);
        })
      },
      CONFIG
    );

    const agents = options.agents as Record<string, AbstractAgent>;

    // Simulate two "first requests" cloning the same proxied agent. Both
    // clones must succeed and produce per-request proxied agents.
    const [a, b] = await Promise.all([
      Promise.resolve(agents.support!.clone()),
      Promise.resolve(agents.support!.clone())
    ]);

    expect(a).not.toBe(b);
    expect(a).toBeInstanceOf(AbstractAgent);
    expect(b).toBeInstanceOf(AbstractAgent);

    await shutdown();
  });
});
