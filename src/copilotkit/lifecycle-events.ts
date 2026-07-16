import {
  activityCompleted,
  activityStarted,
  signalReceived,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";

import type {
  ActivityCompletedInput,
  ActivityStartedInput,
  SignalEmitInput,
  WorkflowCompletedInput,
  WorkflowFailedInput,
  WorkflowStartedInput
} from "./lifecycle-event-inputs.js";
import {
  metadataExtra,
  multiAgentSessionIdOption,
  parentWorkflowIdExtra,
  serializeOrNull,
  serializeSignalArgs,
  toErrorInfo
} from "./lifecycle-event-serialization.js";

/**
 * Pure builders: adapter-shaped emitter inputs -> base `EventEnvelope`s via
 * the `@openbox-ai/openbox-sdk-ts` event factories. No network I/O and no
 * `prepareLifecyclePayload`/`client.evaluate` call here — `openbox-emitter.ts`
 * owns preparation and sending.
 *
 * Every builder preserves the exact wire field names + omission rules the
 * adapter has always emitted for its six lifecycle/signal events. Fields the
 * base factories know about natively (workflow/run ids, `workflow_type`,
 * `task_queue`, `multi_agent_session_id`, `activity_id`/`activity_type`,
 * `activity_input` on Started, `activity_output` on Completed, `signal_name`,
 * `error`) are passed as typed factory options and follow the FACTORY's own
 * omission rule. Framework-only fields the factories don't model (`source`,
 * `thread_id`, `frontend`, `tool_origin`, `goal`, `agent_id`, `status`,
 * timings, `workflow_input`/`workflow_output`, `activity_input` on
 * Completed, `metadata`, `parent_workflow_id`) ride in each factory's `extra`
 * bag under the adapter's OWN omission rule (matching pre-migration
 * behavior). `workflowFailed`/`activityCompleted` route `error` through the
 * base `ErrorInfo` shape (never a bare string) via `toErrorInfo`.
 */

export const COPILOTKIT_WORKFLOW_TYPE = "copilotkit";
export const COPILOTKIT_TASK_QUEUE = "copilotkit";
export const COPILOTKIT_EVENT_SOURCE = "copilotkit-middleware";

/** `WorkflowStarted`: ids/type/queue/multi-agent are base-native; the rest rides in `extra`. */
export function buildWorkflowStartedEnvelope(
  input: WorkflowStartedInput
): EventEnvelope {
  return workflowStarted({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      thread_id: input.threadId,
      workflow_input: serializeOrNull(input.userInput),
      ...(input.goal ? { goal: input.goal } : {}),
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...metadataExtra(input.metadata),
      ...parentWorkflowIdExtra(input)
    }
  });
}

/** `SignalReceived`: `signal_args` shape mirrors multi-agent vs standalone mode. */
export function buildSignalReceivedEnvelope(input: SignalEmitInput): EventEnvelope {
  return signalReceived({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    signalName: input.signalName,
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      signal_args: serializeSignalArgs(
        input.payload,
        Boolean(input.multiAgentSessionId)
      ),
      ...(input.goal ? { goal: input.goal } : {}),
      ...metadataExtra(input.metadata)
    }
  });
}

/** `ActivityStarted`: `activity_input` is base-native (factory omits it when absent). */
export function buildActivityStartedEnvelope(
  input: ActivityStartedInput
): EventEnvelope {
  return activityStarted({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    activityId: input.activityId,
    activityType: input.toolName,
    activityInput: serializeOrNull(input.activityArgs),
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      frontend: input.frontend,
      tool_origin: input.toolOrigin,
      ...(input.agentId ? { agent_id: input.agentId } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      ...metadataExtra(input.metadata)
    }
  });
}

/**
 * `ActivityCompleted`: `result` is base-native (wire `activity_output`, fixed
 * in base 1.0.1). `activity_input` has NO native slot on this factory, so it
 * rides in `extra` — always present, `null` when absent (the adapter's
 * historical omission rule for this specific field).
 */
export function buildActivityCompletedEnvelope(
  input: ActivityCompletedInput
): EventEnvelope {
  return activityCompleted({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    activityId: input.activityId,
    activityType: input.toolName,
    result: serializeOrNull(input.activityOutput),
    ...(input.error !== undefined ? { error: toErrorInfo(input.error) } : {}),
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      activity_input: serializeOrNull(input.activityArgs),
      status: input.status,
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      ...metadataExtra(input.metadata)
    }
  });
}

/** `WorkflowCompleted`: `workflow_output` has no base-native slot, so it rides in `extra`. */
export function buildWorkflowCompletedEnvelope(
  input: WorkflowCompletedInput
): EventEnvelope {
  return workflowCompleted({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      workflow_output: serializeOrNull(input.agentOutput),
      ...(typeof input.durationMs === "number"
        ? { duration_ms: input.durationMs }
        : {}),
      ...(typeof input.startTime === "number"
        ? { start_time: input.startTime }
        : {}),
      ...(typeof input.endTime === "number" ? { end_time: input.endTime } : {}),
      ...(input.goal ? { goal: input.goal } : {}),
      ...metadataExtra(input.metadata),
      ...parentWorkflowIdExtra(input)
    }
  });
}

/** `WorkflowFailed`: `error` is base-native, converted to the structured `ErrorInfo` shape. */
export function buildWorkflowFailedEnvelope(input: WorkflowFailedInput): EventEnvelope {
  return workflowFailed({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    error: toErrorInfo(input.error),
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      ...(input.goal ? { goal: input.goal } : {}),
      ...metadataExtra(input.metadata),
      ...parentWorkflowIdExtra(input)
    }
  });
}

export type {
  ActivityCompletedInput,
  ActivityStartedInput,
  MultiAgentEventFields,
  SignalEmitInput,
  WorkflowCompletedInput,
  WorkflowFailedInput,
  WorkflowStartedInput
} from "./lifecycle-event-inputs.js";
export { toErrorInfo, serializeOrNull } from "./lifecycle-event-serialization.js";
