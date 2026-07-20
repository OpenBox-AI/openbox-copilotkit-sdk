import {
  defaultGateConfig,
  defaultHitlConfig,
  defaultInstrumentationConfig,
  type GateConfig,
  type HitlConfig,
  type InstrumentationConfig
} from "@openbox-ai/openbox-sdk-ts/config";

import type { OpenBoxConfigInput } from "../../config/openbox-config.js";
import type { OpenBoxLogger } from "../types.js";

import {
  resolveBooleanAlias,
  resolveIntegerAlias,
  resolveStringSetAlias
} from "./config-alias-env-resolvers.js";
import { warnDeprecatedOnce } from "./config-deprecation-warnings.js";
import type { OpenBoxInstrumentationOptions } from "./instrumentation.js";

/**
 * Per-nested-group resolvers for `config-translator.ts`'s `hitl`/`gate`/
 * `instrumentation` `OpenBoxConfig` groups, plus the retry-field warnings.
 * Split out purely to keep `config-translator.ts` at top-level-orchestration
 * length -- no behavior change, mirrors the rest of this directory's
 * split-by-concern convention (`lifecycle-telemetry*.ts`).
 */

/**
 * Resolve the `hitl` nested group: `hitlEnabled` -> `hitl.enabled` (deprecated
 * flat alias, mapping kept as-is from the pre-6a builder) and
 * `skipHitlActivityTypes` -> `hitl.skipActivityTypes` (new translation).
 */
export function resolveHitlConfig(
  configInput: OpenBoxConfigInput,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv
): HitlConfig {
  const enabledAlias = resolveBooleanAlias(configInput.hitlEnabled, "HITL_ENABLED", env);
  if (enabledAlias !== undefined) {
    warnDeprecatedOnce(
      logger,
      "hitlEnabled",
      "deprecated_hitl_enabled",
      "`hitlEnabled` is deprecated in favor of the base SDK's `hitl.enabled`; it continues to work."
    );
  }
  const skipHitlActivityTypes = resolveStringSetAlias(
    configInput.skipHitlActivityTypes,
    "SKIP_HITL_ACTIVITY_TYPES",
    env
  );
  if (skipHitlActivityTypes !== undefined) {
    warnDeprecatedOnce(
      logger,
      "skipHitlActivityTypes",
      "deprecated_skip_hitl_activity_types",
      "`skipHitlActivityTypes` is deprecated in favor of the base SDK's `hitl.skipActivityTypes`; it continues to work."
    );
  }

  return {
    ...defaultHitlConfig(),
    enabled: enabledAlias ?? true,
    ...(skipHitlActivityTypes !== undefined ? { skipActivityTypes: skipHitlActivityTypes } : {})
  };
}

/**
 * Resolve the `gate` nested group: `skipWorkflowTypes`/`skipSignals`/
 * `skipActivityTypes`/`sendStartEvent`/`sendActivityStartEvent` -> the
 * matching `GateConfig` field (all newly translated in 6a -- previously these
 * legacy fields reached `buildBaseRuntime` and were silently dropped).
 */
export function resolveGateConfig(
  configInput: OpenBoxConfigInput,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv
): GateConfig {
  const skipWorkflowTypes = resolveStringSetAlias(configInput.skipWorkflowTypes, "SKIP_WORKFLOW_TYPES", env);
  const skipSignals = resolveStringSetAlias(configInput.skipSignals, "SKIP_SIGNALS", env);
  const skipActivityTypes = resolveStringSetAlias(configInput.skipActivityTypes, "SKIP_ACTIVITY_TYPES", env);
  const sendStartEvent = resolveBooleanAlias(configInput.sendStartEvent, "SEND_START_EVENT", env);
  const sendActivityStartEvent = resolveBooleanAlias(
    configInput.sendActivityStartEvent,
    "SEND_ACTIVITY_START_EVENT",
    env
  );

  const deprecations: ReadonlyArray<readonly [string, string, unknown, string]> = [
    ["skipWorkflowTypes", "deprecated_skip_workflow_types", skipWorkflowTypes, "gate.skipWorkflowTypes"],
    ["skipSignals", "deprecated_skip_signals", skipSignals, "gate.skipSignals"],
    ["skipActivityTypes", "deprecated_skip_activity_types", skipActivityTypes, "gate.skipActivityTypes"],
    ["sendStartEvent", "deprecated_send_start_event", sendStartEvent, "gate.sendStartEvent"],
    [
      "sendActivityStartEvent",
      "deprecated_send_activity_start_event",
      sendActivityStartEvent,
      "gate.sendActivityStartEvent"
    ]
  ];
  for (const [field, reason, value, target] of deprecations) {
    if (value !== undefined) {
      warnDeprecatedOnce(
        logger,
        field,
        reason,
        `\`${field}\` is deprecated in favor of the base SDK's \`${target}\`; it continues to work.`
      );
    }
  }

  return {
    ...defaultGateConfig(),
    ...(skipWorkflowTypes !== undefined ? { skipWorkflowTypes } : {}),
    ...(skipSignals !== undefined ? { skipSignals } : {}),
    ...(skipActivityTypes !== undefined ? { skipActivityTypes } : {}),
    ...(sendStartEvent !== undefined ? { sendStartEvent } : {}),
    ...(sendActivityStartEvent !== undefined ? { sendActivityStartEvent } : {})
  };
}

/**
 * Resolve the `instrumentation` nested group. `instrumentation.enabled`
 * (public option, default `false` -- OFF by default in `0.4.0`) is the ONLY
 * thing that turns instrumentation on; the legacy `instrumentDatabases`
 * boolean CANNOT express "which driver(s)" so it is warn-only (never mapped
 * to `instrumentation.databases`, which requires explicit driver names).
 * `instrumentFileIo` DOES map 1:1 to `instrumentation.fileEnabled`, but only
 * takes effect while instrumentation is actually enabled.
 */
export function resolveInstrumentationConfig(
  configInput: OpenBoxConfigInput,
  instrumentationOption: OpenBoxInstrumentationOptions | undefined,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv
): InstrumentationConfig {
  const enabled = instrumentationOption?.enabled ?? false;

  const instrumentDatabases = resolveBooleanAlias(configInput.instrumentDatabases, "INSTRUMENT_DATABASES", env);
  if (instrumentDatabases !== undefined) {
    warnDeprecatedOnce(
      logger,
      "instrumentDatabases",
      "deprecated_instrument_databases",
      "`instrumentDatabases` (boolean) is deprecated and has no effect: a boolean cannot name which driver(s) to instrument. " +
        'Pass `instrumentation: { enabled: true, databases: ["pg", "redis", "mysql2", "mongodb"] }` to name drivers explicitly.'
    );
  }

  const instrumentFileIo = resolveBooleanAlias(configInput.instrumentFileIo, "INSTRUMENT_FILE_IO", env);
  if (instrumentFileIo !== undefined) {
    warnDeprecatedOnce(
      logger,
      "instrumentFileIo",
      "deprecated_instrument_file_io",
      "`instrumentFileIo` is deprecated in favor of `instrumentation.fileEnabled`; honored only while `instrumentation.enabled` is true."
    );
  }

  const httpCapture = resolveBooleanAlias(configInput.httpCapture, "HTTP_CAPTURE", env);
  if (httpCapture !== undefined) {
    warnDeprecatedOnce(
      logger,
      "httpCapture",
      "deprecated_http_capture",
      "`httpCapture` is inert and will be removed at 1.0.0; enable HTTP governance via `instrumentation: { enabled: true }` instead (httpEnabled defaults on)."
    );
  }

  return {
    ...defaultInstrumentationConfig(),
    enabled,
    ...(enabled && instrumentFileIo !== undefined ? { fileEnabled: instrumentFileIo } : {})
  };
}

/** Warn (no behavior -- no base equivalent exists) for the retry-tuning fields the base client's own transport now owns. */
export function warnDeprecatedRetryFields(
  configInput: OpenBoxConfigInput,
  logger: OpenBoxLogger | undefined,
  env: NodeJS.ProcessEnv
): void {
  if (resolveIntegerAlias(configInput.evaluateMaxRetries, "EVALUATE_MAX_RETRIES", env) !== undefined) {
    warnDeprecatedOnce(
      logger,
      "evaluateMaxRetries",
      "deprecated_evaluate_max_retries",
      "`evaluateMaxRetries` has no base-SDK equivalent and is not reimplemented; the base client's own transport owns retries."
    );
  }
  if (
    resolveIntegerAlias(configInput.evaluateRetryBaseDelayMs, "EVALUATE_RETRY_BASE_DELAY_MS", env) !== undefined
  ) {
    warnDeprecatedOnce(
      logger,
      "evaluateRetryBaseDelayMs",
      "deprecated_evaluate_retry_base_delay_ms",
      "`evaluateRetryBaseDelayMs` has no base-SDK equivalent and is not reimplemented; the base client's own transport owns retries."
    );
  }
}
