import {
  AbstractAgent,
  EventType,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { EMPTY, Observable } from "rxjs";
import { vi, type Mock } from "vitest";

import { OpenBoxClient } from "../../../src/client/openbox-client.js";
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
}

export interface BuiltController {
  controller: OpenBoxRuntimeController;
  evaluateMock: Mock;
  logger: { warn: Mock };
  pollApprovalMock: Mock;
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
  const controller: OpenBoxRuntimeController = {
    client,
    defaults: { agentId: "test-agent", workflowType: "copilotkit" },
    logger
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
        reject(err instanceof Error ? err : new Error(String(err)));
      },
      complete: () => {
        resolve(events);
      }
    });
  });
}
