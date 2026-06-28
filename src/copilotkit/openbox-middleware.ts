import {
  EventType,
  Middleware,
  type AbstractAgent,
  type BaseEvent,
  type RunAgentInput
} from "@ag-ui/client";
import { Observable } from "rxjs";

import { OpenBoxClient } from "../client/openbox-client.js";
import { getOpenBoxExecutionContext } from "../governance/context.js";
import { OpenBoxConfigError } from "../types/errors.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { Verdict } from "../types/verdict.js";

import {
  createGovernanceBlockedErrorEvent,
  type GovernanceBlockedErrorEvent
} from "./governance-blocked-error.js";
import {
  AGENT_OUTPUT_SIGNAL_NAME,
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  OpenBoxCopilotKitEmitter,
  USER_INPUT_SIGNAL_NAME
} from "./openbox-emitter.js";
import type {
  MultiAgentSessionContext,
  OpenBoxMiddlewareOptions,
  OpenBoxMultiAgentContext,
  OpenBoxMultiAgentOptions,
  OpenBoxObservedToolCall,
  OpenBoxRuntimeController,
  OpenBoxSubagentHandoffConfig
} from "./types.js";

const TOOL_ORIGIN = "copilotkit-observed";
const TOOL_CALL_RESULT_EVENT_TYPE = "TOOL_CALL_RESULT";

/**
 * Extract `EventWithState` from `Middleware.runNextWithState` return type so
 * we don't depend on a non-exported `@ag-ui/client` internal name.
 */
type ExtractObservableType<T> = T extends Observable<infer U> ? U : never;
type EventWithState = ExtractObservableType<
  ReturnType<Middleware["runNextWithState"]>
>;

interface ToolCallBufferEntry {
  activityArgs?: unknown;
  activityStarted: boolean;
  args: string;
  completed: boolean;
  endTime?: number;
  frontend: boolean;
  startTime: number;
  toolName: string;
}

interface PerRunState {
  // Dedup keys for already-emitted handoffs:
  // `${multiAgentSessionId}::${fromAgentDid}::${childAgentName}::${parentActivityId}`.
  emittedHandoffs: Set<string>;
  // Resolved once per run when multi-agent mode is enabled; undefined disables
  // every multi-agent emission for this run.
  multiAgentSessionId: string | undefined;
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
 * `client.evaluate` + `client.pollApproval` once tool args are complete; on a
 * block/halt verdict the middleware injects a redacted `governance_blocked`
 * error frame (via `governance-blocked-error.ts`) into the observable.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist for
 * labelling a tool call `frontend: true` (see plan risk H1 — multi-framework
 * runtimes cannot be inferred from observed `TOOL_CALL_*` alone).
 */
export class OpenBoxMiddleware extends Middleware {
  // Lazily-built OpenBoxClients scoped to each child agent's identity, keyed by
  // child DID. Reused across delegations within this middleware instance so the
  // Ed25519 seed is parsed once per child.
  readonly #childClientCache = new Map<string, OpenBoxClient>();
  readonly #emitter: OpenBoxCopilotKitEmitter;
  readonly #enforceApprovals: boolean;
  readonly #frontendToolNames: string[] | undefined;
  readonly #isFrontendTool:
    | ((call: { name: string }) => boolean)
    | undefined;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #multiAgent: OpenBoxMultiAgentOptions | undefined;
  readonly #multiAgentEnabled: boolean;
  readonly #parentAgentDid: string | undefined;
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

    this.#multiAgent = opts.multiAgent;
    this.#multiAgentEnabled = opts.multiAgent?.enabled === true;
    this.#parentAgentDid =
      opts.multiAgent?.parentAgentDid ?? runtime.client.agentDid;

    // Fail fast: multi-agent mode needs a parent DID to populate
    // `from_agent_did` on the Handoff. Without it Core would reject the marker.
    if (this.#multiAgentEnabled && !this.#parentAgentDid) {
      throw new OpenBoxConfigError(
        "OpenBox multi-agent mode is enabled but no parent agent DID is available. " +
          "Set middlewareOptions.multiAgent.parentAgentDid or configure the runtime agentDid/agentPrivateKey."
      );
    }
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
        emittedHandoffs: new Set(),
        multiAgentSessionId: this.#resolveMultiAgentSessionId(
          input.runId,
          input.threadId
        ),
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

    if (isToolCallResultEvent(event)) {
      const resultEvent = event as BaseEvent & {
        toolCallId?: string | undefined;
      };
      if (!resultEvent.toolCallId) {
        return undefined;
      }
      const entry = state.toolCallBuffer.get(resultEvent.toolCallId);
      if (!entry) {
        return undefined;
      }
      entry.activityArgs ??= parseToolArgs(entry.args);
      entry.endTime = Date.now();
      const blockResult = await this.#emitActivityStartedIfNeeded({
        activityId: resultEvent.toolCallId,
        agentId,
        entry,
        goal,
        metadata,
        state
      });
      if (blockResult) {
        return blockResult;
      }
      await this.#emitActivityCompleted({
        activityId: resultEvent.toolCallId,
        activityOutput: extractToolResultOutput(resultEvent),
        entry,
        goal,
        metadata,
        state,
        status: "completed"
      });
      state.toolCallBuffer.delete(resultEvent.toolCallId);
      return undefined;
    }

    switch (event.type) {
      case EventType.RUN_STARTED: {
        if (!state.workflowStarted) {
          state.workflowStarted = true;
          await this.#emitter.emitWorkflowStarted({
            agentId,
            goal,
            metadata,
            multiAgentSessionId: state.multiAgentSessionId,
            runId: state.runId,
            threadId: state.workflowId,
            userInput: state.userInput,
            workflowId: state.workflowId
          });
          await this.#emitter.emitSignalReceived({
            goal,
            metadata,
            multiAgentSessionId: state.multiAgentSessionId,
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
          activityStarted: false,
          args: "",
          completed: false,
          frontend,
          startTime: Date.now(),
          toolName: toolCall.toolCallName
        });
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
        entry.activityArgs = parseToolArgs(entry.args);
        entry.endTime = Date.now();
        const blockResult = await this.#emitActivityStartedIfNeeded({
          activityId: endEvent.toolCallId,
          agentId,
          entry,
          goal,
          metadata,
          state
        });
        if (blockResult) {
          return blockResult;
        }
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
        const blockResult = await this.#flushPendingToolCalls({
          agentId,
          goal,
          metadata,
          state
        });
        if (blockResult) {
          return blockResult;
        }
        await this.#emitter.emitSignalReceived({
          goal,
          metadata,
          multiAgentSessionId: state.multiAgentSessionId,
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
          multiAgentSessionId: state.multiAgentSessionId,
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
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          workflowId: state.workflowId
        });
        return undefined;
      }

      default:
        return undefined;
    }
  }

  async #flushPendingToolCalls({
    agentId,
    goal,
    metadata,
    state
  }: {
    agentId?: string | undefined;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    for (const [activityId, entry] of state.toolCallBuffer) {
      entry.activityArgs ??= parseToolArgs(entry.args);
      entry.endTime ??= Date.now();
      const blockResult = await this.#emitActivityStartedIfNeeded({
        activityId,
        agentId,
        entry,
        goal,
        metadata,
        state
      });
      if (blockResult) {
        return blockResult;
      }
      await this.#emitActivityCompleted({
        activityId,
        entry,
        goal,
        metadata,
        state,
        status: "completed"
      });
      state.toolCallBuffer.delete(activityId);
    }
    return undefined;
  }

  async #emitActivityStartedIfNeeded({
    activityId,
    agentId,
    entry,
    goal,
    metadata,
    state
  }: {
    activityId: string;
    agentId?: string | undefined;
    entry: ToolCallBufferEntry;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    if (entry.activityStarted) {
      return undefined;
    }
    const verdict = await this.#emitter.emitActivityStarted({
      activityArgs: entry.activityArgs,
      activityId,
      agentId,
      frontend: entry.frontend,
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      toolName: entry.toolName,
      toolOrigin: TOOL_ORIGIN,
      workflowId: state.workflowId
    });
    entry.activityStarted = true;
    if (this.#enforceApprovals && shouldBlock(verdict)) {
      return createGovernanceBlockedErrorEvent(resolveCorrelationId(verdict));
    }
    // A blocked delegation never hands off; the Handoff is emitted only after a
    // non-blocking parent ActivityStarted, mirroring the expected sequence
    // (parent ActivityStarted → child Handoff → child WorkflowStarted).
    await this.#maybeEmitHandoff({ activityId, entry, state });
    return undefined;
  }

  async #emitActivityCompleted({
    activityId,
    activityOutput,
    entry,
    goal,
    metadata,
    state,
    status
  }: {
    activityId: string;
    activityOutput?: unknown;
    entry: ToolCallBufferEntry;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): Promise<void> {
    if (entry.completed) {
      return;
    }
    const endTime = entry.endTime ?? Date.now();
    await this.#emitter.emitActivityCompleted({
      activityArgs: entry.activityArgs,
      activityId,
      ...(activityOutput !== undefined ? { activityOutput } : {}),
      durationMs: Math.max(0, endTime - entry.startTime),
      endTime,
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      startTime: entry.startTime,
      status,
      toolName: entry.toolName,
      workflowId: state.workflowId
    });
    entry.completed = true;
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
      multiAgentSessionId: state.multiAgentSessionId,
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

  #resolveMultiAgentSessionId(
    runId: string,
    workflowId: string
  ): string | undefined {
    if (!this.#multiAgentEnabled) {
      return undefined;
    }
    const configured = this.#multiAgent?.multiAgentSessionId;
    if (typeof configured === "function") {
      return configured(this.#sessionContext(runId, workflowId));
    }
    if (typeof configured === "string" && configured.length > 0) {
      return configured;
    }
    // Prefixed default so the value is not mistaken for a Temporal run id.
    return `mas:${runId}`;
  }

  #sessionContext(
    runId: string,
    workflowId: string
  ): MultiAgentSessionContext {
    return {
      parentAgentDid: this.#parentAgentDid ?? "",
      runId,
      threadId: workflowId,
      workflowId
    };
  }

  #resolveHandoffConfig(
    call: OpenBoxObservedToolCall,
    state: PerRunState
  ): OpenBoxSubagentHandoffConfig | undefined {
    const ctx = this.#sessionContext(state.runId, state.workflowId);
    const dynamic = this.#multiAgent?.resolveHandoff?.(call, ctx);
    if (dynamic) {
      return dynamic;
    }
    return this.#multiAgent?.handoffTools?.[call.name];
  }

  /**
   * If the just-started activity maps to a configured subagent, emit exactly
   * one `Handoff` per delegation. Sent as the child agent (so Core resolves
   * `to_agent` correctly) when child credentials are configured; otherwise the
   * prepared `OpenBoxMultiAgentContext` is surfaced via `onEvent` for a remote
   * child to emit. Fully isolated from the event pipeline — never throws.
   */
  async #maybeEmitHandoff({
    activityId,
    entry,
    state
  }: {
    activityId: string;
    entry: ToolCallBufferEntry;
    state: PerRunState;
  }): Promise<void> {
    try {
      if (!this.#multiAgentEnabled || !state.multiAgentSessionId) {
        return;
      }
      const parentAgentDid = this.#parentAgentDid;
      if (!parentAgentDid) {
        return;
      }

      const config = this.#resolveHandoffConfig(
        { args: entry.activityArgs, name: entry.toolName, toolCallId: activityId },
        state
      );
      if (!config) {
        return;
      }

      const childAgentName = config.childAgentName ?? entry.toolName;
      const dedupeKey = `${state.multiAgentSessionId}::${parentAgentDid}::${childAgentName}::${activityId}`;
      if (state.emittedHandoffs.has(dedupeKey)) {
        return;
      }
      state.emittedHandoffs.add(dedupeKey);

      const multiAgentContext: OpenBoxMultiAgentContext = {
        multiAgentSessionId: state.multiAgentSessionId,
        parentActivityId: activityId,
        parentAgentDid,
        parentRunId: state.runId,
        parentWorkflowId: state.workflowId
      };

      const handoffMetadata: Record<string, unknown> = {
        child_agent_name: childAgentName,
        ...(config.childTaskQueue
          ? { child_task_queue: config.childTaskQueue }
          : {}),
        ...(config.childWorkflowType
          ? { child_workflow_type: config.childWorkflowType }
          : {}),
        delegate_tool_name: entry.toolName,
        openbox_multi_agent_context: multiAgentContext,
        parent_activity_id: activityId,
        parent_workflow_id: state.workflowId
      };

      const childClient = this.#buildChildClient(config);
      if (!childClient) {
        this.#logger.debug?.({
          multi_agent_session_id: state.multiAgentSessionId,
          note: "openbox multi-agent: handoff context prepared without child credentials — a remote child runtime must emit the Handoff",
          workflow_id: state.workflowId
        });
      }

      await this.#emitter.emitHandoff(
        {
          fromAgentDid: parentAgentDid,
          metadata: handoffMetadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          taskQueue: COPILOTKIT_TASK_QUEUE,
          workflowId: state.workflowId,
          workflowType: COPILOTKIT_WORKFLOW_TYPE
        },
        childClient
      );
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: handoff emission failed — swallowed",
        workflow_id: state.workflowId
      });
    }
  }

  #buildChildClient(
    config: OpenBoxSubagentHandoffConfig
  ): OpenBoxClient | undefined {
    const { childAgentDid, childAgentPrivateKey, childApiKey } = config;
    if (!childApiKey || !childAgentDid || !childAgentPrivateKey) {
      return undefined;
    }

    const cached = this.#childClientCache.get(childAgentDid);
    if (cached) {
      return cached;
    }

    try {
      const parent = this.#runtime.client;
      const childClient = new OpenBoxClient({
        agentDid: childAgentDid,
        agentPrivateKey: childAgentPrivateKey,
        apiKey: childApiKey,
        apiUrl: parent.apiUrl,
        evaluateMaxRetries: parent.evaluateMaxRetries,
        evaluateRetryBaseDelayMs: parent.evaluateRetryBaseDelayMs,
        onApiError: parent.onApiError,
        timeoutSeconds: parent.timeoutSeconds
      });
      this.#childClientCache.set(childAgentDid, childClient);
      return childClient;
    } catch (err) {
      // Bad child DID/key must not crash the run — degrade to context-export.
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: failed to build child-scoped client (check child DID / private key) — falling back to context-export only"
      });
      return undefined;
    }
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

function isToolCallResultEvent(event: BaseEvent): boolean {
  return String(event.type) === TOOL_CALL_RESULT_EVENT_TYPE;
}

function extractToolResultOutput(event: BaseEvent): unknown {
  const record = event as unknown as Record<string, unknown>;
  for (const key of ["result", "output", "content", "value", "data"]) {
    if (Object.prototype.hasOwnProperty.call(record, key)) {
      return parseMaybeJsonString(record[key]);
    }
  }
  return undefined;
}

function parseMaybeJsonString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
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
