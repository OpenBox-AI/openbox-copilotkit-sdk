import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_PER_WORKFLOW,
  DEFAULT_TTL_MS,
  readSpanBufferEnv,
  SpanBuffer,
  type OverflowEvent
} from "../../../src/spans/span-buffer.js";
import type { SpanData } from "../../../src/spans/span-data.js";

function makeSpan(name: string, traceId = "trace"): SpanData {
  return {
    attributes: {},
    end_time_unix_nano: 1n,
    name,
    span_id: name,
    start_time_unix_nano: 0n,
    status: "ok",
    trace_id: traceId
  };
}

describe("SpanBuffer cap", () => {
  it("evicts oldest spans when per-workflow cap is exceeded and reports overflow", () => {
    const dropped: OverflowEvent[] = [];
    const buffer = new SpanBuffer({
      maxPerWorkflow: 3,
      onOverflow: e => dropped.push(e)
    });

    for (let i = 0; i < 7; i += 1) {
      buffer.append("wf-1", makeSpan(`s-${i}`));
    }

    const remaining = buffer.peek("wf-1");
    expect(remaining.map(s => s.name)).toEqual(["s-4", "s-5", "s-6"]);
    expect(dropped.map(d => d.dropped.name)).toEqual(["s-0", "s-1", "s-2", "s-3"]);
  });

  it("isolates buckets between workflows", () => {
    const buffer = new SpanBuffer();
    buffer.append("wf-a", makeSpan("a-1"));
    buffer.append("wf-b", makeSpan("b-1"));
    buffer.append("wf-a", makeSpan("a-2"));
    expect(buffer.size("wf-a")).toBe(2);
    expect(buffer.size("wf-b")).toBe(1);
  });

  it("flush returns spans and clears the bucket", () => {
    const buffer = new SpanBuffer();
    buffer.append("wf-1", makeSpan("a"));
    buffer.append("wf-1", makeSpan("b"));
    expect(buffer.flush("wf-1").map(s => s.name)).toEqual(["a", "b"]);
    expect(buffer.size("wf-1")).toBe(0);
  });

  it("drain returns all buckets and resets the map", () => {
    const buffer = new SpanBuffer();
    buffer.append("wf-1", makeSpan("a"));
    buffer.append("wf-2", makeSpan("b"));
    const drained = buffer.drain();
    expect(drained.size).toBe(2);
    expect(buffer.workflowCount()).toBe(0);
  });
});

describe("SpanBuffer TTL", () => {
  it("evicts entries that have aged past ttlMs", () => {
    let now = 1000;
    const evictions: { evictedCount: number; workflowId: string }[] = [];
    const buffer = new SpanBuffer({
      clock: () => now,
      onEvict: e => evictions.push(e),
      ttlMs: 100
    });

    buffer.append("wf-1", makeSpan("a"));
    buffer.append("wf-2", makeSpan("b"));
    now += 50;
    buffer.append("wf-2", makeSpan("c"));

    now += 60; // wf-1 is now 110ms old; wf-2 is 60ms old
    const { evicted, workflows } = buffer.evictExpired();

    expect(workflows).toEqual(["wf-1"]);
    expect(evicted).toBe(1);
    expect(evictions).toEqual([{ evictedCount: 1, workflowId: "wf-1" }]);
    expect(buffer.workflowCount()).toBe(1);
  });

  it("preserves entries inside the TTL window", () => {
    let now = 0;
    const buffer = new SpanBuffer({ clock: () => now, ttlMs: 200 });
    buffer.append("wf-1", makeSpan("a"));
    now += 100;
    buffer.evictExpired();
    expect(buffer.size("wf-1")).toBe(1);
  });
});

describe("SpanBuffer timer cleanup", () => {
  it("starts and clears the eviction timer", () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const clearSpy = vi.spyOn(global, "clearInterval");
    const buffer = new SpanBuffer({ ttlMs: 1000 });
    buffer.startEvictionTimer();
    expect(setSpy).toHaveBeenCalled();
    buffer.shutdown();
    expect(clearSpy).toHaveBeenCalled();
    setSpy.mockRestore();
    clearSpy.mockRestore();
  });

  it("is idempotent on repeat startEvictionTimer calls", () => {
    const setSpy = vi.spyOn(global, "setInterval");
    const buffer = new SpanBuffer({ ttlMs: 1000 });
    buffer.startEvictionTimer();
    buffer.startEvictionTimer();
    buffer.startEvictionTimer();
    expect(setSpy).toHaveBeenCalledTimes(1);
    buffer.shutdown();
    setSpy.mockRestore();
  });
});

describe("SpanBuffer — property-style overflow under sustained load", () => {
  it("never exceeds cap × workflows entries no matter how many spans arrive", () => {
    const buffer = new SpanBuffer({ maxPerWorkflow: 5 });
    const workflows = ["wf-a", "wf-b", "wf-c", "wf-d"];
    const totalAppends = 5_000;
    let droppedCount = 0;
    const counted = new SpanBuffer({
      maxPerWorkflow: 5,
      onOverflow: () => {
        droppedCount += 1;
      }
    });

    for (let i = 0; i < totalAppends; i += 1) {
      const wf = workflows[i % workflows.length] as string;
      buffer.append(wf, makeSpan(`s-${i}`));
      counted.append(wf, makeSpan(`s-${i}`));
    }

    let total = 0;
    for (const wf of workflows) {
      const size = buffer.size(wf);
      expect(size).toBeLessThanOrEqual(5);
      total += size;
    }
    expect(total).toBeLessThanOrEqual(5 * workflows.length);
    expect(droppedCount).toBe(totalAppends - 5 * workflows.length);
  });
});

describe("readSpanBufferEnv", () => {
  it("returns defaults when env is empty", () => {
    expect(readSpanBufferEnv({})).toEqual({
      disabled: false,
      maxPerWorkflow: DEFAULT_MAX_PER_WORKFLOW,
      ttlMs: DEFAULT_TTL_MS
    });
  });

  it("parses positive integer overrides", () => {
    expect(
      readSpanBufferEnv({
        OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW: "42",
        OPENBOX_SPAN_BUFFER_TTL_MS: "1000"
      })
    ).toEqual({ disabled: false, maxPerWorkflow: 42, ttlMs: 1000 });
  });

  it("falls back to defaults on invalid overrides", () => {
    expect(
      readSpanBufferEnv({
        OPENBOX_SPAN_BUFFER_MAX_PER_WORKFLOW: "-5",
        OPENBOX_SPAN_BUFFER_TTL_MS: "abc"
      })
    ).toEqual({
      disabled: false,
      maxPerWorkflow: DEFAULT_MAX_PER_WORKFLOW,
      ttlMs: DEFAULT_TTL_MS
    });
  });

  it("flags disabled when kill switch is set", () => {
    expect(readSpanBufferEnv({ OPENBOX_DISABLE_SPAN_BUFFER: "1" }).disabled).toBe(
      true
    );
  });
});
