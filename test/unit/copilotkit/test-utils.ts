import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import type { OpenBoxClient as BaseOpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { ContextStore } from "@openbox-ai/openbox-sdk-ts/context";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { EMPTY, Observable } from "rxjs";
import { vi, type Mock } from "vitest";

import { OpenBoxClient } from "../../../src/client/openbox-client.js";
import { InMemoryInterruptStore } from "../../../src/copilotkit/internal/interrupt-store.js";
import { RunContextStore } from "../../../src/copilotkit/internal/run-context-store.js";
import { RunTerminalStateRegistry } from "../../../src/copilotkit/internal/run-terminal-state.js";
import { ServerToolOwnershipRegistry } from "../../../src/copilotkit/internal/server-tool-ownership.js";
import { LifecycleTelemetryQueue } from "../../../src/copilotkit/lifecycle-telemetry.js";
import type {
  OpenBoxLogger,
  OpenBoxRuntimeController
} from "../../../src/copilotkit/types.js";

export interface ScriptedAgentOptions {
  emitRunStarted?: boolean;
  events: BaseEvent[];
  runError?: Error;
}

/**
 * Minimal AbstractAgent for AG-UI middleware tests. Overrides `run(input)` to
 * synchronously emit a scripted event sequence (RUN_STARTED prepended unless
 * `emitRunStarted: false`). Real agents stream events asynchronously over
 * SSE, but the middleware only cares about event ordering — synchronous
 * emission keeps test timing deterministic.
 */
export class ScriptedAgent extends AbstractAgent {
  public constructor(private readonly opts: ScriptedAgentOptions) {
    super();
  }

  public run(input: RunAgentInput): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      try {
        if (this.opts.runError) {
          subscriber.error(this.opts.runError);
          return;
        }
        if (this.opts.emitRunStarted !== false) {
          subscriber.next({
            runId: input.runId,
            threadId: input.threadId,
            type: EventType.RUN_STARTED
          } as BaseEvent);
        }
        for (const event of this.opts.events) {
          subscriber.next(event);
        }
        subscriber.complete();
      } catch (err) {
        subscriber.error(err);
      }
    });
  }

  public override clone(): AbstractAgent {
    return new ScriptedAgent(this.opts);
  }

  protected override connect(): ReturnType<AbstractAgent["connect"]> {
    return EMPTY;
  }
}

export interface BuildControllerOptions {
  evaluateMock?: Mock;
  pollApprovalMock?: Mock;
  /**
   * Pre-built base `OpenBoxRuntime` to use instead of the default stand-in
   * (e.g. `buildConformanceRuntime` wired to a `FakeCore` + a real
   * `ApprovalPoller`, for approval-wait tests — see
   * `test/integration/copilotkit-approval-wait.test.ts`). When provided,
   * `evaluateMock`/`pollApprovalMock` are still built (so the return shape is
   * unchanged) but are NOT wired to this runtime — they back only the
   * telemetry queue's legacy client, unrelated to `evaluateLifecycle`.
   */
  runtime?: OpenBoxRuntime;
}

export interface BuiltController {
  controller: OpenBoxRuntimeController;
  evaluateMock: Mock;
  logger: { warn: Mock };
  pollApprovalMock: Mock;
}

// Fixed, valid base config for the stand-in runtime (Phase 4b needs a REAL
// `OpenBoxRuntime` so `evaluateLifecycle` is a genuine method — see
// `buildRuntimeStandIn` below). `OpenBoxConfig.resolve` validates `apiUrl`
// (HTTPS or localhost) and `apiKey` (`obx_(live|test)_*`) eagerly, so this
// must be a value that actually passes, not the free-form strings the old
// plain-object stand-in used.
const STAND_IN_BASE_CONFIG = OpenBoxConfig.resolve({
  apiKey: "obx_test_copilotkit_middleware",
  apiUrl: "https://core.test"
});

/**
 * Real base `OpenBoxRuntime` (not a cast plain object — Phase 4b's enforce
 * gate calls its GENUINE `evaluateLifecycle` method, which a duck-typed
 * stand-in cannot provide). Tests exercise the middleware/emitter with the
 * SAME legacy adapter-owned mock `OpenBoxClient` they always have; only the
 * `client:` property needs an inner cast (this legacy client has a different
 * `evaluate` signature than the base `OpenBoxClient` type `OpenBoxRuntime`
 * expects — `evaluateLifecycle` only ever calls its single `.evaluate(...)`
 * method, so the cast is safe for every existing test, none of which drive
 * REQUIRE_APPROVAL through this stand-in).
 *
 * `adapter: new CoreAdapter()` (no poller) matches the pre-4b default: a
 * REQUIRE_APPROVAL verdict fails safe (rejected), and no existing test drives
 * that verdict through this stand-in — approval-wait coverage uses the base
 * `conformance` kit's `buildConformanceRuntime` instead (passed via
 * `options.runtime`).
 *
 * `contextStore` is a REAL base `ContextStore` — `openbox-middleware.ts`'s
 * RUN_FINISHED/RUN_ERROR terminal cleanup (RT-F14) calls
 * `controller.runtime.contextStore.clearHalt(...)` unconditionally, so every
 * test that drives a terminal event through the middleware needs a working
 * `contextStore`, not just tests that assert on halt behavior directly.
 */
function buildRuntimeStandIn(client: OpenBoxClient): OpenBoxRuntime {
  return new OpenBoxRuntime(STAND_IN_BASE_CONFIG, {
    client: client as unknown as BaseOpenBoxClient,
    adapter: new CoreAdapter(),
    contextStore: new ContextStore()
  });
}

export function buildController(
  options: BuildControllerOptions = {}
): BuiltController {
  const evaluateMock = options.evaluateMock ?? vi.fn().mockResolvedValue(null);
  const pollApprovalMock =
    options.pollApprovalMock ?? vi.fn().mockResolvedValue(null);
  const client = Object.create(OpenBoxClient.prototype) as OpenBoxClient;
  Object.assign(client, {
    apiKey: "test-key",
    apiUrl: "http://test.invalid",
    evaluateMaxRetries: 0,
    evaluateRetryBaseDelayMs: 0,
    onApiError: "fail_open",
    timeoutSeconds: 1
  });
  (client as unknown as { evaluate: Mock }).evaluate = evaluateMock;
  (client as unknown as { pollApproval: Mock }).pollApproval = pollApprovalMock;

  const logger: OpenBoxLogger & { warn: Mock } = { warn: vi.fn() };
  // A REAL queue (not a mock) — tests exercise the actual bounded-queue
  // mechanics (per-run FIFO, concurrency, overflow) through the SAME
  // `evaluateMock`-backed client the middleware/emitter already use. Cast
  // needed because this stand-in `client` is the LEGACY adapter-owned
  // `OpenBoxClient` (different `evaluate` signature) — same test-only
  // convenience cast `buildRuntimeStandIn` already applies below.
  const telemetryQueue = new LifecycleTelemetryQueue({
    client: client as unknown as Pick<BaseOpenBoxClient, "evaluate">,
    logger
  });
  const controller: OpenBoxRuntimeController = {
    runtime: options.runtime ?? buildRuntimeStandIn(client),
    runContext: new RunContextStore(),
    telemetryQueue,
    defaults: { agentId: "test-agent", workflowType: "copilotkit" },
    logger,
    serverToolOwnership: new ServerToolOwnershipRegistry(),
    interruptStore: new InMemoryInterruptStore(),
    runTerminalState: new RunTerminalStateRegistry()
  };

  return { controller, evaluateMock, logger, pollApprovalMock };
}

export function buildRunAgentInput(
  override: Partial<RunAgentInput> = {}
): RunAgentInput {
  return {
    context: [],
    messages: [
      {
        content: "Hi there",
        id: "msg-1",
        role: "user"
      } as RunAgentInput["messages"][number]
    ],
    runId: "run-1",
    state: {},
    threadId: "thread-1",
    tools: [],
    ...override
  } as RunAgentInput;
}

/**
 * Wait a full macrotask tick — the entire current microtask queue (however
 * many `.then()` hops deep) drains before a `setTimeout` callback runs. Used
 * to deterministically observe telemetry the bounded queue (Phase 3, fixes
 * B4) sends in the background: since `emitWorkflowStarted`/etc. now enqueue
 * and return immediately rather than awaiting `client.evaluate`, a run's
 * Observable can complete before its LAST telemetry send has reached the
 * (mocked) client — asserting on `evaluateMock.mock.calls` requires letting
 * that background work settle first.
 */
export function flushMacrotask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

export function collectEvents(
  observable: Observable<BaseEvent>
): Promise<BaseEvent[]> {
  return new Promise((resolve, reject) => {
    const events: BaseEvent[] = [];
    observable.subscribe({
      next: e => {
        events.push(e);
      },
      error: err => {
        void flushMacrotask().then(() => {
          reject(err instanceof Error ? err : new Error(String(err)));
        });
      },
      complete: () => {
        void flushMacrotask().then(() => resolve(events));
      }
    });
  });
}
