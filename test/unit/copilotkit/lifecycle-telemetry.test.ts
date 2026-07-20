import type { JsonValue } from "@openbox-ai/openbox-sdk-ts";
import { describe, expect, it, vi } from "vitest";

import {
  LifecycleTelemetryQueue,
  type EnqueueTelemetryItem
} from "../../../src/copilotkit/lifecycle-telemetry.js";

import { flushMacrotask } from "./test-utils.js";

/**
 * Unit tests for the phase-03 "Bounded telemetry queue" spec this file
 * implements: overflow drop-newest + the per-run truncation flag, rejection
 * isolation, bounded cross-run concurrency, bounded drain, hung-Core safety,
 * defensive callbacks, and the two-limit payload bound (maxFieldBytes +
 * maxPayloadBytes). Uses a bare `{ evaluate }` client stand-in — the queue
 * only ever calls that one method.
 */

function makeItem(overrides: Partial<EnqueueTelemetryItem> = {}): EnqueueTelemetryItem {
  return {
    eventType: "WorkflowStarted",
    isTerminal: false,
    payload: {
      event_type: "WorkflowStarted",
      run_id: "run-1",
      workflow_id: "wf-1"
    },
    runId: "run-1",
    ...overrides
  };
}

describe("LifecycleTelemetryQueue — overflow + per-run truncation flag", () => {
  it("drop-newest on overflow: counts the drop, diagnoses it, and marks the run truncated so later events divert until the terminal event clears the flag", async () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    const onDiagnostic = vi.fn();
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { maxPendingEvents: 2, onDiagnostic }
    );

    const accepted: string[] = [];
    const item = (eventType: string, isTerminal = false): EnqueueTelemetryItem =>
      makeItem({
        eventType,
        isTerminal,
        onAccepted: () => accepted.push(eventType),
        payload: { event_type: eventType, run_id: "run-1", workflow_id: "wf-1" }
      });

    // Three back-to-back synchronous enqueues — none has had a chance to
    // settle yet, so the 3rd hits the pending cap (2) and is dropped.
    queue.enqueue(item("WorkflowStarted"));
    queue.enqueue(item("SignalReceived"));
    queue.enqueue(item("ActivityStarted"));

    expect(accepted).toEqual(["WorkflowStarted", "SignalReceived"]);
    expect(queue.stats().droppedTelemetryEvents).toBe(1);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "queue-overflow", runId: "run-1" })
    );

    // A later, non-terminal event for the SAME (now-truncated) run diverts —
    // never reaches onAccepted/the queue — even once pending count recovers.
    onDiagnostic.mockClear();
    queue.enqueue(item("ActivityCompleted"));
    expect(accepted).toEqual(["WorkflowStarted", "SignalReceived"]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "run-truncated", runId: "run-1" })
    );

    // The run's own terminal event ALSO diverts (Core must never see a
    // completion for a run whose start it may have missed).
    onDiagnostic.mockClear();
    queue.enqueue(item("WorkflowCompleted", true));
    expect(accepted).toEqual(["WorkflowStarted", "SignalReceived"]);
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "run-truncated", runId: "run-1" })
    );

    // Let the first two (accepted, still-pending) sends settle so the
    // pending-events cap itself no longer masks what we're testing next.
    await queue.flush();

    // The terminal diversion cleared the flag — a brand-new run of events
    // reusing the SAME runId (a fresh run) is accepted normally again.
    queue.enqueue(item("WorkflowStarted"));
    expect(accepted).toEqual(["WorkflowStarted", "SignalReceived", "WorkflowStarted"]);
  });
});

describe("LifecycleTelemetryQueue — rejection isolation", () => {
  it("a rejected evaluate is caught per item, counted, diagnosed, and does not break the chain", async () => {
    const evaluateMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("core unreachable"))
      .mockResolvedValue(null);
    const onDiagnostic = vi.fn();
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { onDiagnostic }
    );

    queue.enqueue(makeItem({ eventType: "WorkflowStarted" }));
    queue.enqueue(makeItem({ eventType: "SignalReceived" }));

    await queue.flush();

    expect(evaluateMock).toHaveBeenCalledTimes(2);
    expect(queue.stats().failedTelemetrySends).toBe(1);
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "send-failed" }));
  });
});

describe("LifecycleTelemetryQueue — bounded cross-run concurrency", () => {
  it("never exceeds maxConcurrentSends in flight, across unrelated runs, and still dispatches every one", async () => {
    let concurrent = 0;
    let peakConcurrent = 0;
    const evaluateMock = vi.fn().mockImplementation(async () => {
      concurrent += 1;
      peakConcurrent = Math.max(peakConcurrent, concurrent);
      // Hold this "in flight" window open across a macrotask so unrelated
      // sends genuinely overlap instead of resolving one at a time.
      await flushMacrotask();
      concurrent -= 1;
      return null;
    });
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { maxConcurrentSends: 8, maxPendingEvents: 100 }
    );

    // 12 DIFFERENT runs — each run's own FIFO chain only ever contributes one
    // concurrent send, so this exercises the GLOBAL cross-run cap, not
    // per-run serialization.
    for (let i = 0; i < 12; i += 1) {
      queue.enqueue(makeItem({ payload: { event_type: "WorkflowStarted" }, runId: `run-${i}` }));
    }

    await queue.flush();

    expect(evaluateMock).toHaveBeenCalledTimes(12);
    expect(peakConcurrent).toBe(8);
    expect(queue.stats().inFlightSends).toBe(0);
    expect(queue.stats().pendingEvents).toBe(0);
  });
});

describe("LifecycleTelemetryQueue — bounded drain", () => {
  it("flush() reports the count still pending once its timeout elapses, and diagnoses the timeout", async () => {
    const evaluateMock = vi.fn().mockImplementation(() => new Promise<null>(() => {}));
    const onDiagnostic = vi.fn();
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { flushTimeoutMs: 20, onDiagnostic }
    );

    queue.enqueue(makeItem({ runId: "run-1" }));
    queue.enqueue(makeItem({ runId: "run-2" }));

    const result = await queue.flush();

    expect(result).toEqual({ notFlushed: 2 });
    expect(onDiagnostic).toHaveBeenCalledWith(expect.objectContaining({ reason: "flush-timeout" }));
  });

  it("flush() resolves immediately (notFlushed: 0) once every send has already settled", async () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    const queue = new LifecycleTelemetryQueue({ client: { evaluate: evaluateMock } });

    queue.enqueue(makeItem());
    await expect(queue.flush()).resolves.toEqual({ notFlushed: 0 });
  });
});

describe("LifecycleTelemetryQueue — hung-Core safety", () => {
  it("a never-resolving evaluate never blocks enqueue() and the pending cap is still respected", () => {
    const evaluateMock = vi.fn().mockImplementation(() => new Promise<null>(() => {}));
    const onDiagnostic = vi.fn();
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { maxPendingEvents: 3, onDiagnostic }
    );

    const accepted: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      queue.enqueue(
        makeItem({
          onAccepted: () => accepted.push(i),
          runId: `run-${i}`
        })
      );
    }

    // Every enqueue() call above returned synchronously (this whole test body
    // never awaits anything) — a permanently hung evaluate cannot block it —
    // and the global cap was never exceeded.
    expect(accepted).toHaveLength(3);
    expect(queue.stats().pendingEvents).toBe(3);
    expect(queue.stats().droppedTelemetryEvents).toBe(2);
  });
});

describe("LifecycleTelemetryQueue — defensive callbacks", () => {
  it("a throwing onAccepted or onDiagnostic is caught, logged, and never breaks the queue", async () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    const logger = { warn: vi.fn() };
    const onDiagnostic = vi.fn().mockImplementation(() => {
      throw new Error("onDiagnostic boom");
    });
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock }, logger },
      { maxPendingEvents: 1, onDiagnostic }
    );

    const onAccepted = vi.fn().mockImplementation(() => {
      throw new Error("onAccepted boom");
    });
    queue.enqueue(makeItem({ onAccepted, runId: "run-1" }));
    // A second enqueue while the first is still pending overflows the
    // maxPendingEvents:1 cap, exercising the throwing onDiagnostic path too.
    queue.enqueue(makeItem({ runId: "run-2" }));

    expect(onAccepted).toHaveBeenCalledTimes(1);
    expect(onDiagnostic).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    // The queue is still fully functional afterward.
    await expect(queue.flush()).resolves.toEqual({ notFlushed: 0 });
  });
});

describe("LifecycleTelemetryQueue — maxPayloadBytes envelope bound", () => {
  it("truncates the largest oversized fields to preview+hash markers until the whole envelope fits, never touching correlation fields", () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    // A truncated-field marker itself is a couple hundred bytes (a 256-byte
    // preview + a 64-char hash + fixed keys), so with TWO oversized fields
    // maxPayloadBytes must be large enough to fit two collapsed markers plus
    // the small correlation fields — this proves the "several large fields
    // together still exceed a per-field-only cap" scenario without also
    // exercising the (separately tested) irreducible-overflow drop path.
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { maxFieldBytes: 100, maxPayloadBytes: 1200 }
    );

    const accepted: Record<string, JsonValue>[] = [];
    queue.enqueue(
      makeItem({
        eventType: "ActivityCompleted",
        onAccepted: payload => accepted.push(payload),
        payload: {
          activity_id: "act-1",
          activity_input: "a".repeat(4000),
          activity_output: "b".repeat(4000),
          event_type: "ActivityCompleted",
          run_id: "run-1",
          status: "completed",
          workflow_id: "wf-1"
        }
      })
    );

    expect(accepted).toHaveLength(1);
    const sent = accepted[0]!;

    // Correlation fields survive verbatim.
    expect(sent.workflow_id).toBe("wf-1");
    expect(sent.run_id).toBe("run-1");
    expect(sent.activity_id).toBe("act-1");
    expect(sent.status).toBe("completed");

    // Both oversized fields collapsed to a bounded preview+hash marker.
    expect((sent.activity_input as Record<string, unknown>).__openbox_truncated).toBe(true);
    expect((sent.activity_output as Record<string, unknown>).__openbox_truncated).toBe(true);

    // The whole envelope now fits under maxPayloadBytes.
    expect(Buffer.byteLength(JSON.stringify(sent), "utf8")).toBeLessThanOrEqual(1200);
  });

  it("drops the event and diagnoses it when the envelope is irreducibly over maxPayloadBytes even after every truncatable field is collapsed", () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    const onDiagnostic = vi.fn();
    // A cap smaller than the correlation-field-only remainder can ever reach.
    const queue = new LifecycleTelemetryQueue(
      { client: { evaluate: evaluateMock } },
      { maxFieldBytes: 50, maxPayloadBytes: 10, onDiagnostic }
    );

    const onAccepted = vi.fn();
    queue.enqueue(
      makeItem({
        eventType: "ActivityCompleted",
        onAccepted,
        payload: {
          activity_id: "act-1",
          event_type: "ActivityCompleted",
          run_id: "run-1",
          status: "completed",
          workflow_id: "wf-1"
        }
      })
    );

    expect(onAccepted).not.toHaveBeenCalled();
    expect(evaluateMock).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ reason: "payload-oversize-dropped" })
    );
  });
});

describe("LifecycleTelemetryQueue — endRun", () => {
  it("is idempotent and safe to call for a run that was never enqueued", () => {
    const evaluateMock = vi.fn().mockResolvedValue(null);
    const queue = new LifecycleTelemetryQueue({ client: { evaluate: evaluateMock } });
    expect(() => {
      queue.endRun("never-seen");
      queue.endRun("never-seen");
    }).not.toThrow();
  });
});
