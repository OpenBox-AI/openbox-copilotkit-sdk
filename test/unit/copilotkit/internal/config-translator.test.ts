/**
 * Phase 6a: full config-alias translation + one-time deprecation warnings.
 * Exercises `resolveCopilotKitBaseConfig`/`resolveTelemetryQueueOptions`
 * directly (unit-level) with an injected `env` record so no test ever
 * mutates real `process.env`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  resetConfigTranslatorDeprecationWarningsForTests,
  resolveCopilotKitBaseConfig,
  resolveTelemetryQueueOptions
} from "../../../../src/copilotkit/internal/config-translator.js";
import type { OpenBoxLogger } from "../../../../src/copilotkit/types.js";

const VALID_KEY = "obx_test_config_translator";
const VALID_URL = "https://core.test";

function buildLogger(): OpenBoxLogger & { warn: ReturnType<typeof vi.fn> } {
  return { warn: vi.fn() };
}

function warnedFields(logger: { warn: ReturnType<typeof vi.fn> }): string[] {
  return logger.warn.mock.calls.map(call => (call[0] as { field: string }).field);
}

beforeEach(() => {
  resetConfigTranslatorDeprecationWarningsForTests();
});

describe("resolveCopilotKitBaseConfig", () => {
  describe("apiUrl / OPENBOX_URL compat alias", () => {
    it("explicit apiUrl wins over the OPENBOX_URL env alias and never warns", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: "https://explicit.test" },
        undefined,
        logger,
        { OPENBOX_URL: "https://alias.test" }
      );
      expect(config.apiUrl).toBe("https://explicit.test");
      expect(warnedFields(logger)).not.toContain("OPENBOX_URL");
    });

    it("falls back to the deprecated OPENBOX_URL env var and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig({ apiKey: VALID_KEY }, undefined, logger, {
        OPENBOX_URL: "https://alias.test"
      });
      expect(config.apiUrl).toBe("https://alias.test");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "OPENBOX_URL", reason: "deprecated_openbox_url_env" })
      );
    });

    it("still resolves via the base SDK's own OPENBOX_COPILOTKIT_API_URL/OPENBOX_API_URL when OPENBOX_URL is absent (no warning)", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig({ apiKey: VALID_KEY }, undefined, logger, {
        OPENBOX_API_URL: "https://global-env.test"
      });
      expect(config.apiUrl).toBe("https://global-env.test");
      expect(warnedFields(logger)).not.toContain("OPENBOX_URL");
    });
  });

  describe("governanceTimeout -> timeoutSeconds", () => {
    it("explicit value wins over both env tiers and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, governanceTimeout: 45 },
        undefined,
        logger,
        { OPENBOX_COPILOTKIT_GOVERNANCE_TIMEOUT: "10", OPENBOX_GOVERNANCE_TIMEOUT: "20" }
      );
      expect(config.timeoutSeconds).toBe(45);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "governanceTimeout", reason: "deprecated_governance_timeout" })
      );
    });

    it("OPENBOX_COPILOTKIT_GOVERNANCE_TIMEOUT wins over the plain OPENBOX_ tier", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        { OPENBOX_COPILOTKIT_GOVERNANCE_TIMEOUT: "10", OPENBOX_GOVERNANCE_TIMEOUT: "20" }
      );
      expect(config.timeoutSeconds).toBe(10);
    });

    it("falls back to the plain OPENBOX_GOVERNANCE_TIMEOUT tier when the prefixed var is absent", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        { OPENBOX_GOVERNANCE_TIMEOUT: "20" }
      );
      expect(config.timeoutSeconds).toBe(20);
    });

    it("defaults to the base SDK's own 30s with no warning when nothing is supplied", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        {}
      );
      expect(config.timeoutSeconds).toBe(30);
      expect(warnedFields(logger)).not.toContain("governanceTimeout");
    });
  });

  describe("hitlEnabled -> hitl.enabled", () => {
    it("explicit false is honored and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, hitlEnabled: false },
        undefined,
        logger,
        {}
      );
      expect(config.hitl.enabled).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "hitlEnabled", reason: "deprecated_hitl_enabled" })
      );
    });

    it("resolves via env (OPENBOX_HITL_ENABLED) when not explicit, and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        { OPENBOX_HITL_ENABLED: "false" }
      );
      expect(config.hitl.enabled).toBe(false);
      expect(warnedFields(logger)).toContain("hitlEnabled");
    });

    it("defaults to enabled=true with no warning when unset", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        {}
      );
      expect(config.hitl.enabled).toBe(true);
      expect(warnedFields(logger)).not.toContain("hitlEnabled");
    });
  });

  describe("skipHitlActivityTypes -> hitl.skipActivityTypes", () => {
    it("translates the CSV env alias into a Set and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        { OPENBOX_SKIP_HITL_ACTIVITY_TYPES: "foo, bar" }
      );
      expect(config.hitl.skipActivityTypes).toEqual(new Set(["foo", "bar"]));
      expect(warnedFields(logger)).toContain("skipHitlActivityTypes");
    });
  });

  describe("skip*/send*Event -> gate.*", () => {
    it("translates skipWorkflowTypes (explicit iterable) into gate.skipWorkflowTypes and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, skipWorkflowTypes: ["wf-a", "wf-b"] },
        undefined,
        logger,
        {}
      );
      expect(config.gate.skipWorkflowTypes).toEqual(new Set(["wf-a", "wf-b"]));
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "skipWorkflowTypes", reason: "deprecated_skip_workflow_types" })
      );
    });

    it("translates sendStartEvent (explicit boolean) into gate.sendStartEvent and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, sendStartEvent: false },
        undefined,
        logger,
        {}
      );
      expect(config.gate.sendStartEvent).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "sendStartEvent", reason: "deprecated_send_start_event" })
      );
    });

    it("leaves gate defaults untouched with no warnings when nothing legacy is supplied", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        {}
      );
      expect(config.gate.sendStartEvent).toBe(true);
      expect(config.gate.sendActivityStartEvent).toBe(true);
      expect(config.gate.skipWorkflowTypes.size).toBe(0);
      expect(logger.warn).not.toHaveBeenCalled();
    });
  });

  describe("evaluateMaxRetries / evaluateRetryBaseDelayMs -- warn only, no base equivalent", () => {
    it("warns for both fields when supplied and never reimplements retries (no field exists on the resolved config)", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        {
          apiKey: VALID_KEY,
          apiUrl: VALID_URL,
          evaluateMaxRetries: 5,
          evaluateRetryBaseDelayMs: 500
        },
        undefined,
        logger,
        {}
      );
      expect(warnedFields(logger)).toEqual(
        expect.arrayContaining(["evaluateMaxRetries", "evaluateRetryBaseDelayMs"])
      );
      expect(config).not.toHaveProperty("evaluateMaxRetries");
      expect(config).not.toHaveProperty("evaluateRetryBaseDelayMs");
    });

    it("also warns when resolved via the OPENBOX_EVALUATE_MAX_RETRIES/OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS env tier (no explicit field needed)", () => {
      const logger = buildLogger();
      resolveCopilotKitBaseConfig({ apiKey: VALID_KEY, apiUrl: VALID_URL }, undefined, logger, {
        OPENBOX_EVALUATE_MAX_RETRIES: "3",
        OPENBOX_EVALUATE_RETRY_BASE_DELAY_MS: "100"
      });
      expect(warnedFields(logger)).toEqual(
        expect.arrayContaining(["evaluateMaxRetries", "evaluateRetryBaseDelayMs"])
      );
    });
  });

  describe("httpCapture -- inert, warn only", () => {
    it("warns when supplied and never affects the resolved instrumentation config", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, httpCapture: false },
        { enabled: true },
        logger,
        {}
      );
      expect(warnedFields(logger)).toContain("httpCapture");
      // httpCapture never reaches instrumentation.httpEnabled -- base default stays on.
      expect(config.instrumentation.httpEnabled).toBe(true);
    });

    it("also warns when resolved via the OPENBOX_HTTP_CAPTURE env tier", () => {
      const logger = buildLogger();
      resolveCopilotKitBaseConfig({ apiKey: VALID_KEY, apiUrl: VALID_URL }, undefined, logger, {
        OPENBOX_HTTP_CAPTURE: "false"
      });
      expect(warnedFields(logger)).toContain("httpCapture");
    });
  });

  describe("instrumentDatabases -- boolean cannot name drivers, warn only", () => {
    it("warns regardless of true/false and never toggles instrumentation.enabled or dbEnabled", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, instrumentDatabases: true },
        undefined,
        logger,
        {}
      );
      expect(warnedFields(logger)).toContain("instrumentDatabases");
      // instrumentation stays OFF -- the legacy boolean cannot turn it on.
      expect(config.instrumentation.enabled).toBe(false);
      expect(config.instrumentation.dbEnabled).toBe(true);
    });

    it("also warns when resolved via the OPENBOX_INSTRUMENT_DATABASES env tier", () => {
      const logger = buildLogger();
      resolveCopilotKitBaseConfig({ apiKey: VALID_KEY, apiUrl: VALID_URL }, undefined, logger, {
        OPENBOX_INSTRUMENT_DATABASES: "true"
      });
      expect(warnedFields(logger)).toContain("instrumentDatabases");
    });
  });

  describe("instrumentFileIo -> instrumentation.fileEnabled (translated only while enabled)", () => {
    it("maps to fileEnabled when instrumentation.enabled is true, and warns once", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, instrumentFileIo: false },
        { enabled: true },
        logger,
        {}
      );
      expect(config.instrumentation.fileEnabled).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.objectContaining({ field: "instrumentFileIo", reason: "deprecated_instrument_file_io" })
      );
    });

    it("still warns but does NOT translate when instrumentation stays off (nothing to install)", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, instrumentFileIo: false },
        undefined,
        logger,
        {}
      );
      expect(config.instrumentation.enabled).toBe(false);
      expect(config.instrumentation.fileEnabled).toBe(true); // base default, untouched
      expect(warnedFields(logger)).toContain("instrumentFileIo");
    });

    it("resolves via the OPENBOX_INSTRUMENT_FILE_IO env tier when not explicit, and warns", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        { enabled: true },
        logger,
        { OPENBOX_INSTRUMENT_FILE_IO: "false" }
      );
      expect(config.instrumentation.fileEnabled).toBe(false);
      expect(warnedFields(logger)).toContain("instrumentFileIo");
    });
  });

  describe("instrumentation.enabled -- OFF by default in 0.4.0", () => {
    it("defaults instrumentation.enabled to false when the new option is not supplied", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        undefined,
        logger,
        {}
      );
      expect(config.instrumentation.enabled).toBe(false);
    });

    it("turns on only when instrumentation.enabled is explicitly true", () => {
      const logger = buildLogger();
      const config = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL },
        { enabled: true },
        logger,
        {}
      );
      expect(config.instrumentation.enabled).toBe(true);
    });
  });

  describe("validate -- preserved, never warns (not deprecated)", () => {
    it("does not warn even though the field is present on OpenBoxConfigInput", () => {
      const logger = buildLogger();
      resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, validate: false },
        undefined,
        logger,
        {}
      );
      expect(warnedFields(logger)).not.toContain("validate");
    });
  });

  describe("one-time warning semantics (D3: not per call)", () => {
    it("warns exactly once across two separate resolutions of the same deprecated field", () => {
      const logger = buildLogger();
      resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, hitlEnabled: false },
        undefined,
        logger,
        {}
      );
      const secondConfig = resolveCopilotKitBaseConfig(
        { apiKey: VALID_KEY, apiUrl: VALID_URL, hitlEnabled: false },
        undefined,
        logger,
        {}
      );

      const hitlWarnings = logger.warn.mock.calls.filter(
        call => (call[0] as { field: string }).field === "hitlEnabled"
      );
      expect(hitlWarnings).toHaveLength(1);
      // The deprecated field still takes effect on EVERY call, not just the first.
      expect(secondConfig.hitl.enabled).toBe(false);
    });
  });
});

describe("resolveTelemetryQueueOptions", () => {
  it("returns the new telemetry option untouched when no deprecated alias is supplied", () => {
    const logger = buildLogger();
    const telemetryOption = { maxPendingEvents: 42 };
    const resolved = resolveTelemetryQueueOptions({ apiKey: VALID_KEY, apiUrl: VALID_URL }, telemetryOption, logger, {});
    expect(resolved).toBe(telemetryOption);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("maps the deprecated maxEvaluatePayloadBytes onto maxPayloadBytes as a fallback, and warns once", () => {
    const logger = buildLogger();
    const resolved = resolveTelemetryQueueOptions(
      { apiKey: VALID_KEY, apiUrl: VALID_URL, maxEvaluatePayloadBytes: 4096 },
      undefined,
      logger,
      {}
    );
    expect(resolved).toEqual({ maxPayloadBytes: 4096 });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ field: "maxEvaluatePayloadBytes", reason: "deprecated_max_evaluate_payload_bytes" })
    );
  });

  it("the new telemetry.maxPayloadBytes wins over the deprecated alias, but the alias still warns", () => {
    const logger = buildLogger();
    const telemetryOption = { maxPayloadBytes: 8192 };
    const resolved = resolveTelemetryQueueOptions(
      { apiKey: VALID_KEY, apiUrl: VALID_URL, maxEvaluatePayloadBytes: 4096 },
      telemetryOption,
      logger,
      {}
    );
    expect(resolved).toEqual({ maxPayloadBytes: 8192 });
    expect(warnedFields(logger)).toContain("maxEvaluatePayloadBytes");
  });

  it("resolves the deprecated alias via env (OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES) when not explicit", () => {
    const logger = buildLogger();
    const resolved = resolveTelemetryQueueOptions(
      { apiKey: VALID_KEY, apiUrl: VALID_URL },
      undefined,
      logger,
      { OPENBOX_MAX_EVALUATE_PAYLOAD_BYTES: "2048" }
    );
    expect(resolved).toEqual({ maxPayloadBytes: 2048 });
  });
});
