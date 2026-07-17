import type { ClientLogger } from "@openbox-ai/openbox-sdk-ts/client";
import {
  initOpenBoxInstrumentation,
  type DatabaseDriverName,
  type OpenBoxInstrumentationController
} from "@openbox-ai/openbox-sdk-ts/instrumentation";
import type { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";

export type { DatabaseDriverName, OpenBoxInstrumentationController };

/**
 * Public opt-in instrumentation surface (phase-06 proposal §14). OFF by
 * default in `0.4.0` — `enabled` gates whether `base-runtime-builder.ts` ever
 * calls `installCopilotKitInstrumentation` below at all; this type's
 * `databases`/`strict` are forwarded verbatim to the base
 * `initOpenBoxInstrumentation` call, `enabled` is read by the CONFIG
 * TRANSLATOR (`config-translator.ts`) to populate the resolved
 * `OpenBoxConfig.instrumentation.enabled` flag, which the builder then
 * branches on — never re-derived here, so there is exactly one source of
 * truth for "is instrumentation on."
 */
export interface OpenBoxInstrumentationOptions {
  /** Master opt-in switch. Default `false` — no target is ever patched unless this is `true`. */
  enabled?: boolean;
  /**
   * Explicit opt-in list of DB drivers to instrument (never auto-detected —
   * matches base's own OQ5 decision). Ignored while `enabled` is not `true`.
   */
  databases?: readonly DatabaseDriverName[];
  /** Escalate an unpatchable target from a hard diagnostic to a thrown `OpenBoxInstrumentationError`. Default `false`. */
  strict?: boolean;
}

/**
 * Thin wrapper over the base `initOpenBoxInstrumentation` composition root.
 * Importing this module registers NOTHING — every side effect (patching
 * fetch/http/https/fs/db) happens only inside the base function, which this
 * wrapper only ever calls when `base-runtime-builder.ts` has already
 * confirmed `config.instrumentation.enabled` is `true` (root-import purity +
 * "off by default" both hold by construction, never by a redundant check
 * here).
 *
 * `options` intentionally accepts the full public `OpenBoxInstrumentationOptions`
 * shape (including `enabled`) for caller convenience — `enabled` is simply
 * unused here, since the builder already decided to call this at all.
 */
export function installCopilotKitInstrumentation(
  runtime: OpenBoxRuntime,
  options: OpenBoxInstrumentationOptions,
  logger?: ClientLogger
): OpenBoxInstrumentationController {
  return initOpenBoxInstrumentation({
    runtime,
    ...(options.databases !== undefined ? { databases: options.databases } : {}),
    ...(options.strict !== undefined ? { strict: options.strict } : {}),
    ...(logger !== undefined ? { logger } : {})
  });
}
