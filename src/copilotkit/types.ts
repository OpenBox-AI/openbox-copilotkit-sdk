import type { OpenBoxClient } from "../client/openbox-client.js";
import type { SpanBuffer } from "../spans/span-buffer.js";

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
}

/**
 * Operator-facing options for `createOpenBoxMiddleware`.
 *
 * `frontendToolNames` / `isFrontendTool` are the explicit allowlist required
 * to label a tool call as frontend-originated. Without them, observed tool
 * calls record `frontend: false` and `tool_origin: "copilotkit-observed"`
 * (safe default for multi-framework runtimes — see plan risk H1).
 */
export interface OpenBoxMiddlewareOptions {
  enforceApprovals?: boolean;
  frontendToolNames?: string[];
  isFrontendTool?: (call: { name: string }) => boolean;
  onEvent?: (emission: OpenBoxEmission) => void;
  /**
   * Optional external `SpanBuffer` instance. When provided, the middleware
   * synthesizes one `function_call` span per tool call at activity-completed
   * time and appends it to this buffer. When absent, the middleware skips
   * synthesis (Phase 3's example demo lifts the buffer to a module singleton
   * and passes it in here).
   *
   * Env override `OPENBOX_DISABLE_SPAN_BUFFER=1` skips synthesis regardless
   * of whether a buffer was provided.
   */
  spanBuffer?: SpanBuffer;
  /**
   * Optional JSONPath-like paths to redact from tool args/result previews.
   * Recommended starter set: `["$..password", "$..secret", "$..token", "$..apiKey"]`.
   */
  redactPaths?: string[];
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
