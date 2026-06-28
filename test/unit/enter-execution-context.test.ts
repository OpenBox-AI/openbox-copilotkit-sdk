import { describe, expect, it } from "vitest";

import {
  enterOpenBoxExecutionContext,
  getOpenBoxExecutionContext,
  runWithOpenBoxExecutionContext,
  type OpenBoxExecutionContext
} from "../../src/governance/context.js";

describe("enterOpenBoxExecutionContext", () => {
  it("makes the context readable via getOpenBoxExecutionContext in the same async task", async () => {
    await runIsolated(async () => {
      enterOpenBoxExecutionContext({
        metadata: { tenant_id: "tenant-A", trace_id: "trace-A" }
      });

      const ctx = getOpenBoxExecutionContext();
      expect(ctx).toBeDefined();
      expect(ctx?.metadata?.tenant_id).toBe("tenant-A");
      expect(ctx?.metadata?.trace_id).toBe("trace-A");
    });
  });

  it("merges with an active context rather than replacing it", async () => {
    await runWithOpenBoxExecutionContext(
      { metadata: { trace_id: "outer-trace" } },
      async () => {
        enterOpenBoxExecutionContext({
          metadata: { tenant_id: "tenant-B" }
        });

        const ctx = getOpenBoxExecutionContext();
        expect(ctx?.metadata?.trace_id).toBe("outer-trace");
        expect(ctx?.metadata?.tenant_id).toBe("tenant-B");
      }
    );
  });

  it("isolates contexts across concurrent async tasks (no cross-tenant pollution)", async () => {
    const observed: Array<OpenBoxExecutionContext | undefined> = [];

    const tasks = Array.from({ length: 10 }, (_, index) => {
      return runIsolated(async () => {
        enterOpenBoxExecutionContext({
          metadata: { tenant_id: `tenant-${index}` }
        });
        // Yield to the event loop so concurrent tasks interleave; the
        // assertion below would fail if `enterWith` leaked across tasks.
        await new Promise((resolve) => setImmediate(resolve));
        observed.push(getOpenBoxExecutionContext());
      });
    });

    await Promise.all(tasks);

    const tenantIds = observed
      .map((ctx) => ctx?.metadata?.tenant_id)
      .filter((id): id is string => typeof id === "string")
      .sort();

    expect(tenantIds).toEqual(
      Array.from({ length: 10 }, (_, index) => `tenant-${index}`).sort()
    );
  });
});

/**
 * Wrap a callback in `runWithOpenBoxExecutionContext({}, ...)` so each test's
 * `enterWith` call has its own ALS frame and cannot leak into other tests.
 * Without this wrapper, vitest's worker reuses the same async task across
 * tests and `enterWith` would pollute the next test's context.
 */
function runIsolated<T>(callback: () => Promise<T>): Promise<T> {
  return runWithOpenBoxExecutionContext({}, callback);
}
