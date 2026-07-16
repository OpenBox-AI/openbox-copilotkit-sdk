import { describe, expect, it } from "vitest";

import { ServerToolOwnershipRegistry } from "../../../src/copilotkit/internal/server-tool-ownership.js";

describe("ServerToolOwnershipRegistry", () => {
  it("isOwned is false before any claim", () => {
    const registry = new ServerToolOwnershipRegistry();
    expect(registry.isOwned("run-1", "call-1")).toBe(false);
  });

  it("claim marks (runId, toolCallId) as owned", () => {
    const registry = new ServerToolOwnershipRegistry();
    registry.claim("run-1", "call-1");
    expect(registry.isOwned("run-1", "call-1")).toBe(true);
  });

  it("claim is idempotent", () => {
    const registry = new ServerToolOwnershipRegistry();
    registry.claim("run-1", "call-1");
    registry.claim("run-1", "call-1");
    expect(registry.isOwned("run-1", "call-1")).toBe(true);
  });

  it("release clears a single claim", () => {
    const registry = new ServerToolOwnershipRegistry();
    registry.claim("run-1", "call-1");
    registry.release("run-1", "call-1");
    expect(registry.isOwned("run-1", "call-1")).toBe(false);
  });

  it("release on a never-claimed pair is a safe no-op", () => {
    const registry = new ServerToolOwnershipRegistry();
    expect(() => registry.release("run-1", "call-1")).not.toThrow();
    expect(registry.isOwned("run-1", "call-1")).toBe(false);
  });

  it("two runs reusing the same toolCallId do not collide", () => {
    const registry = new ServerToolOwnershipRegistry();

    registry.claim("run-1", "call-shared");
    expect(registry.isOwned("run-1", "call-shared")).toBe(true);
    expect(registry.isOwned("run-2", "call-shared")).toBe(false);

    registry.claim("run-2", "call-shared");
    expect(registry.isOwned("run-1", "call-shared")).toBe(true);
    expect(registry.isOwned("run-2", "call-shared")).toBe(true);

    registry.release("run-1", "call-shared");
    expect(registry.isOwned("run-1", "call-shared")).toBe(false);
    expect(registry.isOwned("run-2", "call-shared")).toBe(true);
  });

  it("releaseRun clears every claim for that run without affecting other runs", () => {
    const registry = new ServerToolOwnershipRegistry();
    registry.claim("run-1", "call-a");
    registry.claim("run-1", "call-b");
    registry.claim("run-2", "call-a");

    registry.releaseRun("run-1");

    expect(registry.isOwned("run-1", "call-a")).toBe(false);
    expect(registry.isOwned("run-1", "call-b")).toBe(false);
    expect(registry.isOwned("run-2", "call-a")).toBe(true);
  });

  it("releaseRun on an unknown run is a safe no-op", () => {
    const registry = new ServerToolOwnershipRegistry();
    expect(() => registry.releaseRun("unknown-run")).not.toThrow();
  });
});
