import {
  AbstractAgent,
  EventType,
  type BaseEvent
} from "@ag-ui/client";
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
  apiKey: "obx_test_shutdown_idempotent",
  apiUrl: "http://localhost:9999"
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("withOpenBoxRuntime — shutdown idempotency", () => {
  it("second call resolves immediately without re-flushing the underlying OTEL controller", async () => {
    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    const otelMock = setupOpenBoxOpenTelemetry as unknown as ReturnType<
      typeof vi.fn
    >;
    const otelResult = otelMock.mock.results[0]!.value as {
      shutdown: ReturnType<typeof vi.fn>;
    };

    await shutdown();
    await shutdown();
    await shutdown();

    expect(otelResult.shutdown).toHaveBeenCalledTimes(1);
    // Runtime symbol cleared on first shutdown; subsequent calls are no-ops.
    expect(getOpenBoxRuntime(runtime)).toBeUndefined();
    expect(
      (runtime as unknown as Record<symbol, unknown>)[
        OPENBOX_COPILOTKIT_RUNTIME_SYMBOL
      ]
    ).toBeUndefined();
  });

  it("concurrent shutdown invocations share the same promise (no double-flush race)", async () => {
    const { shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    const otelMock = setupOpenBoxOpenTelemetry as unknown as ReturnType<
      typeof vi.fn
    >;
    const otelResult = otelMock.mock.results[0]!.value as {
      shutdown: ReturnType<typeof vi.fn>;
    };

    await Promise.all([shutdown(), shutdown(), shutdown(), shutdown()]);

    expect(otelResult.shutdown).toHaveBeenCalledTimes(1);
  });

  it("shutdown still resolves cleanly when the underlying OTEL shutdown throws", async () => {
    const otelMock = setupOpenBoxOpenTelemetry as unknown as ReturnType<
      typeof vi.fn
    >;
    otelMock.mockImplementationOnce(() => ({
      instrumentations: [],
      shutdown: vi.fn(async () => {
        throw new Error("simulated otel shutdown failure");
      }),
      tracerProvider: {}
    }));

    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    await expect(shutdown()).rejects.toThrow("simulated otel shutdown failure");
    // Even on failure the runtime symbol is cleared so a future
    // re-attach is not blocked.
    expect(getOpenBoxRuntime(runtime)).toBeUndefined();
    // Subsequent shutdown reuses the rejected promise — does not retry.
    await expect(shutdown()).rejects.toThrow("simulated otel shutdown failure");
  });
});
