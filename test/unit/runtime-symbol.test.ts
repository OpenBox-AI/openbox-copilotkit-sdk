import { describe, expect, it } from "vitest";

import {
  OPENBOX_COPILOTKIT_RUNTIME_SYMBOL,
  attachOpenBoxRuntime,
  getOpenBoxRuntime
} from "../../src/copilotkit/runtime-symbol.js";

describe("runtime-symbol", () => {
  it("round-trips an attached controller via attach/get helpers", () => {
    const runtime = {};
    const controller = { shutdown: async () => {} };

    attachOpenBoxRuntime(runtime, controller);

    expect(getOpenBoxRuntime(runtime)).toBe(controller);
  });

  it("returns undefined when no controller has been attached", () => {
    const runtime = {};

    expect(getOpenBoxRuntime(runtime)).toBeUndefined();
  });

  it("uses a private un-registered Symbol that cannot be obtained via Symbol.for", () => {
    expect(typeof OPENBOX_COPILOTKIT_RUNTIME_SYMBOL).toBe("symbol");
    expect(OPENBOX_COPILOTKIT_RUNTIME_SYMBOL).not.toBe(
      Symbol.for("openbox.copilotkit.runtime")
    );
  });

  it("does not leak across distinct runtime objects", () => {
    const runtimeA = {};
    const runtimeB = {};
    const controllerA = { tag: "A" };

    attachOpenBoxRuntime(runtimeA, controllerA);

    expect(getOpenBoxRuntime(runtimeA)).toBe(controllerA);
    expect(getOpenBoxRuntime(runtimeB)).toBeUndefined();
  });
});
