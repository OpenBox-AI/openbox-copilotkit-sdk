import {
  AbstractAgent,
  EventType,
  type BaseEvent
} from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  it("repeated shutdown calls resolve to undefined and clear the runtime symbol once", async () => {
    const { runtime, shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();
    await expect(shutdown()).resolves.toBeUndefined();

    expect(getOpenBoxRuntime(runtime)).toBeUndefined();
    expect(
      (runtime as unknown as Record<symbol, unknown>)[
        OPENBOX_COPILOTKIT_RUNTIME_SYMBOL
      ]
    ).toBeUndefined();
  });

  it("concurrent shutdown invocations share the same promise", async () => {
    const { shutdown } = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    const results = await Promise.all([
      shutdown(),
      shutdown(),
      shutdown(),
      shutdown()
    ]);

    for (const r of results) {
      expect(r).toBeUndefined();
    }
  });
});
