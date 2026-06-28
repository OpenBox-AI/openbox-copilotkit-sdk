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

class TenantAgent extends AbstractAgent {
  public readonly tenant: string;
  public constructor(tenant: string) {
    super();
    this.tenant = tenant;
  }
  public override run(): Observable<BaseEvent> {
    return new Observable<BaseEvent>(s => {
      s.next({ type: EventType.RUN_STARTED } as BaseEvent);
      s.complete();
    });
  }
  public override clone(): AbstractAgent {
    return new TenantAgent(this.tenant);
  }
  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

const CONFIG = {
  apiKey: "obx_test_factory_per_call",
  apiUrl: "http://localhost:9999"
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("factory-shape agents — per-call proxy wrapping", () => {
  it("invokes the user factory once per call and wraps its result independently each time", async () => {
    let callCount = 0;
    const factory = ({ request }: { request: Request }) => {
      callCount++;
      const tenant = request.headers.get("x-tenant-id") ?? "anon";
      return { support: new TenantAgent(tenant) };
    };

    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: factory },
      CONFIG
    );

    const wrappedFactory = options.agents as (ctx: {
      request: Request;
    }) => Promise<Record<string, AbstractAgent>>;

    const r1 = await wrappedFactory({
      request: new Request("http://localhost/", {
        headers: { "x-tenant-id": "t1" }
      })
    });
    const r2 = await wrappedFactory({
      request: new Request("http://localhost/", {
        headers: { "x-tenant-id": "t2" }
      })
    });

    expect(callCount).toBe(2);
    expect(r1.support).not.toBe(r2.support);
    expect(r1.support).toBeInstanceOf(AbstractAgent);
    expect(r2.support).toBeInstanceOf(AbstractAgent);

    await shutdown();
  });

  it("supports a factory that returns a Promise<Record>", async () => {
    const factory = async () => {
      await new Promise(r => setTimeout(r, 5));
      return { support: new TenantAgent("delayed") };
    };

    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: factory },
      CONFIG
    );

    const wrappedFactory = options.agents as (ctx: {
      request: Request;
    }) => Promise<Record<string, AbstractAgent>>;

    const r = await wrappedFactory({
      request: new Request("http://localhost/")
    });
    expect(r.support).toBeInstanceOf(AbstractAgent);

    await shutdown();
  });

  it("the wrapped factory result is NOT the original returned record (proxy wrapping always applied)", async () => {
    const originalRecord = { support: new TenantAgent("only") };
    const factory = () => originalRecord;

    const { options, shutdown } = await wrapCopilotRuntimeOptions(
      { agents: factory },
      CONFIG
    );

    const wrappedFactory = options.agents as (ctx: {
      request: Request;
    }) => Promise<Record<string, AbstractAgent>>;

    const wrapped = await wrappedFactory({
      request: new Request("http://localhost/")
    });

    expect(wrapped.support).not.toBe(originalRecord.support);

    await shutdown();
  });
});
