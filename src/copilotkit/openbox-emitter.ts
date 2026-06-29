import type { OpenBoxClient } from "../client/openbox-client.js";
import type { SpanData } from "../spans/index.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { WorkflowEventType } from "../types/workflow-event-type.js";

import type {
  OpenBoxEmission,
  OpenBoxMiddlewareOptions,
  OpenBoxRuntimeController
} from "./types.js";

export const COPILOTKIT_WORKFLOW_TYPE = "copilotkit";
export const COPILOTKIT_TASK_QUEUE = "copilotkit";
export const COPILOTKIT_EVENT_SOURCE = "copilotkit-middleware";

export const USER_INPUT_SIGNAL_NAME = "user_input";
export const AGENT_OUTPUT_SIGNAL_NAME = "agent_output";

export interface WorkflowStartedInput {
  agentId?: string | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  threadId: string;
  userInput?: unknown;
  workflowId: string;
}

export interface SignalEmitInput {
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  payload: unknown;
  runId: string;
  signalName: string;
  workflowId: string;
}

export interface ActivityStartedInput {
  activityArgs?: unknown;
  activityId: string;
  agentId?: string | undefined;
  frontend: boolean;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  toolName: string;
  toolOrigin: string;
  workflowId: string;
}

export interface ActivityCompletedInput {
  activityArgs?: unknown;
  activityId: string;
  activityOutput?: unknown;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  error?: Record<string, unknown> | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  startTime?: number | undefined;
  status: "completed" | "failed" | "aborted";
  toolName: string;
  workflowId: string;
}

/**
 * Carrier for a synthesized `function_call` span. Emitted as a separate
 * `ActivityStarted`-shaped event with `hook_trigger: true` and
 * `hook_stage: "completed"` so it lands on openbox-core via the same
 * code path that accepts mastra-sdk's hook spans (HTTP/DB instrumentation).
 *
 * Background: openbox-core rejects `ActivityCompleted` payloads that carry
 * a `spans` field (returns 400 invalid request body), so we cannot inline
 * the span on the original completion event. Posting a sibling event with
 * the same `activityId` but `activity_type: "function_call"` ties the span
 * back to the originating tool call without changing the completion shape.
 */
export interface ActivityCompletedHookInput {
  activityArgs?: unknown;
  activityId: string;
  agentId?: string | undefined;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  frontend: boolean;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  span: SpanData;
  startTime?: number | undefined;
  workflowId: string;
}

export interface WorkflowCompletedInput {
  agentOutput?: unknown;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  startTime?: number | undefined;
  workflowId: string;
}

export interface WorkflowFailedInput {
  error: Record<string, unknown>;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  workflowId: string;
}

/**
 * Wraps `client.evaluate` for every CopilotKit-observed AG-UI event. Each
 * emit method:
 *
 *   1. Builds a payload shape mirroring `openbox-mastra-sdk/src/mastra/wrap-agent.ts:2031-2074`.
 *   2. Awaits `client.evaluate(payload)` so the optional `enforceApprovals`
 *      caller can inspect the verdict.
 *   3. On error: logs via `runtime.logger.warn` and swallows (fail-open). The
 *      observable stream never errors from emitter failures.
 *
 * Verdict objects are returned to the caller so the middleware can decide
 * whether to inject a redacted `governance_blocked` error frame.
 */
export class OpenBoxCopilotKitEmitter {
  readonly #client: OpenBoxClient;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #onEvent: OpenBoxMiddlewareOptions["onEvent"];

  public constructor(
    runtime: OpenBoxRuntimeController,
    onEvent: OpenBoxMiddlewareOptions["onEvent"]
  ) {
    this.#client = runtime.client;
    this.#logger = runtime.logger;
    this.#onEvent = onEvent;
  }

  public async emitWorkflowStarted(
    input: WorkflowStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    const payload = withBaseEnvelope({
      event_type: WorkflowEventType.WORKFLOW_STARTED,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      thread_id: input.threadId,
      workflow_id: input.workflowId,
      workflow_input: serializeWorkflowInput(input.userInput),
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
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
    const payload = withBaseEnvelope({
      event_type: WorkflowEventType.SIGNAL_RECEIVED,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      signal_args: serializeSignalArgs(input.payload),
      signal_name: input.signalName,
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
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
    const payload = withBaseEnvelope({
      activity_id: input.activityId,
      activity_input: serializeActivityInput(input.activityArgs),
      activity_type: input.toolName,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      event_type: WorkflowEventType.ACTIVITY_STARTED,
      frontend: input.frontend,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      tool_origin: input.toolOrigin,
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
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
    const payload = withBaseEnvelope({
      activity_id: input.activityId,
      activity_input: serializeActivityInput(input.activityArgs),
      activity_output: serializeActivityOutput(input.activityOutput),
      activity_type: input.toolName,
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      ...(input.error ? { error: input.error } : {}),
      event_type: WorkflowEventType.ACTIVITY_COMPLETED,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      status: input.status,
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
    });

    return this.#evaluate(payload, {
      activityId: input.activityId,
      eventType: WorkflowEventType.ACTIVITY_COMPLETED,
      workflowId: input.workflowId
    });
  }

  /**
   * Sibling event to `emitActivityCompleted` that carries the synthesized
   * `function_call` span. Shaped as `ActivityStarted` with `hook_trigger:
   * true` and a `stage: "completed"` field on the span itself — openbox-core
   * derives `hook_stage` from `span.stage`, matching the shape that
   * `openbox-mastra-sdk` ships for its HTTP/DB hook spans. Same `activity_id`
   * as the original completion event ties the two phases at the session UI.
   *
   * Intentionally omits `activity_output` (ActivityStarted events never carry
   * outputs in the accepted shape — openbox-core rejects with 400 otherwise)
   * and `tool_name` (not part of the validated schema).
   */
  public async emitActivityCompletedHook(
    input: ActivityCompletedHookInput
  ): Promise<GovernanceVerdictResponse | null> {
    const wireSpan = serializeSpan(input.span);
    wireSpan.stage = "completed";
    const payload = withBaseEnvelope({
      activity_id: input.activityId,
      activity_input: serializeActivityInput(input.activityArgs),
      activity_type: "function_call",
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      event_type: WorkflowEventType.ACTIVITY_STARTED,
      frontend: input.frontend,
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
    const payload = withBaseEnvelope({
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      event_type: WorkflowEventType.WORKFLOW_COMPLETED,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      workflow_id: input.workflowId,
      workflow_output: serializeWorkflowOutput(input.agentOutput),
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
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
    const payload = withBaseEnvelope({
      error: input.error,
      event_type: WorkflowEventType.WORKFLOW_FAILED,
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
      run_id: input.runId,
      workflow_id: input.workflowId,
      workflow_type: COPILOTKIT_WORKFLOW_TYPE
    });

    return this.#evaluate(payload, {
      activityId: undefined,
      eventType: WorkflowEventType.WORKFLOW_FAILED,
      workflowId: input.workflowId
    });
  }

  async #evaluate(
    payload: Record<string, unknown>,
    emissionMeta: Pick<OpenBoxEmission, "activityId" | "eventType" | "workflowId">
  ): Promise<GovernanceVerdictResponse | null> {
    this.#notifyObserver(payload, emissionMeta);

    try {
      return await this.#client.evaluate(payload);
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

function serializeWorkflowInput(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return safeSerialize(value);
}

function serializeWorkflowOutput(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return safeSerialize(value);
}

function serializeSignalArgs(value: unknown): unknown {
  if (value === undefined || value === null) {
    return { value: null };
  }
  return { value: safeSerialize(value) };
}

function serializeActivityInput(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return safeSerialize(value);
}

function serializeActivityOutput(value: unknown): unknown {
  if (value === undefined) {
    return null;
  }
  return safeSerialize(value);
}

/**
 * Coerce a `SpanData`'s `bigint` nano-time fields to decimal strings.
 *
 * `JSON.stringify` throws on any `bigint`, and `OpenBoxClient.evaluate`
 * serializes the entire payload before POSTing it. The wire format follows
 * the OTel JSON convention of representing 64-bit nano-second timestamps as
 * decimal-encoded strings — this keeps full precision (Number can't hold
 * `2^63 - 1`) and matches what openbox-core's indexers expect.
 *
 * The `SpanBuffer` itself still holds the raw `bigint` shape — this coercion
 * is scoped to the wire boundary only.
 */
function serializeSpan(span: unknown): Record<string, unknown> {
  if (span === null || typeof span !== "object") {
    return span as Record<string, unknown>;
  }
  const source = span as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    const value = source[key];
    if (typeof value === "bigint") {
      result[key] = value.toString(10);
    } else if (Array.isArray(value)) {
      result[key] = (value as unknown[]).map((item: unknown): unknown =>
        item !== null && typeof item === "object" ? serializeSpan(item) : item
      );
    } else {
      result[key] = value;
    }
  }
  return result;
}

function safeSerialize(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }

  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value));
    } catch {
      return Object.prototype.toString.call(value);
    }
  }
}
