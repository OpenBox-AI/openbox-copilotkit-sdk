import {
  EventType,
  Middleware,
  type AbstractAgent,
  type BaseEvent,
  type RunAgentInput,
  type RunFinishedEvent
} from "@ag-ui/client";
import type { OnApiError } from "@openbox-ai/openbox-sdk-ts/config";
import { Observable } from "rxjs";

import { attachAuditEnvelope } from "../audit/audit-envelope.js";
import { OpenBoxClient } from "../client/openbox-client.js";
import { getOpenBoxExecutionContext } from "../governance/context.js";
import type { SpanData } from "../spans/index.js";
import { readSpanBufferEnv, type SpanBuffer } from "../spans/span-buffer.js";
import {
  synthesizeToolSpan,
  type ToolCallArgsEventLike
} from "../spans/tool-span-synthesizer.js";
import { OpenBoxConfigError } from "../types/errors.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { Verdict } from "../types/verdict.js";

import {
  createGovernanceBlockedErrorEvent,
  type GovernanceBlockedErrorEvent
} from "./governance-blocked-error.js";
import { DEFAULT_INTERRUPT_TTL_MS, type PendingInterrupt } from "./internal/interrupt-store.js";
import {
  AGENT_OUTPUT_SIGNAL_NAME,
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  OpenBoxCopilotKitEmitter,
  USER_INPUT_SIGNAL_NAME
} from "./openbox-emitter.js";
import {
  parseResumeEntries,
  parseRunOutcome,
  type ParsedInterrupt,
  type ParsedResumeEntry
} from "./run-outcome.js";
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
// Fallback tool name for a persisted interrupt whose id has no corresponding
// entry in this run's tool-call buffer (RT-F5 non-BuiltInAgent shape — the
// interrupt's own `id` never matches a buffered `toolCallId` there). Cosmetic
// only: it never affects RT-F5 correlation, which always keys on `id`.
const UNKNOWN_INTERRUPT_TOOL_NAME = "unknown";

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
  argsDeltas: ToolCallArgsEventLike[];
  completed: boolean;
  endTime?: number;
  frontend: boolean;
  lastVerdict?: GovernanceVerdictResponse | null;
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
  // The interrupted run's id, when THIS run is a resume (RT-F5) — read off
  // `RunAgentInput.parentRunId` once at run start. `undefined` for a normal
  // (non-resume) run.
  parentRunId: string | undefined;
  // Parsed once (at run start) from `RunAgentInput.forwardedProps.resume` —
  // non-empty exactly when this run is resuming one or more prior interrupts.
  resumeEntries: ParsedResumeEntry[];
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
 * labelling a tool call `frontend: true`.
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
  readonly #redactPaths: string[] | undefined;
  readonly #runtime: OpenBoxRuntimeController;
  readonly #spanBuffer: SpanBuffer | undefined;
  readonly #spanSynthesisDisabled: boolean;

  public constructor(
    runtime: OpenBoxRuntimeController,
    opts: OpenBoxMiddlewareOptions = {}
  ) {
    super();
    this.#runtime = runtime;
    this.#logger = runtime.logger;
    this.#emitter = new OpenBoxCopilotKitEmitter(runtime, opts.onEvent, opts.redactPaths);
    this.#enforceApprovals = opts.enforceApprovals === true;
    this.#frontendToolNames = opts.frontendToolNames;
    this.#isFrontendTool = opts.isFrontendTool;
    this.#redactPaths = opts.redactPaths;
    this.#spanBuffer = opts.spanBuffer;
    this.#spanSynthesisDisabled = readSpanBufferEnv().disabled;

    this.#multiAgent = opts.multiAgent;
    this.#multiAgentEnabled = opts.multiAgent?.enabled === true;
    this.#parentAgentDid =
      opts.multiAgent?.parentAgentDid ?? runtime.runtime.config.agentDid ?? undefined;

    // Fail fast: multi-agent mode needs a parent DID to populate
    // `from_agent_did` on the Handoff. Without it OpenBox rejects the marker.
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
        parentRunId: input.parentRunId,
        resumeEntries: parseResumeEntries(input),
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
          // RT-F4: a genuine governance/control error must never be
          // laundered into a silent warn-and-continue — that would fail OPEN
          // on an enforcement decision. Nothing reaches this catch from
          // either of the two paths that make an enforcement decision today:
          // the frontend-tool gate below is RETURN-based (a block resolves
          // to `blockResult`, handled in `next` and never thrown), and every
          // telemetry send failure is isolated INSIDE the bounded queue
          // (`lifecycle-telemetry.ts`'s `failedTelemetrySends` +
          // `onDiagnostic`) — `#emitter.emit*()` never propagates a rejected
          // `evaluate` out to its caller. This catch is therefore a true
          // last-resort for an unrelated bug, not a place governance
          // decisions can be silently swallowed.
          this.#logger.warn?.({
            err,
            note: "openbox middleware handler error swallowed",
            workflow_id: state.workflowId
          });
        });
      };

      // Bind the per-run context store (D7) for the entire async lifetime of
      // this subscription — wrapping `source.subscribe` (not `run()`'s body
      // and not the RUN_STARTED handler) so `currentRunContext()` is
      // available to the tool-execution async chain the subscribe() call
      // sets up (Phase 5 reads it). Two concurrent runs never cross-observe
      // each other's ids (standard `AsyncLocalStorage` isolation).
      const subscription = this.#runtime.runContext.enterRunContext(
        { runId: input.runId, workflowId: input.threadId },
        () =>
          source.subscribe({
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
          })
      );

      return () => {
        subscription.unsubscribe();
        // Defensive, idempotent cleanup of the queue's per-run truncation
        // flag for a run that never reaches a terminal telemetry event —
        // e.g. an early client-disconnect unsubscribe. The normal case
        // (terminal event observed) already clears it inside the queue
        // itself; the queue's chain-map bookkeeping self-cleans separately
        // once a run's own last send settles, regardless of this call.
        this.#runtime.telemetryQueue.endRun(state.runId);
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
        agentId,
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
            // In multi-agent mode the signal is array-shaped for the OpenBox
            // timeline; pass the user's text so element 0 renders cleanly
            // instead of a JSON-stringified message object.
            payload: state.multiAgentSessionId
              ? extractUserText(state.userInput)
              : state.userInput,
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
          argsDeltas: [],
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
          entry.argsDeltas.push({
            delta: argsEvent.delta,
            toolCallId: argsEvent.toolCallId
          });
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
        return this.#handleRunFinished({
          agentId,
          endTime: Date.now(),
          event: event as RunFinishedEvent,
          goal,
          metadata,
          state
        });
      }

      case EventType.RUN_ERROR: {
        const errorEvent = event as BaseEvent & {
          code?: string;
          message?: string;
        };
        const error = {
          code: errorEvent.code,
          message: errorEvent.message ?? "Run failed"
        };
        const blockResult = await this.#flushPendingToolCalls({
          agentId,
          error,
          goal,
          metadata,
          state,
          status: "failed"
        });
        if (blockResult) {
          return blockResult;
        }
        await this.#emitter.emitWorkflowFailed({
          error,
          goal,
          metadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          workflowId: state.workflowId
        });
        this.#clearRunOnTerminal(state);
        return undefined;
      }

      default:
        return undefined;
    }
  }

  /**
   * `RUN_FINISHED` dispatcher (fixes B3). Outcome is parsed BEFORE any
   * flush. Order: resume correlation first — it closes out an ORIGINAL
   * (interrupted) run's dangling activity and is independent of THIS run's
   * own outcome — then interrupt (pending + one signal, no completion) or
   * success (unchanged pre-Phase-4 flush + signal + `WorkflowCompleted`).
   * Every branch ends in `#clearRunOnTerminal` (RT-F14).
   */
  async #handleRunFinished({
    agentId,
    endTime,
    event,
    goal,
    metadata,
    state
  }: {
    agentId?: string | undefined;
    endTime: number;
    event: RunFinishedEvent;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<GovernanceBlockedErrorEvent | undefined> {
    if (state.resumeEntries.length > 0) {
      const unresolvable = await this.#connectResumeEntries({ endTime, goal, metadata, state });
      if (unresolvable) {
        // RT-F9: a resume that cannot be correlated is a typed failure —
        // never a fabricated completion. Stop here; do not also evaluate
        // this run's own outcome.
        this.#clearRunOnTerminal(state);
        return undefined;
      }
    }

    const outcome = parseRunOutcome(event, this.#redactPaths);

    if (outcome.kind === "interrupt") {
      await this.#handleInterruptOutcome({ interrupts: outcome.interrupts, state });
      // Keep this run's just-saved pending interrupts — a later resume run
      // reads them back via `interruptStore.take` (RT-F9).
      this.#clearRunOnTerminal(state, { keepInterrupts: true });
      return undefined;
    }

    // Success (outcome undefined or {type:"success"}) — unchanged
    // pre-Phase-4 behavior: flush any frontend-only tool call (no
    // TOOL_CALL_RESULT companion event exists for those), then signal +
    // complete exactly once.
    const blockResult = await this.#flushPendingToolCalls({
      agentId,
      goal,
      metadata,
      state,
      status: "completed"
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
    this.#runtime.runTerminalState.markOutputEmitted(state.runId);
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
    this.#clearRunOnTerminal(state);
    return undefined;
  }

  /**
   * Interrupt outcome (fixes B3): persist one `PendingInterrupt` snapshot
   * per interrupt — keyed on the interrupt's own `id`, NEVER `toolCallId`
   * (RT-F5) — emit ONE `copilotkit_interrupt` signal, and mark the run
   * interrupted. Deliberately does NOT touch `state.toolCallBuffer`: every
   * buffered (unresolved) tool call stays PENDING because the run is
   * suspended, not finished — no `ActivityCompleted`, no `WorkflowCompleted`.
   */
  async #handleInterruptOutcome({
    interrupts,
    state
  }: {
    interrupts: readonly ParsedInterrupt[];
    state: PerRunState;
  }): Promise<void> {
    const pending: PendingInterrupt[] = interrupts.map(interrupt => {
      // Best-effort cosmetic lookup only (toolName/args/startTime for the
      // eventual resume completion) — NEVER used for correlation, which
      // always keys on `interrupt.id` alone (RT-F5). Absent on the
      // non-BuiltInAgent shape, where the interrupt carries no `toolCallId`
      // and its `id` never matches a buffered `toolCallId` either.
      const buffered = state.toolCallBuffer.get(interrupt.toolCallId ?? interrupt.id);
      return {
        activityId: interrupt.id,
        ...(buffered?.activityArgs !== undefined
          ? { activityArgs: buffered.activityArgs }
          : {}),
        ...(state.multiAgentSessionId !== undefined
          ? { multiAgentSessionId: state.multiAgentSessionId }
          : {}),
        ...(interrupt.message !== undefined ? { message: interrupt.message } : {}),
        reason: interrupt.reason,
        ...(buffered !== undefined ? { startTime: buffered.startTime } : {}),
        toolName: buffered?.toolName ?? UNKNOWN_INTERRUPT_TOOL_NAME,
        workflowId: state.workflowId
      };
    });

    this.#runtime.interruptStore.save(state.runId, pending, DEFAULT_INTERRUPT_TTL_MS);
    this.#runtime.runTerminalState.markInterrupted(state.runId);

    await this.#emitter.emitInterruptSignal({
      interruptIds: interrupts.map(i => i.id),
      messages: interrupts.map(i => i.message),
      multiAgentSessionId: state.multiAgentSessionId,
      reasons: interrupts.map(i => i.reason),
      responseSchemas: interrupts.map(i => i.responseSchema),
      runId: state.runId,
      workflowId: state.workflowId
    });
  }

  /**
   * Correlate every resume entry against the interrupt-persistence port
   * (RT-F5 — keyed on `interruptId`, i.e. the ORIGINAL interrupt's own
   * `id`), looked up under the ORIGINAL (interrupted) run's id —
   * `parentRunId` when present, else this run's own id. On a match: emit a
   * correcting `ActivityCompleted` attributed to the ORIGINAL run/workflow
   * ids (closing out the activity left dangling when it interrupted), with
   * `status` mapped from `resume.status` (`resolved` -> `completed`,
   * `cancelled` -> `aborted`) and `resume.payload` as the output. On a miss
   * (never interrupted, already resumed, or TTL-expired): emit a typed
   * `workflowFailed` and return `true` — RT-F9 forbids fabricating a
   * completion. Returns `true` on the FIRST unresolvable entry (stops the
   * loop — a run's own outcome is never evaluated after a resume failure).
   */
  async #connectResumeEntries({
    endTime,
    goal,
    metadata,
    state
  }: {
    endTime: number;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
  }): Promise<boolean> {
    const originalRunId = state.parentRunId ?? state.runId;

    for (const entry of state.resumeEntries) {
      const pending = this.#runtime.interruptStore.take(originalRunId, entry.interruptId);
      if (!pending) {
        await this.#emitter.emitWorkflowFailed({
          error: {
            message: `Resume references an unknown or expired interrupt id: ${entry.interruptId}`,
            name: "OpenBoxInterruptResumeCorrelationError"
          },
          goal,
          metadata,
          multiAgentSessionId: state.multiAgentSessionId,
          runId: state.runId,
          workflowId: state.workflowId
        });
        return true;
      }

      await this.#emitter.emitActivityCompleted({
        ...(pending.activityArgs !== undefined ? { activityArgs: pending.activityArgs } : {}),
        activityId: pending.activityId,
        ...(entry.payload !== undefined ? { activityOutput: entry.payload } : {}),
        ...(pending.startTime !== undefined
          ? {
              durationMs: Math.max(0, endTime - pending.startTime),
              startTime: pending.startTime
            }
          : {}),
        endTime,
        goal,
        metadata,
        ...(pending.multiAgentSessionId !== undefined
          ? { multiAgentSessionId: pending.multiAgentSessionId }
          : {}),
        runId: originalRunId,
        status: entry.status === "resolved" ? "completed" : "aborted",
        toolName: pending.toolName,
        workflowId: pending.workflowId
      });
    }

    return false;
  }

  /**
   * RT-F14 terminal cleanup — called on every RUN_FINISHED/RUN_ERROR path.
   * `contextStore.clearHalt` bounds the BASE per-run HALT set: the base has
   * no stop-signal FIFO, so a finished run's HALT entry would otherwise
   * live until process shutdown; this consumer owns clearing it once the
   * run's stream is truly over, regardless of outcome kind.
   * `interruptStore.clearRun` is SKIPPED when `keepInterrupts` is set — an
   * interrupt outcome persists fresh entries in this SAME call, and a later
   * resume run must still be able to `take()` them back.
   */
  #clearRunOnTerminal(
    state: PerRunState,
    opts: { keepInterrupts?: boolean } = {}
  ): void {
    this.#runtime.runtime.contextStore.clearHalt(state.workflowId, state.runId);
    if (!opts.keepInterrupts) {
      this.#runtime.interruptStore.clearRun(state.runId);
    }
  }

  /**
   * Flush every still-buffered (unresolved) tool call with the given
   * terminal `status`. Used by BOTH the success path (`status: "completed"`
   * — frontend tools never produce a `TOOL_CALL_RESULT`, so RUN_FINISHED is
   * their only completion point) and the RUN_ERROR/source-error paths
   * (`status: "failed"`, carrying the run's own `error`). NEVER called for
   * an interrupt outcome — an interrupted run's buffered calls must stay
   * PENDING (fixes B3; see `#handleInterruptOutcome`).
   */
  async #flushPendingToolCalls({
    agentId,
    error,
    goal,
    metadata,
    state,
    status
  }: {
    agentId?: string | undefined;
    error?: Record<string, unknown> | undefined;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
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
        agentId,
        entry,
        ...(error !== undefined ? { error } : {}),
        goal,
        metadata,
        state,
        status
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
    // Phase 4/5: buffer frontend-enforce triple (hold TOOL_CALL_START/ARGS/END
    // together until the verdict resolves, not END-only) — deferred; the
    // enforcing gate below is unchanged from before this phase.
    const verdict = await this.#emitter.emitActivityStarted(
      {
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
      },
      { enforce: this.#enforceApprovals }
    );
    entry.activityStarted = true;
    entry.lastVerdict = verdict;
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
    agentId,
    entry,
    error,
    goal,
    metadata,
    state,
    status
  }: {
    activityId: string;
    activityOutput?: unknown;
    agentId?: string | undefined;
    entry: ToolCallBufferEntry;
    error?: Record<string, unknown> | undefined;
    goal?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): Promise<void> {
    if (entry.completed) {
      return;
    }
    const endTime = entry.endTime ?? Date.now();
    const span = this.#synthesizeToolSpanOrNull({
      activityId,
      activityOutput,
      endTime,
      entry,
      state,
      status
    });
    await this.#emitter.emitActivityCompleted({
      activityArgs: entry.activityArgs,
      activityId,
      ...(activityOutput !== undefined ? { activityOutput } : {}),
      durationMs: Math.max(0, endTime - entry.startTime),
      endTime,
      ...(error !== undefined ? { error } : {}),
      goal,
      metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      startTime: entry.startTime,
      status,
      toolName: entry.toolName,
      workflowId: state.workflowId
    });
    if (span) {
      await this.#emitter.emitActivityCompletedHook({
        activityArgs: entry.activityArgs,
        activityId,
        agentId,
        durationMs: Math.max(0, endTime - entry.startTime),
        endTime,
        goal,
        metadata,
        runId: state.runId,
        span,
        startTime: entry.startTime,
        workflowId: state.workflowId
      });
      this.#spanBuffer?.append(state.workflowId, span);
    }
    entry.completed = true;
  }

  #synthesizeToolSpanOrNull({
    activityId,
    activityOutput,
    endTime,
    entry,
    state,
    status
  }: {
    activityId: string;
    activityOutput?: unknown;
    endTime: number;
    entry: ToolCallBufferEntry;
    state: PerRunState;
    status: "completed" | "failed" | "aborted";
  }): SpanData | null {
    if (this.#spanSynthesisDisabled || !this.#spanBuffer) {
      return null;
    }
    try {
      const span = synthesizeToolSpan(
        {
          activityId,
          args: entry.argsDeltas,
          attempt: 0,
          end: {
            toolCallId: activityId,
            ...(activityOutput !== undefined ? { result: activityOutput } : {})
          },
          endTimeUnixNano: BigInt(endTime) * 1_000_000n,
          runId: state.runId,
          start: {
            toolCallId: activityId,
            toolCallName: entry.toolName
          },
          startTimeUnixNano: BigInt(entry.startTime) * 1_000_000n,
          workflowId: state.workflowId
        },
        {
          isError: status !== "completed",
          ...(this.#redactPaths ? { redactPaths: this.#redactPaths } : {})
        }
      );

      attachAuditEnvelope(span, {
        activityId,
        attempt: 0,
        enforcementStatus: "pre_execution_allowed",
        gateway: "agui_event",
        ...(entry.lastVerdict?.policyId
          ? { policyVersion: entry.lastVerdict.policyId }
          : {}),
        runId: state.runId,
        workflowId: state.workflowId
      });

      return span;
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox tool-span synthesis failed",
        workflow_id: state.workflowId
      });
      return null;
    }
  }

  async #emitWorkflowFailedFromError(
    state: PerRunState,
    err: unknown
  ): Promise<void> {
    const context = getOpenBoxExecutionContext();
    const error = {
      message: err instanceof Error ? err.message : String(err),
      name: err instanceof Error ? err.name : "Error"
    };
    // Flush unresolved activities as failed before the workflow failure
    // (mirrors the RUN_ERROR path). A governance block surfaced by this
    // flush has nowhere meaningful to go here — the source stream is
    // already erroring and `subscriber.error(err)` follows unconditionally
    // in the caller — so its return value is intentionally not applied to
    // a client-visible event; Core still sees a failed completion per
    // dangling activity.
    await this.#flushPendingToolCalls({
      error,
      goal: context?.goal,
      metadata: context?.metadata,
      state,
      status: "failed"
    });
    await this.#emitter.emitWorkflowFailed({
      error,
      goal: context?.goal,
      metadata: context?.metadata,
      multiAgentSessionId: state.multiAgentSessionId,
      runId: state.runId,
      workflowId: state.workflowId
    });
    this.#clearRunOnTerminal(state);
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
    // Prefix the default so it is distinguishable from raw provider run ids.
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

  #forwardMultiAgentContext(
    ctx: OpenBoxMultiAgentContext,
    state: PerRunState
  ): Record<string, unknown> | undefined {
    const adapter = this.#multiAgent?.forwardContext;
    if (!adapter) {
      return undefined;
    }
    try {
      return adapter(ctx) ?? undefined;
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox multi-agent: forwardContext adapter threw — swallowed",
        workflow_id: state.workflowId
      });
      return undefined;
    }
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

      // Hand the context to the operator's forwarding adapter (e.g. to stash it
      // for the delegate tool to set on the child's RuntimeContext).
      const forwarded = this.#forwardMultiAgentContext(multiAgentContext, state);

      const handoffMetadata: Record<string, unknown> = {
        child_agent_name: childAgentName,
        ...(config.childTaskQueue
          ? { child_task_queue: config.childTaskQueue }
          : {}),
        ...(config.childWorkflowType
          ? { child_workflow_type: config.childWorkflowType }
          : {}),
        delegate_tool_name: entry.toolName,
        ...(forwarded ? { forwarded_context: forwarded } : {}),
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
      // The base `OpenBoxClient` has no public props to read (RT-F6) — source
      // the shared fields from the resolved base config instead. Base config
      // has no retry concept, so `evaluateMaxRetries`/`evaluateRetryBaseDelayMs`
      // are not translated here (Phase 2 does not carry these legacy fields
      // into the runtime at all; full alias translation is Phase 6) and the
      // legacy child client's own defaults apply.
      const parentConfig = this.#runtime.runtime.config;
      const childClient = new OpenBoxClient({
        agentDid: childAgentDid,
        agentPrivateKey: childAgentPrivateKey,
        apiKey: childApiKey,
        apiUrl: parentConfig.apiUrl,
        onApiError: toLegacyApiErrorPolicy(parentConfig.onApiError),
        timeoutSeconds: parentConfig.timeoutSeconds
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

/** Factory for the AG-UI middleware. */
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

/**
 * Reduce a user message to its text content for the array-shaped timeline
 * signal. Falls back to the original value when content is not a plain string
 * (e.g. multi-part content) — the emitter then array-wraps it and the backend
 * JSON-stringifies element 0.
 */
function extractUserText(message: unknown): unknown {
  if (message && typeof message === "object") {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") {
      return content;
    }
  }
  return message;
}

/**
 * The legacy child client only understands `fail_open`/`fail_closed`. The
 * base config's `fail_closed_destructive` is unreachable through this SDK's
 * own config input type (which never offers that value) — degrade it to the
 * safer `fail_closed` rather than silently falling back to `fail_open`.
 */
function toLegacyApiErrorPolicy(policy: OnApiError): "fail_open" | "fail_closed" {
  return policy === "fail_open" ? "fail_open" : "fail_closed";
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
