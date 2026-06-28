export enum WorkflowEventType {
  WORKFLOW_STARTED = "WorkflowStarted",
  WORKFLOW_COMPLETED = "WorkflowCompleted",
  WORKFLOW_FAILED = "WorkflowFailed",
  SIGNAL_RECEIVED = "SignalReceived",
  ACTIVITY_STARTED = "ActivityStarted",
  ACTIVITY_COMPLETED = "ActivityCompleted",
  // Multi-agent delegation marker. Core short-circuits this event: it
  // validates `multi_agent_session_id` + `from_agent_did`, writes a
  // `session_handoffs` row (to_agent = authenticated emitter), and skips the
  // normal OPA/guardrails/AGE pipeline for the marker itself.
  HANDOFF = "Handoff"
}
