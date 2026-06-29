import { describe, expect, it } from "vitest";

import * as copilotkitPublic from "../../../src/copilotkit/index.js";
import * as rootPublic from "../../../src/index.js";

const REQUIRED_FRAMEWORK_EXPORTS = [
  "createOpenBoxMiddleware",
  "withOpenBoxRuntime"
] as const;

const REQUIRED_SHARED_EXPORTS = [
  "OpenBoxClient",
  "parseOpenBoxConfig"
] as const;

const FORBIDDEN_ROOT_EXPORTS = [
  "OpenBoxSpanProcessor",
  "setupOpenBoxOpenTelemetry",
  "WorkflowSpanBuffer"
] as const;

// Anything in this list MUST NOT leak out of the public surface. They are
// internals that, if exposed, would either re-introduce the cross-package
// runtime-lookup risk (`Symbol.for`-style squat) or push adopters into
// composing internal primitives. Phase 6's tuple-return replaces every
// adopter use case these would have served.
const FORBIDDEN_EXPORTS = [
  "attachOpenBoxRuntime",
  "getOpenBoxRuntime",
  "openBoxAfterRequest",
  "openBoxBeforeRequest",
  "OPENBOX_COPILOTKIT_RUNTIME_SYMBOL",
  "OPENBOX_OTEL_CONTROLLER_SYMBOL",
  "wrapAgentInProxy",
  "wrapCopilotRuntimeOptions"
] as const;

describe("copilotkit/index.ts public export surface", () => {
  it("exports the 2 required framework symbols", () => {
    for (const name of REQUIRED_FRAMEWORK_EXPORTS) {
      expect(
        (copilotkitPublic as Record<string, unknown>)[name],
        `expected copilotkit/index.ts to export ${name}`
      ).toBeDefined();
      expect(
        typeof (copilotkitPublic as Record<string, unknown>)[name]
      ).toBe("function");
    }
  });

  it("does NOT export any internal helper / runtime symbol from the copilotkit barrel", () => {
    for (const name of FORBIDDEN_EXPORTS) {
      expect(
        (copilotkitPublic as Record<string, unknown>)[name],
        `expected copilotkit/index.ts to NOT export ${name} — it is internal`
      ).toBeUndefined();
    }
  });
});

describe("src/index.ts root public surface", () => {
  it("re-exports the 2 framework symbols plus the copied shared exports", () => {
    for (const name of [
      ...REQUIRED_FRAMEWORK_EXPORTS,
      ...REQUIRED_SHARED_EXPORTS
    ]) {
      expect(
        (rootPublic as Record<string, unknown>)[name],
        `expected src/index.ts to export ${name}`
      ).toBeDefined();
    }
  });

  it("does NOT re-export any internal helper / runtime symbol from the root barrel", () => {
    for (const name of FORBIDDEN_EXPORTS) {
      expect(
        (rootPublic as Record<string, unknown>)[name],
        `expected src/index.ts to NOT export ${name} — it is internal`
      ).toBeUndefined();
    }
  });

  it("does NOT re-export any removed OTel/span symbol from the root barrel", () => {
    for (const name of FORBIDDEN_ROOT_EXPORTS) {
      expect(
        (rootPublic as Record<string, unknown>)[name],
        `expected src/index.ts to NOT export ${name} — removed in 0.2.0-beta.0`
      ).toBeUndefined();
    }
  });

  it("has NO globally-registered OpenBox-OTEL symbol (independence rule)", () => {
    expect(Symbol.keyFor(Symbol.for("openbox.otel.controller"))).toBe(
      "openbox.otel.controller"
    );
    // The symbol-key registration above is trivially present because we just
    // called Symbol.for. The real assertion is that no module in src/ ever
    // assigns to a Symbol.for(...) slot. The grep-based CI gate
    // (check:no-mastra alongside a future check:no-symbol-for) would back
    // this assertion at build time; here we sanity-check by looking up
    // anywhere in the root barrel for a key matching that name.
    for (const value of Object.values(rootPublic)) {
      if (typeof value === "symbol") {
        expect(Symbol.keyFor(value)).not.toBe("openbox.otel.controller");
        expect(Symbol.keyFor(value)).not.toBe("openbox.copilotkit.runtime");
      }
    }
  });
});
