import type { CopilotRuntimeOptions } from "@copilotkit/runtime/v2";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { OpenBoxConfigInput } from "../config/openbox-config.js";

import { buildBaseRuntime } from "./internal/base-runtime-builder.js";
import { InMemoryInterruptStore } from "./internal/interrupt-store.js";
import { RunTerminalStateRegistry } from "./internal/run-terminal-state.js";
import { ServerToolOwnershipRegistry } from "./internal/server-tool-ownership.js";
import { serverTool as wrapServerTool } from "./server-tool.js";
import type { OpenBoxEnforcementOptions, OpenBoxLogger, OpenBoxRuntimeController } from "./types.js";
import {
  withOpenBoxRuntime,
  type WithOpenBoxRuntimeConfig,
  type WithOpenBoxRuntimeResult
} from "./with-openbox-runtime.js";

/** Configuration accepted by `createOpenBoxCopilotKit`. */
export interface CreateOpenBoxCopilotKitOptions extends OpenBoxConfigInput {
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. Default `900_000` (15 min). */
  approvalMaxWaitMs?: number | null;
  /**
   * Explicit enforcement model governing `bundle.serverTool()`-wrapped tools
   * (default `{ mode: "telemetry" }` — see `OpenBoxEnforcementOptions`).
   * `approvalMaxWaitMs` above wins over `enforcement.approvalMaxWaitMs` when
   * both are set.
   */
  enforcement?: OpenBoxEnforcementOptions;
  logger?: OpenBoxLogger;
  /** See `WithOpenBoxRuntimeConfig.validateApiKeyAtStartup`. Default `false`. */
  validateApiKeyAtStartup?: boolean;
}

/** Bundle returned by `createOpenBoxCopilotKit`. */
export interface OpenBoxCopilotKitBundle {
  /** The one base runtime this bundle owns. */
  openboxRuntime: OpenBoxRuntime;
  /**
   * Wrap a server-side tool so OpenBox governs it before its `execute` runs.
   * Bound to this bundle's own controller + resolved `enforcement` options
   * (`OpenBoxEnforcementOptions`, default `mode: "telemetry"`) — see
   * `server-tool.ts#serverTool` for the full pre-execution ordering
   * (correlation -> ownership claim -> evaluate/approve -> execute exactly
   * once -> completion telemetry -> ownership release).
   */
  serverTool: <T>(tool: T) => T;
  /**
   * Idempotent shutdown for `openboxRuntime`. Does NOT close runtimes created
   * by calls to `withRuntime` — each of those returns its own `shutdown`
   * (identical contract to `withOpenBoxRuntime`), which the caller owns.
   */
  shutdown: () => Promise<void>;
  /** Attach this bundle's config to a CopilotKit runtime (delegates to `withOpenBoxRuntime`). */
  withRuntime: (
    options: CopilotRuntimeOptions,
    config?: WithOpenBoxRuntimeConfig
  ) => Promise<WithOpenBoxRuntimeResult>;
}

/**
 * Bundle entry point for governed server tools. Builds one base runtime (the
 * same composition root `withOpenBoxRuntime` uses internally) plus the
 * controller-owned pieces `serverTool()` needs (`runContext`,
 * `serverToolOwnership`) and exposes it alongside a REAL `serverTool()`
 * wrapper and a `withRuntime` convenience that attaches this bundle's config
 * to a CopilotKit runtime.
 *
 * NOTE: `withRuntime` builds its OWN separate controller (via
 * `withOpenBoxRuntime` -> `wrapCopilotRuntimeOptions` -> `buildBaseRuntime`)
 * rather than reusing this bundle's — this mirrors `shutdown`'s existing
 * documented independence (each `withRuntime` call owns its own runtime/
 * shutdown). Practical effect: `bundle.serverTool()`'s run-correlation
 * (`controller.runContext`) is populated by an AG-UI middleware bound to
 * THIS bundle's controller, not by one constructed through `withRuntime`.
 * Compose the middleware against this bundle's own controller directly
 * (`createOpenBoxMiddleware`) when using `serverTool()` for real governance
 * rather than telemetry-mode-with-generated-ids.
 */
export async function createOpenBoxCopilotKit(
  opts: CreateOpenBoxCopilotKitOptions = {}
): Promise<OpenBoxCopilotKitBundle> {
  const { approvalMaxWaitMs, enforcement, logger, validateApiKeyAtStartup, ...configInput } = opts;

  const resolvedApprovalMaxWaitMs =
    approvalMaxWaitMs !== undefined ? approvalMaxWaitMs : enforcement?.approvalMaxWaitMs;

  const built = buildBaseRuntime(configInput, {
    ...(logger !== undefined ? { logger } : {}),
    ...(resolvedApprovalMaxWaitMs !== undefined ? { approvalMaxWaitMs: resolvedApprovalMaxWaitMs } : {})
  });

  if (validateApiKeyAtStartup) {
    await built.runtime.client.validateApiKey();
  }

  // Full `OpenBoxRuntimeController` shape `serverTool()` needs.
  // `interruptStore`/`runTerminalState`/`childAgentClients` are unused by
  // `serverTool()` itself (multi-agent Handoff is an AG-UI middleware
  // concern) but required by the controller shape; all default/wire the same
  // way `wrapCopilotRuntimeOptions` does for the `withRuntime` path —
  // `childAgentClients` in particular is `built.childAgentClients` so this
  // bundle's own `shutdown()` (== `built.shutdown`) closes the SAME cache.
  const controller: OpenBoxRuntimeController = {
    childAgentClients: built.childAgentClients,
    defaults: {},
    interruptStore: new InMemoryInterruptStore(),
    logger: logger ?? console,
    runContext: built.runContext,
    runTerminalState: new RunTerminalStateRegistry(),
    runtime: built.runtime,
    serverToolOwnership: new ServerToolOwnershipRegistry(),
    telemetryQueue: built.telemetryQueue
  };
  const resolvedEnforcement = enforcement ?? {};

  const withRuntimeConfig: WithOpenBoxRuntimeConfig = {
    ...configInput,
    ...(logger !== undefined ? { logger } : {}),
    ...(validateApiKeyAtStartup !== undefined ? { validateApiKeyAtStartup } : {})
  };

  return {
    openboxRuntime: built.runtime,
    serverTool: tool => wrapServerTool(tool, controller, resolvedEnforcement),
    shutdown: built.shutdown,
    withRuntime: (options, config = {}) =>
      withOpenBoxRuntime(options, { ...withRuntimeConfig, ...config })
  };
}
