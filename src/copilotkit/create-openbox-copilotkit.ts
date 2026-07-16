import type { CopilotRuntimeOptions } from "@copilotkit/runtime/v2";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { OpenBoxConfigInput } from "../config/openbox-config.js";

import { buildBaseRuntime } from "./internal/base-runtime-builder.js";
import type { OpenBoxLogger } from "./types.js";
import {
  withOpenBoxRuntime,
  type WithOpenBoxRuntimeConfig,
  type WithOpenBoxRuntimeResult
} from "./with-openbox-runtime.js";

/** Configuration accepted by `createOpenBoxCopilotKit`. */
export interface CreateOpenBoxCopilotKitOptions extends OpenBoxConfigInput {
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. Default `900_000` (15 min). */
  approvalMaxWaitMs?: number | null;
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
   * SKELETON in this phase — an identity passthrough. Phase 5 replaces it
   * with the real pre-execution wrapper (evaluate + approval-wait +
   * `activityScope` before the tool body runs, using the per-run context
   * store for run correlation — Decision D7).
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
 * Bundle entry point for governed server tools. Builds one base runtime
 * (the same composition root `withOpenBoxRuntime` uses internally) and
 * exposes it alongside a `serverTool()` wrapper (stub — Phase 5) and a
 * `withRuntime` convenience that attaches this bundle's config to a
 * CopilotKit runtime.
 *
 * SKELETON: kept minimal on purpose. Real server-tool governance logic lands
 * in Phase 5.
 */
export async function createOpenBoxCopilotKit(
  opts: CreateOpenBoxCopilotKitOptions = {}
): Promise<OpenBoxCopilotKitBundle> {
  const { approvalMaxWaitMs, logger, validateApiKeyAtStartup, ...configInput } = opts;

  const built = buildBaseRuntime(configInput, {
    ...(logger !== undefined ? { logger } : {}),
    ...(approvalMaxWaitMs !== undefined ? { approvalMaxWaitMs } : {})
  });

  if (validateApiKeyAtStartup) {
    await built.runtime.client.validateApiKey();
  }

  const withRuntimeConfig: WithOpenBoxRuntimeConfig = {
    ...configInput,
    ...(logger !== undefined ? { logger } : {}),
    ...(validateApiKeyAtStartup !== undefined ? { validateApiKeyAtStartup } : {})
  };

  return {
    openboxRuntime: built.runtime,
    serverTool: passthroughServerTool,
    shutdown: built.shutdown,
    withRuntime: (options, config = {}) =>
      withOpenBoxRuntime(options, { ...withRuntimeConfig, ...config })
  };
}

/**
 * Identity-passthrough stub. Phase 5 replaces this with the real
 * pre-execution wrapper described on `OpenBoxCopilotKitBundle.serverTool`.
 */
function passthroughServerTool<T>(tool: T): T {
  return tool;
}
