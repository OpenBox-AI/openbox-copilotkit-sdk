/**
 * `installCopilotKitInstrumentation` is a thin, real pass-through over the
 * base `initOpenBoxInstrumentation` composition root -- these tests exercise
 * it against a REAL `OpenBoxRuntime` (no module mocking, matching this
 * repo's existing test conventions).
 *
 * `strict`/`logger` forwarding is proven by temporarily breaking
 * `globalThis.fetch` (base's own documented failure mode for the fetch
 * target -- `installFetchHttpGovernancePatch` throws when
 * `typeof globalThis.fetch !== "function"`) rather than relying on a
 * driver-module-missing failure: this repo's dev workspace symlinks the base
 * SDK package, whose OWN devDependencies (`pg`/`redis`/`mysql2`/`mongodb`,
 * installed for ITS test suite) resolve right through the symlink, so a
 * missing-driver failure is not reproducible here. `installCopilotKitInstrumentation`
 * is fully synchronous (matching the base composition root's own invariant),
 * so the corruption window never spans an `await`.
 */
import { OpenBoxConfig } from "@openbox-ai/openbox-sdk-ts/config";
import { OpenBoxInstrumentationError } from "@openbox-ai/openbox-sdk-ts/instrumentation";
import { OpenBoxRuntime } from "@openbox-ai/openbox-sdk-ts/runtime";
import { describe, expect, it } from "vitest";

import { installCopilotKitInstrumentation } from "../../../../src/copilotkit/internal/instrumentation.js";

const VALID_KEY = "obx_test_instrumentation_wrapper";
const VALID_URL = "https://core.test";

function buildRuntime(): OpenBoxRuntime {
  // Base's own default `instrumentation.enabled` is `true` (these tests call
  // the wrapper directly, bypassing `config-translator.ts`'s OFF-by-default
  // public resolution) -- every test below restores whatever it patches, so
  // no global leaks across tests.
  return new OpenBoxRuntime(OpenBoxConfig.resolve({ apiKey: VALID_KEY, apiUrl: VALID_URL }));
}

/**
 * Narrow, precise stand-in for `globalThis` used ONLY to null out `fetch` for
 * one synchronous call -- avoids an `any` cast. `Omit` (not an intersection)
 * is required: intersecting `typeof globalThis`'s own non-optional `fetch`
 * with `| undefined` simplifies back to non-optional, so it would still
 * reject `undefined`.
 */
type GlobalWithFetch = Omit<typeof globalThis, "fetch"> & { fetch: typeof fetch | undefined };

describe("installCopilotKitInstrumentation", () => {
  it("forwards `strict: true` -- an unpatchable target throws OpenBoxInstrumentationError instead of degrading", () => {
    const runtime = buildRuntime();
    const originalFetch = globalThis.fetch;
    (globalThis as GlobalWithFetch).fetch = undefined;

    try {
      expect(() => installCopilotKitInstrumentation(runtime, { strict: true })).toThrow(
        OpenBoxInstrumentationError
      );
      // Strict-mode failure rolls back everything installed THIS call (base's
      // own `restoreInstalledSoFar` before re-throwing) -- no controller to
      // shut down.
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("forwards `strict: false` (default) and the logger -- an unpatchable target degrades gracefully and is diagnosed", () => {
    const runtime = buildRuntime();
    const originalFetch = globalThis.fetch;
    (globalThis as GlobalWithFetch).fetch = undefined;
    const errors: string[] = [];
    const logger = {
      error: (message: string) => {
        errors.push(message);
      },
      info: () => undefined,
      warn: () => undefined
    };

    try {
      const controller = installCopilotKitInstrumentation(runtime, {}, logger);
      try {
        expect(controller.installedTargets).not.toContain("fetch");
        expect(errors.some(message => message.includes("fetch"))).toBe(true);
      } finally {
        controller.shutdown();
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("attempts no DB driver when `databases` is omitted, even though `dbEnabled` defaults to true", () => {
    const runtime = buildRuntime();

    const controller = installCopilotKitInstrumentation(runtime, {});
    try {
      expect(controller.installedTargets).not.toEqual(
        expect.arrayContaining(["pg", "redis", "mysql2", "mongodb"])
      );
    } finally {
      controller.shutdown();
    }
  });
});

describe("module import -- registration purity", () => {
  it("does not mutate globalThis.fetch merely by importing", async () => {
    const fetchBefore = globalThis.fetch;
    await import("../../../../src/copilotkit/internal/instrumentation.js");
    expect(globalThis.fetch).toBe(fetchBefore);
  });
});
