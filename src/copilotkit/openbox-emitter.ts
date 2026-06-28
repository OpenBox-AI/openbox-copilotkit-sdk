import type { OpenBoxClient } from "../client/openbox-client.js";
import type { OpenBoxSpanProcessor } from "../span/openbox-span-processor.js";
import type { GovernanceVerdictResponse } from "../types/governance-verdict-response.js";
import { WorkflowEventType } from "../types/workflow-event-type.js";
import { WorkflowSpanBuffer } from "../types/workflow-span-buffer.js";

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
 * Wraps `client.evaluate` + `OpenBoxSpanProcessor` registrations for every
 * CopilotKit-observed AG-UI event. Each emit method:
 *
 *   1. Registers the workflow / trace with the span processor when needed.
 *   2. Builds a payload shape mirroring `openbox-mastra-sdk/src/mastra/wrap-agent.ts:2031-2074`.
 *   3. Awaits `client.evaluate(payload)` so the optional `enforceApprovals`
 *      caller can inspect the verdict.
 *   4. On error: logs via `runtime.logger.warn` and swallows (fail-open). The
 *      observable stream never errors from emitter failures.
 *
 * Verdict objects are returned to the caller so the middleware can decide
 * whether to inject a redacted `governance_blocked` error frame.
 */
export class OpenBoxCopilotKitEmitter {
  readonly #client: OpenBoxClient;
  readonly #logger: OpenBoxRuntimeController["logger"];
  readonly #onEvent: OpenBoxMiddlewareOptions["onEvent"];
  readonly #registeredWorkflows = new Set<string>();
  readonly #spanProcessor: OpenBoxSpanProcessor;

  public constructor(
    runtime: OpenBoxRuntimeController,
    onEvent: OpenBoxMiddlewareOptions["onEvent"]
  ) {
    this.#client = runtime.client;
    this.#spanProcessor = runtime.spanProcessor;
    this.#logger = runtime.logger;
    this.#onEvent = onEvent;
  }

  public async emitWorkflowStarted(
    input: WorkflowStartedInput
  ): Promise<GovernanceVerdictResponse | null> {
    this.#ensureWorkflowRegistered(input.workflowId, input.runId);

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

  #ensureWorkflowRegistered(workflowId: string, runId: string): void {
    const runKey = `${workflowId}::${runId}`;

    if (this.#registeredWorkflows.has(runKey)) {
      return;
    }

    this.#registeredWorkflows.add(runKey);
    this.#spanProcessor.registerWorkflow(
      workflowId,
      new WorkflowSpanBuffer({
        runId,
        taskQueue: COPILOTKIT_TASK_QUEUE,
        workflowId,
        workflowType: COPILOTKIT_WORKFLOW_TYPE
      })
    );
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
