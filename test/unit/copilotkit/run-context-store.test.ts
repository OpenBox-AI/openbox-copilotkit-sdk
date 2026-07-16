import { describe, expect, it } from "vitest";

import { RunContextStore } from "../../../src/copilotkit/internal/run-context-store.js";

function microtask(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe("RunContextStore", () => {
  it("currentRunContext() is undefined outside any scope", () => {
    const store = new RunContextStore();
    expect(store.currentRunContext()).toBeUndefined();
  });

  it("binds workflowId/runId for the callback's entire async lifetime", async () => {
    const store = new RunContextStore();

    const seenInsideAwait = await store.enterRunContext(
      { runId: "run-1", workflowId: "wf-1" },
      async () => {
        await microtask();
        return store.currentRunContext();
      }
    );

    expect(seenInsideAwait).toEqual({ runId: "run-1", workflowId: "wf-1" });
    expect(store.currentRunContext()).toBeUndefined();
  });

  it("isolates two interleaved concurrent runs — each sees only its own context", async () => {
    const store = new RunContextStore();
    const observedA: Array<ReturnType<RunContextStore["currentRunContext"]>> = [];
    const observedB: Array<ReturnType<RunContextStore["currentRunContext"]>> = [];

    const runA = store.enterRunContext(
      { runId: "run-a", workflowId: "wf-a" },
      async () => {
        observedA.push(store.currentRunContext());
        await microtask();
        observedA.push(store.currentRunContext());
        await microtask();
        observedA.push(store.currentRunContext());
      }
    );
    const runB = store.enterRunContext(
      { runId: "run-b", workflowId: "wf-b" },
      async () => {
        observedB.push(store.currentRunContext());
        await microtask();
        observedB.push(store.currentRunContext());
        await microtask();
        observedB.push(store.currentRunContext());
      }
    );

    await Promise.all([runA, runB]);

    expect(observedA).toEqual([
      { runId: "run-a", workflowId: "wf-a" },
      { runId: "run-a", workflowId: "wf-a" },
      { runId: "run-a", workflowId: "wf-a" }
    ]);
    expect(observedB).toEqual([
      { runId: "run-b", workflowId: "wf-b" },
      { runId: "run-b", workflowId: "wf-b" },
      { runId: "run-b", workflowId: "wf-b" }
    ]);
    // Neither run's context leaks once both have settled.
    expect(store.currentRunContext()).toBeUndefined();
  });

  it("nested enterRunContext calls restore the outer context on exit", async () => {
    const store = new RunContextStore();

    await store.enterRunContext({ runId: "outer-run", workflowId: "outer-wf" }, async () => {
      expect(store.currentRunContext()).toEqual({
        runId: "outer-run",
        workflowId: "outer-wf"
      });

      await store.enterRunContext({ runId: "inner-run", workflowId: "inner-wf" }, async () => {
        await microtask();
        expect(store.currentRunContext()).toEqual({
          runId: "inner-run",
          workflowId: "inner-wf"
        });
      });

      await microtask();
      expect(store.currentRunContext()).toEqual({
        runId: "outer-run",
        workflowId: "outer-wf"
      });
    });
  });
});
