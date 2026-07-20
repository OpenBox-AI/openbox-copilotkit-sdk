export { createOpenBoxCopilotKit } from "./create-openbox-copilotkit.js";
export { createOpenBoxMiddleware } from "./openbox-middleware.js";
export { withOpenBoxRuntime } from "./with-openbox-runtime.js";

export type {
  CreateOpenBoxCopilotKitOptions,
  OpenBoxCopilotKitBundle
} from "./create-openbox-copilotkit.js";
export type {
  WithOpenBoxRuntimeConfig,
  WithOpenBoxRuntimeResult
} from "./with-openbox-runtime.js";

export type {
  MultiAgentSessionContext,
  OpenBoxEmission,
  OpenBoxEnforcementOptions,
  OpenBoxLogger,
  OpenBoxMiddlewareOptions,
  OpenBoxMultiAgentContext,
  OpenBoxMultiAgentOptions,
  OpenBoxObservedToolCall,
  OpenBoxRuntimeController,
  OpenBoxRuntimeDefaults,
  OpenBoxSubagentHandoffConfig
} from "./types.js";

// Thrown by a `bundle.serverTool()`-wrapped tool's `execute` on a non-allow
// governance outcome (block/halt/rejected/expired/timed-out approval,
// CONSTRAIN) or a missing-run-correlation fail-safe in `enforce` mode — the
// public, catchable surface for the server-tool boundary (proposal §6/§7.3).
// Server tools surface errors directly to their caller; unlike the frontend
// AG-UI gate (which redacts into a `governance_blocked` stream frame instead
// of throwing to app code), an operator wrapping a tool via
// `bundle.serverTool()` needs a way to `instanceof`/`.reason`-check what
// stopped it.
export {
  CopilotKitGovernanceControlError,
  type CopilotKitGovernanceControlReason
} from "./governance-control-error.js";
export { CopilotKitServerToolCorrelationError } from "./server-tool-correlation-error.js";
export { CopilotKitUnsupportedVerdictError } from "./unsupported-verdict-error.js";
