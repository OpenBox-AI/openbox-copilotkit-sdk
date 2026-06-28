import {
  EventType,
  Middleware,
  type AbstractAgent,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { Observable } from "rxjs";

import { getOpenBoxExecutionContext } from "../governance/context.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { Verdict } from "../types/verdict.js";

import {
  createGovernanceBlockedErrorEvent,
  type GovernanceBlockedErrorEvent
} from "./governance-blocked-error.js";
import {
  AGENT_OUTPUT_SIGNAL_NAME,
  OpenBoxCopilotKitEmitter,
  USER_INPUT_SIGNAL_NAME
} from "./openbox-emitter.js";
import type {
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController
} from "./types.js";

const TOOL_ORIGIN = "copilotkit-observed";

/**
 * Extract `EventWithState` from `Middleware.runNextWithState` return type so
 * we don't depend on a non-exported `@ag-ui/client` internal name.
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type EventWithState = ExtractObservableType<
  ReturnType<Middleware["runNextWithState"]>
>;

interface ToolCallBufferEntry {
  args: string;
  frontend: boolean;
  startTime: number;
  toolName: string;
}

interface PerRunState {
  outputBuffers: Map<string, string>;
  outputText: string;
  runId: string;
  startTime: number;
  toolCallBuffer: Map<string, ToolCallBufferEntry>;
  userInput: unknown;
  workflowId: string;
  workflowStarted: boolean;
}

/**
 * AG-UI Middleware subclass that observes every event in the agent run stream
 * and emits OpenBox governance events via `OpenBoxCopilotKitEmitter`.
 *
 * Default is telemetry-only. `opts.enforceApprovals: true` opts in to await
 * `client.evaluate` + `client.pollApproval` before each tool call; on a
 * block/halt verdict the middleware injects a redacted `governance_blocked`
 * error frame (via `governance-blocked-error.ts`) into the observable.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist for
 * labelling a tool call `frontend: true` (see plan risk H1 — multi-framework
 * runtimes cannot be inferred from observed `TOOL_CALL_*` alone).
 */
export class OpenBoxMiddleware extends Middleware {
  readonly #emitter: OpenBoxCopilotKitEmitter;
  readonly #enforceApprovals: boolean;
  readonly #frontendToolNames: string[] | undefined;
  readonly #isFrontendTool:
    | ((call: { name: string }) => boolean)
    | undefined;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #runtime: OpenBoxRuntimeController;

  public constructor(
    runtime: OpenBoxRuntimeController,
    opts: OpenBoxMiddlewareOptions = {}
  ) {
    super();
    this.#runtime = runtime;
    this.#logger = runtime.logger;
    this.#emitter = new OpenBoxCopilotKitEmitter(runtime, opts.onEvent);
    this.#enforceApprovals = opts.enforceApprovals === true;
    this.#frontendToolNames = opts.frontendToolNames;
    this.#isFrontendTool = opts.isFrontendTool;
  }

  public override run(
    input: RunAgentInput,
    next: AbstractAgent
  ): Observable<BaseEvent> {
    return this.#processStream(this.runNextWithState(input, next), input);
  }

  #processStream(
    source: Observable<EventWithState>,
    input: RunAgentInput
  ): Observable<BaseEvent> {
    return new Observable<BaseEvent>(subscriber => {
      const state: PerRunState = {
        outputBuffers: new Map(),
        outputText: "",
        runId: input.runId,
        startTime: Date.now(),
        toolCallBuffer: new Map(),
        userInput: extractLastUserMessage(input.messages),
        workflowId: input.threadId,
        workflowStarted: false
      };

      let blocked = false;
      let pendingHandling = Promise.resolve();

      const enqueueHandling = (work: () => Promise<void>): void => {
        pendingHandling = pendingHandling.then(work).catch((err: unknown) => {
          this.#logger.warn?.({
            err,
            note: "openbox middleware handler error swallowed",
            workflow_id: state.workflowId
          });
        });
      };

      const subscription = source.subscribe({
        next: eventWithState => {
          if (blocked) {
            return;
          }

          const event = eventWithState.event;

          enqueueHandling(async () => {
            const blockResult = await this.#handleEvent(state, event);
            if (blockResult) {
              blocked = true;
              subscriber.next(blockResult);
              subscriber.complete();
              return;
            }

            if (!blocked) {
              subscriber.next(event);
            }
          });
        },
        error: err => {
          enqueueHandling(async () => {
            await this.#emitWorkflowFailedFromError(state, err);
            subscriber.error(err);
          });
        },
        complete: () => {
          pendingHandling
            .then(() => {
              if (!blocked) {
                subscriber.complete();
              }
            })
            .catch((complErr: unknown) => {
              this.#logger.warn?.({
                err: complErr,
                note: "openbox middleware completion error swallowed",
                workflow_id: state.workflowId
              });
              subscriber.complete();
            });
        }
      });

      return () => {
        subscription.unsubscribe();
      };
    });
  }

  async #handleEvent(
    state: PerRunState,
    event: BaseEvent
  ): Promise<GovernanceBlockedErrorEvent | undefined> {
    const context = getOpenBoxExecutionContext();
    const goal = context?.goal;
    const agentId = context?.agentId ?? this.#runtime.defaults.agentId;
    const metadata = context?.metadata;

    switch (event.type) {
      case EventType.RUN_STARTED: {
        if (!state.workflowStarted) {
          state.workflowStarted = true;
          await this.#emitter.emitWorkflowStarted({
            agentId,
            goal,
            metadata,
            runId: state.runId,
            threadId: state.workflowId,
            userInput: state.userInput,
            workflowId: state.workflowId
          });
          await this.#emitter.emitSignalReceived({
            goal,
            metadata,
            payload: state.userInput,
            runId: state.runId,
            signalName: USER_INPUT_SIGNAL_NAME,
            workflowId: state.workflowId
          });
        }
        return undefined;
      }

      case EventType.TOOL_CALL_START: {
        const toolCall = event as BaseEvent & {
          toolCallId: string;
          toolCallName: string;
        };
        const frontend = this.#isFrontend({ name: toolCall.toolCallName });
        state.toolCallBuffer.set(toolCall.toolCallId, {
          args: "",
          frontend,
          startTime: Date.now(),
          toolName: toolCall.toolCallName
        });

        const verdict = await this.#emitter.emitActivityStarted({
          activityId: toolCall.toolCallId,
          agentId,
          frontend,
          goal,
          metadata,
          runId: state.runId,
          toolName: toolCall.toolCallName,
          toolOrigin: TOOL_ORIGIN,
          workflowId: state.workflowId
        });

        if (this.#enforceApprovals && shouldBlock(verdict)) {
          return createGovernanceBlockedErrorEvent(
            resolveCorrelationId(verdict)
          );
        }
        return undefined;
      }

      case EventType.TOOL_CALL_ARGS: {
        const argsEvent = event as BaseEvent & {
          delta: string;
          toolCallId: string;
        };
        const entry = state.toolCallBuffer.get(argsEvent.toolCallId);
        if (entry) {
          entry.args += argsEvent.delta;
        }
        return undefined;
      }

      case EventType.TOOL_CALL_END: {
        const endEvent = event as BaseEvent & { toolCallId: string };
        const entry = state.toolCallBuffer.get(endEvent.toolCallId);
        if (!entry) {
          return undefined;
        }
        state.toolCallBuffer.delete(endEvent.toolCallId);
        const endTime = Date.now();
        await this.#emitter.emitActivityCompleted({
          activityArgs: parseToolArgs(entry.args),
          activityId: endEvent.toolCallId,
          durationMs: Math.max(0, endTime - entry.startTime),
          endTime,
          goal,
          metadata,
          runId: state.runId,
          startTime: entry.startTime,
          status: "completed",
          toolName: entry.toolName,
          workflowId: state.workflowId
        });
        return undefined;
      }

      case EventType.TEXT_MESSAGE_START: {
        const startEvent = event as BaseEvent & { messageId: string };
        state.outputBuffers.set(startEvent.messageId, "");
        return undefined;
      }

      case EventType.TEXT_MESSAGE_CONTENT: {
        const contentEvent = event as BaseEvent & {
          delta: string;
          messageId: string;
        };
        const buffer = state.outputBuffers.get(contentEvent.messageId);
        if (buffer !== undefined) {
          state.outputBuffers.set(
            contentEvent.messageId,
            buffer + contentEvent.delta
          );
        }
        return undefined;
      }

      case EventType.TEXT_MESSAGE_END: {
        const endEvent = event as BaseEvent & { messageId: string };
        const text = state.outputBuffers.get(endEvent.messageId);
        if (text !== undefined) {
          state.outputBuffers.delete(endEvent.messageId);
          state.outputText += (state.outputText ? "\n" : "") + text;
        }
        return undefined;
      }

      case EventType.RUN_FINISHED: {
        const endTime = Date.now();
        await this.#emitter.emitSignalReceived({
          goal,
          metadata,
          payload: state.outputText,
          runId: state.runId,
          signalName: AGENT_OUTPUT_SIGNAL_NAME,
          workflowId: state.workflowId
        });
        await this.#emitter.emitWorkflowCompleted({
          agentOutput: state.outputText,
          durationMs: Math.max(0, endTime - state.startTime),
          endTime,
          goal,
          metadata,
          runId: state.runId,
          startTime: state.startTime,
          workflowId: state.workflowId
        });
        return undefined;
      }

      case EventType.RUN_ERROR: {
        const errorEvent = event as BaseEvent & {
          code?: string;
          message?: string;
        };
        await this.#emitter.emitWorkflowFailed({
          error: {
            code: errorEvent.code,
            message: errorEvent.message ?? "Run failed"
          },
          goal,
          metadata,
          runId: state.runId,
          workflowId: state.workflowId
        });
        return undefined;
      }

      default:
        return undefined;
    }
  }

  async #emitWorkflowFailedFromError(
    state: PerRunState,
    err: unknown
  ): Promise<void> {
    const context = getOpenBoxExecutionContext();
    await this.#emitter.emitWorkflowFailed({
      error: {
        message: err instanceof Error ? err.message : String(err),
        name: err instanceof Error ? err.name : "Error"
      },
      goal: context?.goal,
      metadata: context?.metadata,
      runId: state.runId,
      workflowId: state.workflowId
    });
  }

  #isFrontend(call: { name: string }): boolean {
    if (this.#isFrontendTool) {
      return this.#isFrontendTool(call);
    }
    if (this.#frontendToolNames?.includes(call.name)) {
      return true;
    }
    return false;
  }
}

/**
 * Factory for the AG-UI middleware. Required to expose the controller surface
 * without leaking the class itself (matches the public-API restriction in
 * the plan's acceptance criteria).
 */
export function createOpenBoxMiddleware(
  runtime: OpenBoxRuntimeController,
  opts: OpenBoxMiddlewareOptions = {}
): OpenBoxMiddleware {
  return new OpenBoxMiddleware(runtime, opts);
}

function extractLastUserMessage(
  messages: RunAgentInput["messages"] | undefined
): unknown {
  if (!Array.isArray(messages) || messages.length === 0) {
    return undefined;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      candidate !== undefined &&
      typeof candidate === "object" &&
      (candidate as { role?: string }).role === "user"
    ) {
      return candidate;
    }
  }
  return undefined;
}

function parseToolArgs(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function shouldBlock(verdict: GovernanceVerdictResponse | null): boolean {
  if (!verdict) {
    return false;
  }
  return Verdict.shouldStop(verdict.verdict);
}

function resolveCorrelationId(
  verdict: GovernanceVerdictResponse | null
): string {
  return verdict?.governanceEventId ?? verdict?.approvalId ?? "unknown";
}
