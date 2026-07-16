import { prepareLifecyclePayload, type JsonValue } from "@openbox-ai/openbox-sdk-ts";
import type { OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import type { PrivacyConfig } from "@openbox-ai/openbox-sdk-ts/config";

import type { OpenBoxClient as LegacyOpenBoxClient } from "../client/openbox-client.js";
import type { SpanData } from "../spans/index.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { WorkflowEventType } from "../types/workflow-event-type.js";

import {
  buildActivityCompletedEnvelope,
  buildActivityStartedEnvelope,
  buildSignalReceivedEnvelope,
  buildWorkflowCompletedEnvelope,
  buildWorkflowFailedEnvelope,
  buildWorkflowStartedEnvelope,
  COPILOTKIT_EVENT_SOURCE,
  COPILOTKIT_TASK_QUEUE,
  COPILOTKIT_WORKFLOW_TYPE,
  serializeOrNull,
  type ActivityCompletedInput,
  type ActivityStartedInput,
  type SignalEmitInput,
  type WorkflowCompletedInput,
  type WorkflowFailedInput,
  type WorkflowStartedInput
} from "./lifecycle-events.js";
import type {
  OpenBoxEmission,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController
} from "./types.js";

export { COPILOTKIT_TASK_QUEUE, COPILOTKIT_WORKFLOW_TYPE };

export const USER_INPUT_SIGNAL_NAME = "user_input";
export const AGENT_OUTPUT_SIGNAL_NAME = "agent_output";

/**
 * Carrier for a synthesized `function_call` span. It is emitted as a separate
 * hook-style activity event so the original tool completion payload remains
 * small and schema-stable.
 */
export interface ActivityCompletedHookInput {
  activityArgs?: unknown;
  activityId: string;
  agentId?: string | undefined;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  span: SpanData;
  startTime?: number | undefined;
  workflowId: string;
}

/**
 * Input for `emitHandoff`. The marker describes the parent workflow and is
 * sent with the child agent credentials when parent-side handoff emission is
 * available.
 */
export interface HandoffEmitInput {
  fromAgentDid: string;
  metadata?: Record<string, unknown> | undefined;
  multiAgentSessionId: string;
  runId: string;
  taskQueue?: string | undefined;
  workflowId: string;
  workflowType?: string | undefined;
}

/**
 * Wraps `client.evaluate` for CopilotKit-observed AG-UI events. The six
 * lifecycle/signal methods below build a base `EventEnvelope` via
 * `lifecycle-events.ts`, run it through the base strict gate
 * (`prepareLifecyclePayload`), then hand the exact prepared wire payload to
 * `onEvent` and `client.evaluate` — no hand-built snake_case object remains
 * for those six. `emitActivityCompletedHook` (hook-span) and `emitHandoff`
 * still hand-assemble their payload via `withBaseEnvelope`/`toWireSpan`
 * (migration deferred — see each method's own note). Emitter failures are
 * logged and swallowed so telemetry cannot break the user stream. Verdict
 * objects are returned to callers that enforce approvals.
 */
export class OpenBoxCopilotKitEmitter {
  readonly #client: OpenBoxClient;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #onEvent: OpenBoxMiddlewareOptions["onEvent"];
  readonly #privacy: PrivacyConfig;

  public constructor(
    controller: OpenBoxRuntimeController,
    onEvent: OpenBoxMiddlewareOptions["onEvent"]
  ) {
    this.#client = controller.runtime.client;
    this.#logger = controller.logger;
    this.#onEvent = onEvent;
    this.#privacy = controller.runtime.config.privacy;
  }

  public async emitWorkflowStarted(
    input: WorkflowStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildWorkflowStartedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_STARTED,
      workflowId: input.workflowId
    });
  }

  public async emitSignalReceived(
    input: SignalEmitInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildSignalReceivedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.SIGNAL_RECEIVED,
      workflowId: input.workflowId
    });
  }

  public async emitActivityStarted(
    input: ActivityStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildActivityStartedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_STARTED,
      workflowId: input.workflowId
    });
  }

  public async emitActivityCompleted(
    input: ActivityCompletedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildActivityCompletedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_COMPLETED,
      workflowId: input.workflowId
    });
  }

  /**
   * Sibling event to `emitActivityCompleted` that carries the synthesized
   * `function_call` span. The same `activity_id` as the original completion
   * event ties both payloads together in OpenBox.
   *
   * Phase: hook-span migration deferred — this still hand-assembles its
   * payload via `withBaseEnvelope`/`toWireSpan` rather than the base `hook()`
   * factory (base hook payload assembly owns `spans`/`span_count`, which this
   * adapter's `SpanBuffer`-derived `SpanData` shape isn't wired to yet).
   */
  public async emitActivityCompletedHook(
    input: ActivityCompletedHookInput
  ): Promise<GovernanceVerdictResponse | null> {
    const wireSpan = toWireSpan(input.span);
    const payload = withBaseEnvelope({
      activity_id: input.activityId,
      activity_input: serializeOrNull(input.activityArgs),
      activity_type: "function_call",
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      attempt: 1,
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      event_type: WorkflowEventType.ACTIVITY_STARTED,
      ...(input.goal ? { goal: input.goal } : {}),
      hook_trigger: true,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      spans: [wireSpan],
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
    });

    return this.#evaluate(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_STARTED,
      workflowId: input.workflowId
    });
  }

  public async emitWorkflowCompleted(
    input: WorkflowCompletedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildWorkflowCompletedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_COMPLETED,
      workflowId: input.workflowId
    });
  }

  public async emitWorkflowFailed(
    input: WorkflowFailedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const { payload } = prepareLifecyclePayload(buildWorkflowFailedEnvelope(input), {
      privacy: this.#privacy
    });

    return this.#evaluate(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_FAILED,
      workflowId: input.workflowId
    });
  }

  /**
   * Emit a multi-agent `Handoff` marker. When `client` is omitted, the payload
   * is surfaced to `onEvent` so a remote child runtime can emit it itself.
   */
  public async emitHandoff(
    input: HandoffEmitInput,
    client?: LegacyOpenBoxClient
  ): Promise<GovernanceVerdictResponse | null> {
    // Keep invalid handoff markers off the wire.
    if (!input.fromAgentDid || !input.multiAgentSessionId) {
      this.#logger.warn?.({
        note: "openbox emitHandoff: missing from_agent_did or multi_agent_session_id — skipping handoff",
        workflow_id: input.workflowId
      });
      return null;
    }

    const payload = withBaseEnvelope({
      event_type: WorkflowEventType.HANDOFF,
      from_agent_did: input.fromAgentDid,
      ...(input.metadata ? { metadata: input.metadata } : {}),
      multi_agent_session_id: input.multiAgentSessionId,
      run_id: input.runId,
      task_queue: input.taskQueue ?? COPILOTKIT_TASK_QUEUE,
      workflow_id: input.workflowId,
      workflow_type: input.workflowType ?? COPILOTKIT_WORKFLOW_TYPE
    });

    const emissionMeta = {
      activityId: undefined,
      eventType: WorkflowEventType.HANDOFF,
      workflowId: input.workflowId
    };

    if (!client) {
      this.#notifyObserver(payload, emissionMeta);
      return null;
    }

    return this.#evaluateWithLegacyClient(client, payload, emissionMeta);
  }

  async #evaluate(
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): Promise<GovernanceVerdictResponse | null> {
    this.#notifyObserver(payload, emissionMeta);

    try {
      // The base client's `evaluate` takes a prepared `JsonValue` and
      // resolves a base `EvaluationResult`. This SDK still reads that result
      // through its own local `GovernanceVerdictResponse` shape — every field
      // it reads off the result (`verdict`, `reason`, `policyId`,
      // `governanceEventId`, `approvalId`, ...) is named identically on both
      // shapes, so this bridge is safe until a later phase unifies the two
      // types (`src/types/*` re-exports, out of this migration's scope).
      const result = await this.#client.evaluate(payload as unknown as JsonValue);
      return result as unknown as GovernanceVerdictResponse | null;
    } catch (err) {
      this.#logger.warn?.({
        err,
        event_type: payload.event_type,
        workflow_id: payload.workflow_id
      });
      return null;
    }
  }

  /**
   * Multi-agent handoff emission still goes through the legacy adapter-owned
   * client for CHILD credentials — Phase 2 does not migrate child-client
   * construction (see `openbox-middleware.ts#buildChildClient`); Phase 5
   * moves child construction to child-scoped base runtimes.
   */
  async #evaluateWithLegacyClient(
    client: LegacyOpenBoxClient,
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): Promise<GovernanceVerdictResponse | null> {
    this.#notifyObserver(payload, emissionMeta);

    try {
      return await client.evaluate(payload);
    } catch (err) {
      this.#logger.warn?.({
        err,
        event_type: payload.event_type,
        workflow_id: payload.workflow_id
      });
      return null;
    }
  }

  #notifyObserver(
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): void {
    if (!this.#onEvent) {
      return;
    }

    try {
      this.#onEvent({
        activityId: emissionMeta.activityId,
        eventType: emissionMeta.eventType,
        payload,
        workflowId: emissionMeta.workflowId
      });
    } catch (err) {
      this.#logger.warn?.({
        err,
        note: "openbox onEvent observer threw",
        workflow_id: emissionMeta.workflowId
      });
    }
  }

}

/**
 * Hand-built envelope wrapper still used by the two unmigrated payloads
 * (`emitActivityCompletedHook`, `emitHandoff` below) — the six lifecycle/
 * signal methods above build their envelope via `lifecycle-events.ts` and
 * `prepareLifecyclePayload` instead.
 */
function withBaseEnvelope(
  payload: Record<string, unknown>
): Record<string, unknown> {
  return {
    source: COPILOTKIT_EVENT_SOURCE,
    task_queue: COPILOTKIT_TASK_QUEUE,
    timestamp: new Date().toISOString(),
    ...payload
  };
}

/**
 * Transform an internal `SpanData` into the OpenBox wire span shape.
 * Nano-time fields are sent as JS numbers for JSON transport; the internal
 * `SpanBuffer` keeps the raw `bigint` values until this boundary.
 */
function toWireSpan(span: SpanData): Record<string, unknown> {
  const startTime = Number(span.start_time_unix_nano);
  const endTime = Number(span.end_time_unix_nano);
  const attrs = { ...span.attributes } as Record<string, unknown>;
  const toolNameAttr = attrs["tool.name"];
  const toolName = typeof toolNameAttr === "string" ? toolNameAttr : undefined;

  const wire: Record<string, unknown> = {
    attributes: attrs,
    duration_ns: Math.max(0, endTime - startTime),
    end_time: endTime,
    events: [],
    ...(toolName ? { function: toolName } : {}),
    hook_type: "function_call",
    kind: "INTERNAL",
    name: span.name,
    semantic_type: "function_call",
    span_id: span.span_id,
    stage: "completed",
    start_time: startTime,
    status: {
      code: span.status === "error" ? "ERROR" : "OK"
    },
    trace_id: span.trace_id
  };

  if (span.parent_span_id) {
    wire.parent_span_id = span.parent_span_id;
  }

  return wire;
}
