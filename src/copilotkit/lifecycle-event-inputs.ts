/**
 * Adapter-shaped input types for the six lifecycle/signal builders in
 * `lifecycle-events.ts`. Split out purely to keep that file's builder logic
 * focused (module split, no behavior change) — every field here is preserved
 * verbatim from the pre-migration hand-built-payload inputs.
 */

/**
 * Optional OpenBox multi-agent fields, mixed into emitter inputs. Both are
 * omitted from the wire payload when unset, so single-agent runs keep their
 * normal payload shape.
 */
export interface MultiAgentEventFields {
  multiAgentSessionId?: string | undefined;
  parentWorkflowId?: string | undefined;
}

export interface WorkflowStartedInput extends MultiAgentEventFields {
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
  multiAgentSessionId?: string | undefined;
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
  multiAgentSessionId?: string | undefined;
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
  multiAgentSessionId?: string | undefined;
  runId: string;
  startTime?: number | undefined;
  status: "completed" | "failed" | "aborted";
  toolName: string;
  workflowId: string;
}

export interface WorkflowCompletedInput extends MultiAgentEventFields {
  agentOutput?: unknown;
  durationMs?: number | undefined;
  endTime?: number | undefined;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  startTime?: number | undefined;
  workflowId: string;
}

export interface WorkflowFailedInput extends MultiAgentEventFields {
  error: Record<string, unknown>;
  goal?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
  runId: string;
  workflowId: string;
}
