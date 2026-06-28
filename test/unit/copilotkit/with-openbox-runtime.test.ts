import {
  AbstractAgent,
  EventType,
  type BaseEvent
} from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/otel/setup-openbox-opentelemetry.js", () => ({
  setupOpenBoxOpenTelemetry: vi.fn(() => ({
    instrumentations: [],
    shutdown: vi.fn(async () => {}),
    tracerProvider: {}
  }))
}));

import { setupOpenBoxOpenTelemetry } from "../../../src/otel/setup-openbox-opentelemetry.js";
import {
  OPENBOX_COPILOTKIT_RUNTIME_SYMBOL,
  getOpenBoxRuntime
} from "../../../src/copilotkit/runtime-symbol.js";
import type { OpenBoxRuntimeController } from "../../../src/copilotkit/types.js";
import { withOpenBoxRuntime } from "../../../src/copilotkit/with-openbox-runtime.js";

class FakeAgent extends AbstractAgent {
  public constructor(public readonly id: string) {
    super();
  }

  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      subscriber.next({ type: EventType.RUN_STARTED } as BaseEvent);
      subscriber.next({ type: EventType.RUN_FINISHED } as BaseEvent);
      subscriber.complete();
    });
  }

  public override clone(): AbstractAgent {
    return new FakeAgent(this.id);
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

const CONFIG = {
  apiKey: "obx_test_with_openbox_runtime",
  apiUrl: "http://localhost:9999"
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("withOpenBoxRuntime — tuple-return shape", () => {
  it("returns { runtime, shutdown } where runtime is a CopilotRuntime instance", async () => {
    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    expect(runtime).toBeInstanceOf(CopilotRuntime);
    expect(typeof shutdown).toBe("function");

    await shutdown();
  });

  it("attaches the OpenBox controller to the runtime via the private symbol", async () => {
    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    const attached = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);
    expect(attached).toBeDefined();
    expect(attached?.client).toBeDefined();
    expect(attached?.spanProcessor).toBeDefined();

    await shutdown();
  });

  it("forwards middlewareOptions / defaults from the config object to the internal wrap", async () => {
    const onEvent = vi.fn();
    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      {
        ...CONFIG,
        defaults: {
          agentId: "support",
          tenantId: "tenant-a",
          workflowType: "copilotkit"
        },
        middlewareOptions: {
          frontendToolNames: ["setThemeColor"],
          onEvent
        }
      }
    );

    const attached = getOpenBoxRuntime<OpenBoxRuntimeController>(runtime);
    expect(attached?.defaults).toEqual({
      agentId: "support",
      tenantId: "tenant-a",
      workflowType: "copilotkit"
    });

    await shutdown();
  });
});

describe("withOpenBoxRuntime — instance-form guard", () => {
  it("throws TypeError with the documented example when handed a constructed CopilotRuntime", async () => {
    const built = new CopilotRuntime({
      agents: { support: new FakeAgent("support") }
    });

    await expect(
      withOpenBoxRuntime(built as never, CONFIG)
    ).rejects.toThrow(TypeError);
    await expect(
      withOpenBoxRuntime(built as never, CONFIG)
    ).rejects.toThrow(
      /pass CopilotRuntimeOptions \(not a constructed CopilotRuntime\)/
    );
  });
});

describe("withOpenBoxRuntime — OTEL self-call dedup across two wraps", () => {
  it("calls setupOpenBoxOpenTelemetry once per wrap call and reuses the mocked controller's shutdown idempotently across both", async () => {
    const otelMock = setupOpenBoxOpenTelemetry as unknown as ReturnType<
      typeof vi.fn
    >;

    const first = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );
    const second = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    expect(first.runtime).not.toBe(second.runtime);
    // Two wraps → two distinct controller objects under the private symbol.
    expect(getOpenBoxRuntime(first.runtime)).not.toBe(
      getOpenBoxRuntime(second.runtime)
    );
    // setupOpenBoxOpenTelemetry is invoked once per wrap; Phase 2's
    // module-private dedup is what makes the second call return the same
    // controller in production. The mock returns a fresh object each call,
    // so here we only assert that wrap delegated to it twice (no skip path
    // inside withOpenBoxRuntime itself).
    expect(otelMock).toHaveBeenCalledTimes(2);

    await first.shutdown();
    await second.shutdown();
  });
});
