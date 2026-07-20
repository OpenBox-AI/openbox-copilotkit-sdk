import { describe, expect, it } from "vitest";

import {
  InMemoryInterruptStore,
  type PendingInterrupt
} from "../../../../src/copilotkit/internal/interrupt-store.js";

function buildPending(overrides: Partial<PendingInterrupt> = {}): PendingInterrupt {
  return {
    activityId: "int-1",
    reason: "approval_required",
    toolName: "deleteAccount",
    workflowId: "thread-1",
    ...overrides
  };
}

describe("InMemoryInterruptStore — save/take/clearRun", () => {
  it("round-trips a saved entry through take (destructive read)", () => {
    const store = new InMemoryInterruptStore();
    const pending = buildPending();

    store.save("run-1", [pending], 60_000);

    expect(store.take("run-1", "int-1")).toEqual(pending);
    // A second take is a miss — take consumes the entry exactly once.
    expect(store.take("run-1", "int-1")).toBeUndefined();
  });

  it("returns undefined for a runId/interruptId that was never saved", () => {
    const store = new InMemoryInterruptStore();
    expect(store.take("no-such-run", "no-such-interrupt")).toBeUndefined();
  });

  it("keys strictly on (runId, interruptId) — a matching interruptId under a different runId is a miss", () => {
    const store = new InMemoryInterruptStore();
    store.save("run-1", [buildPending({ activityId: "int-1" })], 60_000);

    expect(store.take("run-2", "int-1")).toBeUndefined();
    // The original entry survives an unrelated run's failed lookup.
    expect(store.take("run-1", "int-1")).toBeDefined();
  });

  it("save persists multiple interrupts for one run independently", () => {
    const store = new InMemoryInterruptStore();
    store.save(
      "run-1",
      [buildPending({ activityId: "int-1" }), buildPending({ activityId: "int-2" })],
      60_000
    );

    expect(store.take("run-1", "int-1")?.activityId).toBe("int-1");
    expect(store.take("run-1", "int-2")?.activityId).toBe("int-2");
  });

  it("clearRun drops every remaining entry for a run without affecting other runs", () => {
    const store = new InMemoryInterruptStore();
    store.save("run-1", [buildPending({ activityId: "int-1" })], 60_000);
    store.save("run-2", [buildPending({ activityId: "int-2" })], 60_000);

    store.clearRun("run-1");

    expect(store.take("run-1", "int-1")).toBeUndefined();
    expect(store.take("run-2", "int-2")).toBeDefined();
  });

  it("clearRun on an unknown runId is a harmless no-op", () => {
    const store = new InMemoryInterruptStore();
    expect(() => store.clearRun("never-saved")).not.toThrow();
  });
});

describe("InMemoryInterruptStore — TTL expiry (local correlation cleanup only)", () => {
  it("treats an expired entry as a miss (never fabricates — RT-F9 relies on this)", () => {
    let now = 1_000_000;
    const store = new InMemoryInterruptStore({ clock: () => now });

    store.save("run-1", [buildPending()], 5_000);

    now += 5_001; // just past the TTL
    expect(store.take("run-1", "int-1")).toBeUndefined();
  });

  it("returns the entry while still inside the TTL window", () => {
    let now = 1_000_000;
    const store = new InMemoryInterruptStore({ clock: () => now });

    store.save("run-1", [buildPending()], 5_000);

    now += 4_999; // just before the TTL
    expect(store.take("run-1", "int-1")).toBeDefined();
  });

  it("an expired take still removes the entry (no leak on repeated expired reads)", () => {
    let now = 1_000_000;
    const store = new InMemoryInterruptStore({ clock: () => now });
    store.save("run-1", [buildPending()], 1_000);
    now += 1_001;

    expect(store.take("run-1", "int-1")).toBeUndefined();
    // Re-saving the SAME key after the miss must not collide with a leaked entry.
    store.save("run-1", [buildPending()], 60_000);
    expect(store.take("run-1", "int-1")).toBeDefined();
  });
});

describe("InMemoryInterruptStore — bounded FIFO eviction", () => {
  it("evicts the oldest entry once maxEntries is exceeded", () => {
    const store = new InMemoryInterruptStore({ maxEntries: 2 });

    store.save("run-1", [buildPending({ activityId: "int-1" })], 60_000);
    store.save("run-1", [buildPending({ activityId: "int-2" })], 60_000);
    store.save("run-1", [buildPending({ activityId: "int-3" })], 60_000);

    // "int-1" was inserted first — it is the one evicted.
    expect(store.take("run-1", "int-1")).toBeUndefined();
    expect(store.take("run-1", "int-2")).toBeDefined();
    expect(store.take("run-1", "int-3")).toBeDefined();
  });
});
