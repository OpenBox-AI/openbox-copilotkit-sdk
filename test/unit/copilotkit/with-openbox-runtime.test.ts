import {
  AbstractAgent,
  EventType,
  type BaseEvent
} from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { EMPTY, Observable } from "rxjs";
import { afterEach, describe, expect, it, vi } from "vitest";

import { getOpenBoxRuntime } from "../../../src/copilotkit/runtime-symbol.js";
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
    expect(attached?.runtime.client).toBeDefined();
    expect(attached?.logger).toBeDefined();

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

describe("withOpenBoxRuntime — concurrent independent wraps", () => {
  it("produces distinct runtime + controller instances and idempotent per-wrap shutdowns", async () => {
    const first = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );
    const second = await withOpenBoxRuntime(
      { agents: { support: new FakeAgent("support") } },
      CONFIG
    );

    expect(first.runtime).not.toBe(second.runtime);
    expect(getOpenBoxRuntime(first.runtime)).not.toBe(
      getOpenBoxRuntime(second.runtime)
    );

    await first.shutdown();
    await first.shutdown();
    await second.shutdown();
    await second.shutdown();
  });
});
