import {
  activityCompleted,
  activityStarted,
  handoff,
  signalReceived,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
  type EventEnvelope
} from "@openbox-ai/openbox-sdk-ts";

import type {
  ActivityCompletedInput,
  ActivityStartedInput,
  HandoffEnvelopeInput,
  InterruptSignalInput,
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
/** Fires once when `RUN_FINISHED.outcome.type === "interrupt"` (fixes B3). */
export const COPILOTKIT_INTERRUPT_SIGNAL_NAME = "copilotkit_interrupt";

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

/**
 * `copilotkit_interrupt` signal (fixes B3): fired once per interrupted
 * `RUN_FINISHED` instead of `WorkflowCompleted`. Unlike the generic
 * `SignalReceived` builder above (whose payload always nests under
 * `signal_args`), this signal has a well-defined, structured shape — every
 * array rides as its OWN named `extra` key, matching how `ActivityStarted`/
 * `WorkflowStarted` expose their own typed extras rather than a generic
 * wrapper. `responseSchemas` is expected to already be redacted/bounded
 * (`run-outcome.ts` does this at parse time) — this builder does not
 * redact again, it only guarantees JSON-safety (`undefined` -> `null`).
 */
export function buildInterruptSignalEnvelope(input: InterruptSignalInput): EventEnvelope {
  return signalReceived({
    workflowId: input.workflowId,
    runId: input.runId,
    workflowType: COPILOTKIT_WORKFLOW_TYPE,
    taskQueue: COPILOTKIT_TASK_QUEUE,
    ...multiAgentSessionIdOption(input.multiAgentSessionId),
    signalName: COPILOTKIT_INTERRUPT_SIGNAL_NAME,
    extra: {
      source: COPILOTKIT_EVENT_SOURCE,
      interrupt_ids: [...input.interruptIds],
      reasons: [...input.reasons],
      messages: input.messages.map(serializeOrNull),
      response_schemas: input.responseSchemas.map(serializeOrNull),
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

/**
 * `Handoff` marker (Decision D1 — Core-required two-field payload only).
 * Built directly via the base `handoff()` factory, which accepts no `extra`
 * bag (unlike every builder above): the rich adapter-shaped metadata callers
 * have historically attached to a handoff (`child_agent_name`,
 * `parent_activity_id`, `forwarded_context`, run/workflow ids, `task_queue`,
 * `workflow_type`, ...) has no wire slot here. `openbox-emitter.ts#emitHandoff`
 * keeps surfacing that metadata via `onEvent`/logs for local observability,
 * but the envelope THIS builder produces — the one actually sent to Core —
 * carries only what `ValidateHandoffPayload` requires:
 * `from_agent_did`+`multi_agent_session_id`. Core derives `to_agent`
 * server-side from the child-signed AIP headers (verified
 * `governance.go:229`/`governance_workflow.go:171`), never from the payload.
 */
export function buildHandoffEnvelope(input: HandoffEnvelopeInput): EventEnvelope {
  return handoff({
    fromAgentDid: input.fromAgentDid,
    multiAgentSessionId: input.multiAgentSessionId
  });
}

export type {
  ActivityCompletedInput,
  ActivityStartedInput,
  HandoffEnvelopeInput,
  InterruptSignalInput,
  MultiAgentEventFields,
  SignalEmitInput,
  WorkflowCompletedInput,
  WorkflowFailedInput,
  WorkflowStartedInput
} from "./lifecycle-event-inputs.js";
export { toErrorInfo, serializeOrNull } from "./lifecycle-event-serialization.js";
