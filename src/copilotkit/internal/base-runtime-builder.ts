import { CoreAdapter } from "@openbox-ai/openbox-sdk-ts/adapters";
import { ApprovalPoller } from "@openbox-ai/openbox-sdk-ts/approvals";
import { type ClientLogger, OpenBoxClient } from "@openbox-ai/openbox-sdk-ts/client";
import { defaultHitlConfig, OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { ContextStore } from "@openbox-ai/openbox-sdk-ts/context";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

import type { OpenBoxConfigInput } from "../../config/openbox-config.js";
import { SDK_METADATA } from "../../sdk-metadata.js";
import { LifecycleTelemetryQueue, type TelemetryQueueOptions } from "../lifecycle-telemetry.js";
import type { OpenBoxLogger } from "../types.js";

import { RunContextStore } from "./run-context-store.js";

const ENV_PREFIX = "OPENBOX_COPILOTKIT";
// Finite default so a HITL wait cannot pin a governed operation forever;
// explicit `null` (via `opts.approvalMaxWaitMs`) opts into an infinite wait.
const DEFAULT_APPROVAL_MAX_WAIT_MS = 900_000;

export interface BuildBaseRuntimeOptions {
  logger?: OpenBoxLogger;
  /** Bounds an in-flight HITL approval wait; `null` opts into an infinite wait. */
  approvalMaxWaitMs?: number | null;
  /** Bounded, non-blocking telemetry-queue configuration (Phase 3, fixes B4). */
  telemetry?: TelemetryQueueOptions;
}

export interface BaseRuntimeBundle {
  runtime: OpenBoxRuntime;
  runContext: RunContextStore;
  /** The ONE bounded telemetry sender this controller owns — see `shutdown`'s drain-before-close order. */
  telemetryQueue: LifecycleTelemetryQueue;
  /** Idempotent — safe to call more than once; later calls resolve the first call's promise. */
  shutdown: () => Promise<void>;
}

/**
 * The ONE composition root for the CopilotKit path: resolve config, build the
 * base client, an approval poller (HITL only), the stock `CoreAdapter`, the
 * base `OpenBoxRuntime`, and a controller-owned per-run context store (D7).
 *
 * Construction performs zero network calls — the base client, poller,
 * adapter, and runtime are all synchronous object graphs. Startup API-key
 * validation is an explicit, separate opt-in the caller drives itself (see
 * `wrapCopilotRuntimeOptions`'s `validateApiKeyAtStartup`), never triggered
 * from here.
 */
export function buildBaseRuntime(
  configInput: OpenBoxConfigInput,
  opts: BuildBaseRuntimeOptions = {}
): BaseRuntimeBundle {
  const config = resolveBaseConfig(configInput);
  const clientLogger = toClientLogger(opts.logger);

  const client = new OpenBoxClient(config.apiUrl, config.apiKey, {
    timeoutSeconds: config.timeoutSeconds,
    onApiError: config.onApiError,
    identity: config.loadIdentity(),
    sdkVersion: config.sdkVersion,
    sdkEngine: config.sdkEngine,
    sdkLanguage: config.sdkLanguage,
    ...(clientLogger ? { logger: clientLogger } : {})
  });

  // Aborts an in-flight approval wait on shutdown (base P0b) — composed with
  // the per-request poll timeout inside the base `ApprovalPoller`/`OpenBoxClient`,
  // never a "stop new runs" latch by itself (see the teardown-order comment
  // on `shutdown` below).
  const shutdownController = new AbortController();

  // Critical: the default `OpenBoxRuntime` builds a `CoreAdapter` with NO
  // poller, so REQUIRE_APPROVAL fails safe (rejected) unless a poller is
  // wired in here when HITL is enabled.
  const approvalPoller = config.hitl.enabled
    ? new ApprovalPoller(client, {
        maxWaitMs:
          opts.approvalMaxWaitMs === undefined
            ? DEFAULT_APPROVAL_MAX_WAIT_MS
            : opts.approvalMaxWaitMs,
        abortSignal: shutdownController.signal
      })
    : null;

  // Stock `CoreAdapter` only — no custom framework adapter (RT-F12). It
  // already enforces the no-poller + incomplete-correlation fail-safes for
  // REQUIRE_APPROVAL and routes BLOCK/HALT through `raiseLifecycleBlocked`;
  // CopilotKit-specific error translation happens at the caller boundary
  // (Phases 4-5), not inside a reimplemented adapter.
  const adapter = new CoreAdapter({ approvalPoller });

  const contextStore = new ContextStore();

  const runtime = new OpenBoxRuntime(config, {
    client,
    adapter,
    contextStore,
    ...(clientLogger ? { logger: clientLogger } : {})
  });

  // Per-run store (D7): distinct from `contextStore` above, which binds
  // per-ACTIVITY scope for the whole runtime. Adapter-owned, one instance per
  // controller — never a process-global.
  const runContext = new RunContextStore();

  // The ONE bounded, non-blocking telemetry sender this controller owns
  // (Phase 3, fixes B4) — constructed once here so `maxConcurrentSends`/
  // `maxPendingEvents` bound resource use across every run this controller
  // serves, never per-middleware-instance (see `types.ts`'s
  // `OpenBoxMiddlewareOptions.telemetry` doc).
  const telemetryQueue = new LifecycleTelemetryQueue(
    { client, ...(opts.logger ? { logger: opts.logger } : {}) },
    opts.telemetry
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (!shutdownPromise) {
      shutdownPromise = (async () => {
        // Teardown order matters (RT-F10):
        //   1. stop new runs (Phase 5 adds a real latch here, refusing new
        //      child runtimes before closing the child-client cache)
        //   2. abort in-flight approvals (below) — never resolve-and-execute
        //      after shutdown has started
        //   3. drain the bounded telemetry queue (Phase 3) — bounded by
        //      `flushTimeoutMs`; the queue itself reports+diagnoses any count
        //      still pending after the timeout, never blocking shutdown.
        //   4. flush instrumentation + restore patched globals (Phase 6 stub)
        //   5. close the runtime last
        shutdownController.abort();
        await telemetryQueue.flush();
        // Phase 6: flush instrumentation + restore any patched globals.
        // Phase 5: await in-flight handoffs, then close cached child runtimes.
        runtime.close();
      })();
    }
    return shutdownPromise;
  };

  return { runtime, runContext, telemetryQueue, shutdown };
}

/**
 * Translate the CopilotKit-facing config input into a
 * `OpenBoxConfig.resolve()` call. Only the fields this SDK's public config
 * input can express today are translated (`apiUrl`, `apiKey`, `agentDid`,
 * `agentPrivateKey`, `governanceTimeout`→`timeoutSeconds`, `onApiError`,
 * `hitlEnabled`→`hitl.enabled`); the remaining legacy fields
 * (`evaluateMaxRetries`, `skipWorkflowTypes`, ...) get their full alias
 * translation in Phase 6.
 */
function resolveBaseConfig(configInput: OpenBoxConfigInput): OpenBoxConfig {
  // The base SDK's own env fallback reads `OPENBOX_API_URL`; this SDK's
  // documented env var is `OPENBOX_URL` — translate explicitly so adopters
  // relying on the documented variable keep working unchanged.
  const apiUrl = configInput.apiUrl ?? process.env["OPENBOX_URL"];

  return OpenBoxConfig.resolve({
    envPrefix: ENV_PREFIX,
    sdkEngine: SDK_METADATA.engine,
    sdkLanguage: SDK_METADATA.language,
    sdkVersion: SDK_METADATA.version,
    ...(apiUrl !== undefined ? { apiUrl } : {}),
    ...(configInput.apiKey !== undefined ? { apiKey: configInput.apiKey } : {}),
    ...(configInput.agentDid !== undefined ? { agentDid: configInput.agentDid } : {}),
    ...(configInput.agentPrivateKey !== undefined
      ? { agentPrivateKey: configInput.agentPrivateKey }
      : {}),
    ...(configInput.governanceTimeout !== undefined
      ? { timeoutSeconds: configInput.governanceTimeout }
      : {}),
    ...(configInput.onApiError !== undefined ? { onApiError: configInput.onApiError } : {}),
    hitl: { ...defaultHitlConfig(), enabled: configInput.hitlEnabled ?? true }
  });
}

/**
 * Adapt this SDK's loose `OpenBoxLogger` (every method optional, variadic
 * args) into the base SDK's `ClientLogger` (all three methods required, a
 * single-string-argument signature). A local method left unset degrades to a
 * silent no-op rather than partially surfacing through the base client.
 */
function toClientLogger(logger: OpenBoxLogger | undefined): ClientLogger | undefined {
  if (!logger) {
    return undefined;
  }
  return {
    error: (message: string) => logger.error?.(message),
    info: (message: string) => logger.info?.(message),
    warn: (message: string) => logger.warn?.(message)
  };
}
