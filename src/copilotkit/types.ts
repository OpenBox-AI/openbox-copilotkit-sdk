import type { OpenBoxClient } from "../client/openbox-client.js";
import type { OpenBoxSpanProcessor } from "../span/openbox-span-processor.js";

/**
 * Lightweight logger contract. Module-local; matches a console-style surface
 * so adopters can pass console, pino, winston, or a custom shim without an
 * extra adapter.
 */
export interface OpenBoxLogger {
  debug?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
}

/**
 * Runtime defaults consulted by emissions when the per-request AsyncLocalStorage
 * execution context is absent. T0 keeps these optional and shallow — Phase 4
 * wraps the request to populate the context for the in-stream path.
 */
export interface OpenBoxRuntimeDefaults {
  agentId?: string | undefined;
  tenantId?: string | undefined;
  workflowType?: string | undefined;
}

/**
 * Wire-level dependencies attached to an OpenBox-wrapped `CopilotRuntime` via
 * the private `OPENBOX_COPILOTKIT_RUNTIME_SYMBOL`. Phase 6 owns construction;
 * Phase 3 only reads.
 */
export interface OpenBoxRuntimeController {
  client: OpenBoxClient;
  defaults: OpenBoxRuntimeDefaults;
  logger: OpenBoxLogger;
  spanProcessor: OpenBoxSpanProcessor;
}

/**
 * Operator-facing options for `createOpenBoxMiddleware`.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist required
 * to label a tool call as frontend-originated. Without them, observed tool
 * calls record `frontend: false` and `tool_origin: "copilotkit-observed"`
 * (safe default for multi-framework runtimes — see plan risk H1).
 *
 * `multiAgent` opts the run into OpenBox multi-agent grouping: it stamps a
 * shared `multi_agent_session_id` on every event and emits a `Handoff` marker
 * when a configured delegation tool fires. Disabled by default — normal
 * single-agent governance is unchanged unless `multiAgent.enabled` is set.
 */
export interface OpenBoxMiddlewareOptions {
  enforceApprovals?: boolean;
  frontendToolNames?: string[];
  isFrontendTool?: (call: { name: string }) => boolean;
  multiAgent?: OpenBoxMultiAgentOptions;
  onEvent?: (emission: OpenBoxEmission) => void;
}

/**
 * Multi-agent delegation configuration. When `enabled`, the CopilotKit run is
 * treated as the PARENT/orchestrator of one OpenBox multi-agent session.
 *
 * Identity model: the CopilotKit runtime and each subagent are DISTINCT
 * OpenBox agents with their own API key + DID. The parent DID becomes the
 * `from_agent_did` on the Handoff; the child agent (the authenticated emitter
 * of the Handoff request) becomes the `to_agent` — Core derives it from the
 * signed request, so the wire never carries `to_agent_did`.
 */
export interface OpenBoxMultiAgentOptions {
  /** Master switch. Defaults to `false`. */
  enabled?: boolean;
  /**
   * DID of the parent/orchestrator agent, used as `from_agent_did` on the
   * Handoff. Falls back to the runtime client's `agentDid` when omitted. If
   * neither is available while `enabled` is true, middleware construction
   * throws `OpenBoxConfigError`.
   */
  parentAgentDid?: string;
  /**
   * Stable id grouping every session of one user-facing run. A string is used
   * verbatim; a function resolves it per run. Defaults to `mas:${runId}`.
   */
  multiAgentSessionId?: string | ((ctx: MultiAgentSessionContext) => string);
  /** Static tool-name → subagent map. Checked after `resolveHandoff`. */
  handoffTools?: Record<string, OpenBoxSubagentHandoffConfig>;
  /**
   * Dynamic resolver for delegation boundaries. Returns a subagent config to
   * treat the tool call as a handoff, or `null`/`undefined` to fall through to
   * `handoffTools` (and then to "normal tool, no handoff").
   */
  resolveHandoff?: (
    call: OpenBoxObservedToolCall,
    ctx: MultiAgentSessionContext
  ) => OpenBoxSubagentHandoffConfig | null | undefined;
}

/**
 * Per-subagent delegation config. The `child*` credentials are required only
 * for PARENT-SIDE Handoff emission (the SDK signs the Handoff request as the
 * child so Core resolves `to_agent` correctly). When they are absent the SDK
 * still builds + surfaces the `OpenBoxMultiAgentContext` (via `onEvent`) so a
 * remote child runtime can emit the Handoff itself.
 */
export interface OpenBoxSubagentHandoffConfig {
  /** Human/agent label for the child; defaults to the delegate tool name. */
  childAgentName?: string;
  childAgentDid?: string;
  childApiKey?: string;
  childAgentPrivateKey?: string;
  /** Child workflow_type recorded in Handoff metadata (e.g. "weather-agent"). */
  childWorkflowType?: string;
  /** Child task_queue recorded in Handoff metadata (e.g. "mastra"). */
  childTaskQueue?: string;
}

/**
 * Run-level context passed to the `multiAgentSessionId` resolver and
 * `resolveHandoff`. `workflowId` mirrors the CopilotKit `threadId`.
 */
export interface MultiAgentSessionContext {
  parentAgentDid: string;
  runId: string;
  threadId: string;
  workflowId: string;
}

/**
 * A tool call as observed by the middleware, handed to `resolveHandoff`.
 * `args` is the parsed tool argument object (or the raw string if it was not
 * valid JSON), and may be `undefined` before args have streamed in.
 */
export interface OpenBoxObservedToolCall {
  args?: unknown;
  name: string;
  toolCallId: string;
}

/**
 * The handoff context the parent makes available for a child runtime to emit
 * its own `Handoff` + stamp `parent_workflow_id` on its workflow events. It is
 * embedded in the Handoff payload metadata and surfaced via `onEvent`.
 */
export interface OpenBoxMultiAgentContext {
  multiAgentSessionId: string;
  parentActivityId: string;
  parentAgentDid: string;
  parentRunId: string;
  parentWorkflowId: string;
}

/**
 * Read-only structural projection of an OpenBox event surfaced to the
 * `onEvent` observability hook. Matches the canonical payload shape so
 * adopters can route to their own sinks without re-coupling.
 */
export interface OpenBoxEmission {
  activityId?: string | undefined;
  eventType: string;
  payload: Record<string, unknown>;
  workflowId: string;
}
