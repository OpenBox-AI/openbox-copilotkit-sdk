import { ActivityContext, EvaluationResult, Verdict } from "@openbox-ai/openbox-sdk-ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildBaseRuntime } from "../../../src/copilotkit/internal/base-runtime-builder.js";

const CONFIG = {
  apiKey: "obx_test_base_runtime_builder",
  apiUrl: "http://localhost:9999"
};

function requireApprovalResult(): EvaluationResult {
  const result = new EvaluationResult();
  result.verdict = Verdict.REQUIRE_APPROVAL;
  return result;
}

function fullActivityContext(): ActivityContext {
  return new ActivityContext({
    activityId: "activity-1",
    runId: "run-1",
    workflowId: "wf-1"
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status: 200
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildBaseRuntime", () => {
  it("performs zero network calls on default construction", () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("unexpected fetch call during construction"));

    const built = buildBaseRuntime(CONFIG);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(built.runtime).toBeDefined();
    expect(built.runContext).toBeDefined();
  });

  it("does not construct an approval poller when hitl is disabled — REQUIRE_APPROVAL fails safe immediately", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("no poller should ever poll"));

    const built = buildBaseRuntime({ ...CONFIG, hitlEnabled: false });

    await expect(
      built.runtime.adapter.handleApproval(requireApprovalResult(), fullActivityContext())
    ).rejects.toThrow(/no approval flow is configured/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("wires an approval poller into the adapter when hitl is enabled (REQUIRE_APPROVAL polls instead of failing safe immediately)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ verdict: "allow" }));

    const built = buildBaseRuntime({ ...CONFIG, hitlEnabled: true });

    await expect(
      built.runtime.adapter.handleApproval(requireApprovalResult(), fullActivityContext())
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("defaults hitl to enabled when hitlEnabled is not set", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse({ verdict: "allow" }));

    const built = buildBaseRuntime(CONFIG);

    await expect(
      built.runtime.adapter.handleApproval(requireApprovalResult(), fullActivityContext())
    ).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalled();
  });

  it("shutdown is idempotent and closes the runtime exactly once", async () => {
    const built = buildBaseRuntime(CONFIG);
    const closeSpy = vi.spyOn(built.runtime, "close");

    const first = built.shutdown();
    const second = built.shutdown();

    await expect(first).resolves.toBeUndefined();
    await expect(second).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);

    // A third, later call still resolves the same idempotent promise.
    await expect(built.shutdown()).resolves.toBeUndefined();
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("exposes one telemetryQueue instance and drains it BEFORE closing the runtime (Phase 3 teardown order)", async () => {
    const built = buildBaseRuntime(CONFIG);
    expect(built.telemetryQueue).toBeDefined();

    const order: string[] = [];
    const flushSpy = vi
      .spyOn(built.telemetryQueue, "flush")
      .mockImplementation(async () => {
        order.push("flush");
        return { notFlushed: 0 };
      });
    const closeSpy = vi.spyOn(built.runtime, "close").mockImplementation(() => {
      order.push("close");
    });

    await built.shutdown();

    expect(flushSpy).toHaveBeenCalledTimes(1);
    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["flush", "close"]);
  });

  it("threads telemetry options into the queue it constructs", async () => {
    // This test only cares whether the option reached the queue instance
    // (proven by the overflow below), never whether a send actually
    // completes — stub `fetch` so it doesn't attempt a real network call.
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("no network in this test"));

    const onDiagnostic = vi.fn();
    const built = buildBaseRuntime(CONFIG, {
      telemetry: { maxPendingEvents: 1, onDiagnostic }
    });

    // Two synchronous enqueues against a cap of 1 — the second overflows,
    // proving the configured option actually reached the queue instance.
    built.telemetryQueue.enqueue({
      eventType: "WorkflowStarted",
      isTerminal: false,
      payload: { event_type: "WorkflowStarted", run_id: "run-1", workflow_id: "wf-1" },
      runId: "run-1"
    });
    built.telemetryQueue.enqueue({
      eventType: "SignalReceived",
      isTerminal: false,
      payload: { event_type: "SignalReceived", run_id: "run-1", workflow_id: "wf-1" },
      runId: "run-1"
    });

    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "queue-overflow" }));
    await built.shutdown();
  });

  describe("module import — global purity", () => {
    it("does not mutate globalThis.fetch", async () => {
      const fetchBefore = globalThis.fetch;
      await import("../../../src/copilotkit/internal/base-runtime-builder.js");
      expect(globalThis.fetch).toBe(fetchBefore);
    });
  });
});
