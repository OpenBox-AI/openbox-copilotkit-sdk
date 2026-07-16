import { describe, expect, it } from "vitest";

import { RunTerminalStateRegistry } from "../../../../src/copilotkit/internal/run-terminal-state.js";

describe("RunTerminalStateRegistry", () => {
  it("defaults to {outputEmitted:false, interrupted:false} for an unknown run", () => {
    const registry = new RunTerminalStateRegistry();
    expect(registry.get("never-seen")).toEqual({ interrupted: false, outputEmitted: false });
  });

  it("markOutputEmitted flips only outputEmitted", () => {
    const registry = new RunTerminalStateRegistry();
    registry.markOutputEmitted("run-1");
    expect(registry.get("run-1")).toEqual({ interrupted: false, outputEmitted: true });
  });

  it("markInterrupted flips only interrupted", () => {
    const registry = new RunTerminalStateRegistry();
    registry.markInterrupted("run-1");
    expect(registry.get("run-1")).toEqual({ interrupted: true, outputEmitted: false });
  });

  it("markOutputEmitted then markInterrupted on the same run keeps both flags (order-independent)", () => {
    const registry = new RunTerminalStateRegistry();
    registry.markOutputEmitted("run-1");
    registry.markInterrupted("run-1");
    expect(registry.get("run-1")).toEqual({ interrupted: true, outputEmitted: true });
  });

  it("clearRun resets a run back to the default snapshot without affecting other runs", () => {
    const registry = new RunTerminalStateRegistry();
    registry.markOutputEmitted("run-1");
    registry.markInterrupted("run-2");

    registry.clearRun("run-1");

    expect(registry.get("run-1")).toEqual({ interrupted: false, outputEmitted: false });
    expect(registry.get("run-2")).toEqual({ interrupted: true, outputEmitted: false });
  });

  it("clearRun on an unknown run is a safe no-op", () => {
    const registry = new RunTerminalStateRegistry();
    expect(() => registry.clearRun("unknown-run")).not.toThrow();
  });

  it("bounds memory via FIFO eviction once maxEntries is exceeded", () => {
    const registry = new RunTerminalStateRegistry({ maxEntries: 2 });
    registry.markOutputEmitted("run-1");
    registry.markOutputEmitted("run-2");
    registry.markOutputEmitted("run-3");

    // "run-1" was recorded first — it is the one evicted back to defaults.
    expect(registry.get("run-1")).toEqual({ interrupted: false, outputEmitted: false });
    expect(registry.get("run-2")).toEqual({ interrupted: false, outputEmitted: true });
    expect(registry.get("run-3")).toEqual({ interrupted: false, outputEmitted: true });
  });
});
